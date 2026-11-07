import Fastify, { type FastifyError, type FastifyInstance, type FastifyRequest } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import { compareVersions, type EncryptedRecord } from '@steward/core';
import { bearerToken, hashToken, newToken, PAIRING_TOKEN_TTL_MS, safeEqualHex } from './auth.js';
import { openDatabase } from './db.js';

/**
 * 自托管同步服务。
 *
 * 它只是一台「加密邮筒」：存的是密文、集合名、版本号和时间戳。
 * 服务器管理员能看到「你有 3 张卡、2 台云主机」这种结构信息，
 * 但看不到卡号、余额、主机 IP —— 那些都在客户端加密。
 */

export interface AppOptions {
  db: DatabaseSync;
  adminToken: string;
  now?: () => number;
  logger?: boolean;
}

interface VaultRow {
  id: string;
  kdf: string;
  cursor: number;
  created_at: string;
}

interface DeviceRow {
  id: string;
  vault_id: string;
  name: string;
  platform: string;
  token_hash: string;
}

interface RecordRow {
  vault_id: string;
  collection: string;
  id: string;
  rev: number;
  updated_at: string;
  device_id: string;
  deleted: number;
  nonce: string;
  ciphertext: string;
  seq: number;
}

const COLLECTION_PATTERN = /^[a-z][a-z0-9_]{0,31}$/;
const MAX_RECORDS_PER_PUSH = 500;
const MAX_PULL_LIMIT = 1000;
const DEFAULT_PULL_LIMIT = 500;

