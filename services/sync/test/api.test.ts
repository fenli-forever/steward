import { beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createAppWithMemoryDb } from '../src/app.js';
import { newToken } from '../src/auth.js';

const ADMIN = 'admin_test_token_1234567890';

let app: FastifyInstance;
let vaultId: string;
let pairingToken: string;
let deviceToken: string;

async function createVault(): Promise<void> {
  const response = await app.inject({
    method: 'POST',
    url: '/v1/vaults',
    headers: { authorization: `Bearer ${ADMIN}` },
    payload: { kdf: { algorithm: 'scrypt', salt: 'c2FsdHNhbHRzYWx0', N: 32768, r: 8, p: 1 } },
  });
  expect(response.statusCode).toBe(201);
  const body = JSON.parse(response.body) as { vaultId: string; pairingToken: string };
  vaultId = body.vaultId;
  pairingToken = body.pairingToken;
}

async function pair(): Promise<void> {
  const response = await app.inject({
    method: 'POST',
    url: `/v1/vaults/${vaultId}/devices`,
    headers: { authorization: `Bearer ${pairingToken}` },
    payload: { deviceName: 'MacBook Pro', platform: 'macos' },
  });
  expect(response.statusCode).toBe(201);
  deviceToken = (JSON.parse(response.body) as { deviceToken: string }).deviceToken;
}

function record(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    collection: 'cards',
    id: 'card_01ABCDEFGHIJKLMNOPQRSTUVWX',
    rev: 1,
    updatedAt: '2026-11-01T10:00:00.000Z',
    deviceId: 'device_a',
    deleted: false,
    sealed: { v: 1, nonce: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', ciphertext: 'BBBB' },
    ...overrides,
  };
}

beforeEach(async () => {
  app = createAppWithMemoryDb(ADMIN);
  await app.ready();
  await createVault();
  await pair();
});

describe('健康检查与鉴权', () => {
  it('healthz 不需要鉴权', async () => {
    const response = await app.inject({ method: 'GET', url: '/healthz' });
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ ok: true });
  });

  it('错误的 Admin 令牌建库失败', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/vaults',
      headers: { authorization: 'Bearer wrong_token_wrong_token' },
      payload: { kdf: { algorithm: 'scrypt', salt: 'x', N: 1, r: 1, p: 1 } },
    });
    expect(response.statusCode).toBe(401);
  });

  it('没有设备令牌不能读记录', async () => {
    const response = await app.inject({ method: 'GET', url: `/v1/vaults/${vaultId}/records` });
    expect(response.statusCode).toBe(401);
  });

  it('设备令牌不能跨仓库使用', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/v1/vaults/another-vault/records',
      headers: { authorization: `Bearer ${deviceToken}` },
    });
    expect(response.statusCode).toBe(401);
  });
});

describe('配对流程', () => {
  it('配对码只能使用一次', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/v1/vaults/${vaultId}/devices`,
      headers: { authorization: `Bearer ${pairingToken}` },
      payload: { deviceName: 'iPhone', platform: 'ios' },
    });
    expect(response.statusCode).toBe(409);
  });

  it('管理员可以再签一个配对码给第二台设备', async () => {
    const issued = await app.inject({
      method: 'POST',
      url: `/v1/vaults/${vaultId}/pairing-tokens`,
      headers: { authorization: `Bearer ${ADMIN}` },
    });
    expect(issued.statusCode).toBe(200);
    const { pairingToken: second } = JSON.parse(issued.body) as { pairingToken: string };

    const paired = await app.inject({
      method: 'POST',
      url: `/v1/vaults/${vaultId}/devices`,
      headers: { authorization: `Bearer ${second}` },
      payload: { deviceName: 'iPad', platform: 'ios' },
    });
    expect(paired.statusCode).toBe(201);
    expect((JSON.parse(paired.body) as { deviceToken: string }).deviceToken).not.toBe(deviceToken);
  });

  it('过期配对码被拒绝', async () => {
    let clock = Date.now();
    const expiringApp = createAppWithMemoryDb(ADMIN, () => clock);
    const created = await expiringApp.inject({
      method: 'POST',
      url: '/v1/vaults',
      headers: { authorization: `Bearer ${ADMIN}` },
      payload: { kdf: { algorithm: 'scrypt', salt: 'c2FsdA==', N: 32768, r: 8, p: 1 } },
    });
    const { vaultId: vid, pairingToken: token } = JSON.parse(created.body) as {
      vaultId: string;
      pairingToken: string;
    };
    clock += 11 * 60 * 1000;
    const response = await expiringApp.inject({
      method: 'POST',
      url: `/v1/vaults/${vid}/devices`,
      headers: { authorization: `Bearer ${token}` },
      payload: { deviceName: 'Late iPhone', platform: 'ios' },
    });
    expect(response.statusCode).toBe(410);
    await expiringApp.close();
  });
});

describe('记录同步', () => {
  it('推送后能按游标拉取', async () => {
    const push = await app.inject({
      method: 'POST',
      url: `/v1/vaults/${vaultId}/records`,
      headers: { authorization: `Bearer ${deviceToken}` },
      payload: { records: [record()] },
    });
    expect(push.statusCode).toBe(200);
    const pushed = JSON.parse(push.body) as { accepted: number; cursor: number };
    expect(pushed.accepted).toBe(1);
    expect(pushed.cursor).toBe(1);

    const pull = await app.inject({
      method: 'GET',
      url: `/v1/vaults/${vaultId}/records?since=0`,
      headers: { authorization: `Bearer ${deviceToken}` },
    });
    const body = JSON.parse(pull.body) as { records: unknown[]; cursor: number };
    expect(body.records).toHaveLength(1);
    expect(body.cursor).toBe(1);

    const incremental = await app.inject({
      method: 'GET',
      url: `/v1/vaults/${vaultId}/records?since=1`,
      headers: { authorization: `Bearer ${deviceToken}` },
    });
    expect((JSON.parse(incremental.body) as { records: unknown[] }).records).toHaveLength(0);
  });

  it('旧版本覆盖不会生效，seq 不推进', async () => {
    await app.inject({
      method: 'POST',
      url: `/v1/vaults/${vaultId}/records`,
      headers: { authorization: `Bearer ${deviceToken}` },
      payload: { records: [record({ updatedAt: '2026-11-02T10:00:00.000Z', rev: 2 })] },
    });
    const stale = await app.inject({
      method: 'POST',
      url: `/v1/vaults/${vaultId}/records`,
      headers: { authorization: `Bearer ${deviceToken}` },
      payload: { records: [record({ updatedAt: '2026-11-01T10:00:00.000Z', rev: 1 })] },
    });
    expect((JSON.parse(stale.body) as { accepted: number }).accepted).toBe(0);

    const pull = await app.inject({
      method: 'GET',
      url: `/v1/vaults/${vaultId}/records?since=0`,
      headers: { authorization: `Bearer ${deviceToken}` },
    });
    const body = JSON.parse(pull.body) as { records: { updatedAt: string }[]; cursor: number };
    expect(body.records).toHaveLength(1);
    expect(body.records[0]?.updatedAt).toBe('2026-11-02T10:00:00.000Z');
    expect(body.cursor).toBe(1);
  });

  it('同一记录多次推送保持幂等', async () => {
    const payload = { records: [record()] };
    const first = await app.inject({
      method: 'POST',
      url: `/v1/vaults/${vaultId}/records`,
      headers: { authorization: `Bearer ${deviceToken}` },
      payload,
    });
    const second = await app.inject({
      method: 'POST',
      url: `/v1/vaults/${vaultId}/records`,
      headers: { authorization: `Bearer ${deviceToken}` },
      payload,
    });
    expect((JSON.parse(first.body) as { accepted: number }).accepted).toBe(1);
    expect((JSON.parse(second.body) as { accepted: number }).accepted).toBe(0);

    const pull = await app.inject({
      method: 'GET',
      url: `/v1/vaults/${vaultId}/records?since=0`,
      headers: { authorization: `Bearer ${deviceToken}` },
    });
    expect((JSON.parse(pull.body) as { records: unknown[] }).records).toHaveLength(1);
  });

  it('拒绝畸形记录', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/v1/vaults/${vaultId}/records`,
      headers: { authorization: `Bearer ${deviceToken}` },
      payload: { records: [{ collection: 'Bad-Name', id: 'x' }] },
    });
    expect(response.statusCode).toBe(200);
    expect((JSON.parse(response.body) as { accepted: number }).accepted).toBe(0);
  });

  it('超量推送返回 413', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/v1/vaults/${vaultId}/records`,
      headers: { authorization: `Bearer ${deviceToken}` },
      payload: { records: Array.from({ length: 501 }, (_, i) => record({ id: `card_${String(i).padStart(26, '0')}` })) },
    });
    expect(response.statusCode).toBe(413);
  });

  it('服务端响应里只有密文，没有明文', async () => {
    const plaintextMarker = '招商银行-尾号1234';
    await app.inject({
      method: 'POST',
      url: `/v1/vaults/${vaultId}/records`,
      headers: { authorization: `Bearer ${deviceToken}` },
      payload: {
        records: [
          record({
            collection: 'cards',
            sealed: { v: 1, nonce: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', ciphertext: Buffer.from('encrypted').toString('base64') },
          }),
        ],
      },
    });
    const pull = await app.inject({
      method: 'GET',
      url: `/v1/vaults/${vaultId}/records`,
      headers: { authorization: `Bearer ${deviceToken}` },
    });
    expect(pull.body).not.toContain(plaintextMarker);
  });

  it('不同仓库的数据互相隔离', async () => {
    const secondVault = await app.inject({
      method: 'POST',
      url: '/v1/vaults',
      headers: { authorization: `Bearer ${ADMIN}` },
      payload: { kdf: { algorithm: 'scrypt', salt: 'b3RoZXI=', N: 32768, r: 8, p: 1 } },
    });
    const otherVaultId = (JSON.parse(secondVault.body) as { vaultId: string }).vaultId;

    const pull = await app.inject({
      method: 'GET',
      url: `/v1/vaults/${otherVaultId}/records`,
      headers: { authorization: `Bearer ${deviceToken}` },
    });
    expect(pull.statusCode).toBe(401);
  });
});

describe('令牌工具', () => {
  it('令牌带前缀且每次不同', () => {
    expect(newToken('st')).toMatch(/^st_[A-Za-z0-9_-]{40,}$/);
    expect(newToken('st')).not.toBe(newToken('st'));
  });
});