export function buildApp(options: AppOptions): FastifyInstance {
  const now = options.now ?? Date.now;
  const db = options.db;
  const app = Fastify({ logger: options.logger ?? false, bodyLimit: 4 * 1024 * 1024 });

  app.setErrorHandler((error: FastifyError, _request, reply) => {
    const status = error.statusCode && error.statusCode >= 400 ? error.statusCode : 500;
    if (status >= 500) app.log.error(error);
    reply.status(status).send({
      error: status >= 500 ? 'internal_error' : 'bad_request',
      message: status >= 500 ? '服务端错误' : error.message,
    });
  });

  const requireAdmin = async (request: FastifyRequest): Promise<void> => {
    const token = bearerToken(request.headers.authorization);
    if (!token || !safeEqualHex(hashToken(token), hashToken(options.adminToken))) {
      throw Object.assign(new Error('管理员令牌无效'), { statusCode: 401 });
    }
  };

  const requireDevice = async (request: FastifyRequest, vaultId: string): Promise<DeviceRow> => {
    const token = bearerToken(request.headers.authorization);
    if (!token) throw Object.assign(new Error('缺少设备令牌'), { statusCode: 401 });
    const row = db
      .prepare('SELECT * FROM devices WHERE token_hash = ?')
      .get(hashToken(token)) as DeviceRow | undefined;
    if (!row || row.vault_id !== vaultId) {
      throw Object.assign(new Error('设备令牌无效'), { statusCode: 401 });
    }
    db.prepare('UPDATE devices SET last_seen_at = ? WHERE id = ?').run(new Date(now()).toISOString(), row.id);
    return row;
  };

  app.get('/healthz', async () => ({ ok: true }));

  /* ---------------- 管理员：建库与签发配对码 ---------------- */

  app.post('/v1/vaults', { preHandler: requireAdmin }, async (request, reply) => {
    const body = request.body as { kdf?: { algorithm: string; salt: string; N: number; r: number; p: number } } | null;
    if (!body?.kdf || body.kdf.algorithm !== 'scrypt' || typeof body.kdf.salt !== 'string') {
      return reply.status(400).send({ error: 'bad_request', message: '缺少 KDF 参数' });
    }
    const vaultId = newToken('vault').slice('vault_'.length);
    db.prepare('INSERT INTO vaults (id, kdf, cursor, created_at) VALUES (?, ?, 0, ?)').run(
      vaultId,
      JSON.stringify(body.kdf),
      new Date(now()).toISOString(),
    );
    const pairingToken = issuePairingToken(db, vaultId, now());
    return reply.status(201).send({ vaultId, kdf: body.kdf, ...pairingToken });
  });

  app.post('/v1/vaults/:vaultId/pairing-tokens', { preHandler: requireAdmin }, async (request, reply) => {
    const { vaultId } = request.params as { vaultId: string };
    const vault = db.prepare('SELECT * FROM vaults WHERE id = ?').get(vaultId) as VaultRow | undefined;
    if (!vault) return reply.status(404).send({ error: 'not_found', message: '仓库不存在' });
    return reply.send(issuePairingToken(db, vaultId, now()));
  });

  /* ---------------- 新设备配对 ---------------- */

  app.post('/v1/vaults/:vaultId/devices', async (request, reply) => {
    const { vaultId } = request.params as { vaultId: string };
    const token = bearerToken(request.headers.authorization);
    if (!token) return reply.status(401).send({ error: 'unauthorized', message: '缺少配对令牌' });

    const pairing = db
      .prepare('SELECT * FROM pairing_tokens WHERE token_hash = ?')
      .get(hashToken(token)) as { token_hash: string; vault_id: string; expires_at: number; used_at: number | null } | undefined;

    if (!pairing || pairing.vault_id !== vaultId) {
      return reply.status(401).send({ error: 'unauthorized', message: '配对码无效' });
    }
    if (pairing.used_at !== null) {
      return reply.status(409).send({ error: 'pairing_used', message: '配对码已被使用，请重新生成' });
    }
    if (pairing.expires_at < now()) {
      return reply.status(410).send({ error: 'pairing_expired', message: '配对码已过期' });
    }

    const body = (request.body ?? {}) as { deviceName?: string; platform?: string };
    const deviceId = newToken('dev').slice('dev_'.length);
    const deviceToken = newToken('st');
    const deviceName = (body.deviceName ?? '未命名设备').slice(0, 64);
    const platform = (body.platform ?? 'unknown').slice(0, 32);

    db.exec('BEGIN');
    try {
      db.prepare('INSERT INTO devices (id, vault_id, name, platform, token_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(
        deviceId,
        vaultId,
        deviceName,
        platform,
        hashToken(deviceToken),
        new Date(now()).toISOString(),
      );
      db.prepare('UPDATE pairing_tokens SET used_at = ? WHERE token_hash = ?').run(now(), pairing.token_hash);
      db.prepare('INSERT INTO device_cursors (device_id, cursor) VALUES (?, 0)').run(deviceId);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }

    const vault = db.prepare('SELECT kdf FROM vaults WHERE id = ?').get(vaultId) as { kdf: string } | undefined;
    return reply.status(201).send({
      vaultId,
      deviceId,
      deviceToken,
      kdf: vault ? JSON.parse(vault.kdf) : null,
    });
  });

  /* ---------------- 记录读写 ---------------- */

  app.get('/v1/vaults/:vaultId/records', async (request, reply) => {
    const { vaultId } = request.params as { vaultId: string };
    const device = await requireDevice(request, vaultId);
    const query = request.query as { since?: string; limit?: string };
    const since = Number.parseInt(query.since ?? '0', 10);
    const limit = Math.min(MAX_PULL_LIMIT, Math.max(1, Number.parseInt(query.limit ?? String(DEFAULT_PULL_LIMIT), 10) || DEFAULT_PULL_LIMIT));
    if (!Number.isFinite(since) || since < 0) {
      return reply.status(400).send({ error: 'bad_request', message: 'since 必须是非负整数' });
    }

    const rows = db
      .prepare('SELECT * FROM records WHERE vault_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?')
      .all(vaultId, since, limit) as unknown as RecordRow[];

    const cursor = rows.length > 0 ? rows[rows.length - 1]!.seq : since;
    db.prepare('UPDATE device_cursors SET cursor = MAX(cursor, ?) WHERE device_id = ?').run(cursor, device.id);

    return reply.send({
      records: rows.map(toWireRecord),
      cursor,
      hasMore: rows.length === limit,
    });
  });

  app.post('/v1/vaults/:vaultId/records', async (request, reply) => {
    const { vaultId } = request.params as { vaultId: string };
    const device = await requireDevice(request, vaultId);
    const body = request.body as { deviceId?: string; records?: unknown } | null;
    if (!Array.isArray(body?.records)) {
      return reply.status(400).send({ error: 'bad_request', message: 'records 必须是数组' });
    }
    if (body.records.length > MAX_RECORDS_PER_PUSH) {
      return reply.status(413).send({ error: 'too_many_records', message: `单次最多推送 ${MAX_RECORDS_PER_PUSH} 条` });
    }

    let accepted = 0;
    db.exec('BEGIN');
    try {
      for (const raw of body.records) {
        const record = parseWireRecord(raw);
        if (!record) continue;
        const existing = db
          .prepare('SELECT * FROM records WHERE vault_id = ? AND collection = ? AND id = ?')
          .get(vaultId, record.collection, record.id) as RecordRow | undefined;

        if (existing && compareVersions(toWireRecord(existing), record) >= 0) {
          // 服务器已有的版本更新或相同，保持幂等，不推进 seq
          continue;
        }
        const seqRow = db.prepare('SELECT cursor FROM vaults WHERE id = ?').get(vaultId) as { cursor: number } | undefined;
        if (!seqRow) {
          db.exec('ROLLBACK');
          return reply.status(404).send({ error: 'not_found', message: '仓库不存在' });
        }
        const nextSeq = seqRow.cursor + 1;
        db.prepare('UPDATE vaults SET cursor = ? WHERE id = ?').run(nextSeq, vaultId);
        db.prepare(
          `INSERT INTO records (vault_id, collection, id, rev, updated_at, device_id, deleted, nonce, ciphertext, seq)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (vault_id, collection, id) DO UPDATE SET
             rev = excluded.rev, updated_at = excluded.updated_at, device_id = excluded.device_id,
             deleted = excluded.deleted, nonce = excluded.nonce, ciphertext = excluded.ciphertext, seq = excluded.seq`,
        ).run(
          vaultId,
          record.collection,
          record.id,
          record.rev,
          record.updatedAt,
          record.deviceId,
          record.deleted ? 1 : 0,
          record.sealed.nonce,
          record.sealed.ciphertext,
          nextSeq,
        );
        accepted++;
      }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }

    const vault = db.prepare('SELECT cursor FROM vaults WHERE id = ?').get(vaultId) as { cursor: number } | undefined;
    return reply.send({ accepted, cursor: vault?.cursor ?? 0, deviceId: device.id });
  });

  return app;
}

function issuePairingToken(db: DatabaseSync, vaultId: string, now: number): { pairingToken: string; pairingExpiresAt: string } {
  const token = newToken('pair');
  const expiresAt = now + PAIRING_TOKEN_TTL_MS;
  db.prepare('INSERT INTO pairing_tokens (token_hash, vault_id, expires_at) VALUES (?, ?, ?)').run(
    hashToken(token),
    vaultId,
    expiresAt,
  );
  return { pairingToken: token, pairingExpiresAt: new Date(expiresAt).toISOString() };
}

function toWireRecord(row: RecordRow): EncryptedRecord {
  return {
    collection: row.collection,
    id: row.id,
    rev: row.rev,
    updatedAt: row.updated_at,
    deviceId: row.device_id,
    deleted: row.deleted === 1,
    sealed: { v: 1, nonce: row.nonce, ciphertext: row.ciphertext },
  };
}

/** 严格校验入参：服务器虽然看不到明文，但必须挡住畸形数据把库写坏。 */
function parseWireRecord(raw: unknown): EncryptedRecord | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const sealed = r.sealed as Record<string, unknown> | undefined;
  if (typeof r.collection !== 'string' || !COLLECTION_PATTERN.test(r.collection)) return null;
  if (typeof r.id !== 'string' || r.id.length < 8 || r.id.length > 64) return null;
  if (typeof r.rev !== 'number' || !Number.isInteger(r.rev) || r.rev < 0) return null;
  if (typeof r.updatedAt !== 'string' || Number.isNaN(Date.parse(r.updatedAt))) return null;
  if (typeof r.deviceId !== 'string' || r.deviceId.length < 4 || r.deviceId.length > 64) return null;
  if (!sealed || typeof sealed.nonce !== 'string' || typeof sealed.ciphertext !== 'string') return null;
  if (sealed.nonce.length > 64 || sealed.ciphertext.length > 100_000) return null;
  return {
    collection: r.collection,
    id: r.id,
    rev: r.rev,
    updatedAt: r.updatedAt,
    deviceId: r.deviceId,
    deleted: r.deleted === true,
    sealed: { v: 1, nonce: sealed.nonce, ciphertext: sealed.ciphertext },
  };
}

/** 便利函数：测试和 CLI 用同一个建库入口。 */
export function createAppWithMemoryDb(adminToken: string, now?: () => number): FastifyInstance {
  return buildApp({ db: openDatabase({ path: ':memory:' }), adminToken, ...(now ? { now } : {}) });
}
