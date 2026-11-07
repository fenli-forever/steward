import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  SyncClient,
  compareVersions,
  deriveSyncKey,
  generateSalt,
  openRecord,
  sealRecord,
  toStoredKdfConfig,
  type Card,
  type EncryptedRecord,
} from '@steward/core';
import { createAppWithMemoryDb } from '../src/app.js';

/**
 * 端到端协议测试：两台设备通过自建服务器同步，验证
 * 「服务器只存密文」以及「LWW 合并结果在两台设备上一致」。
 */

const ADMIN = 'admin_e2e_token_1234567890';
const KDF_PARAMS = { N: 4096, r: 8, p: 1 };

let app: FastifyInstance;
let baseUrl: string;
let vaultId: string;
let key: Uint8Array;
let deviceA: { deviceId: string; deviceToken: string };
let deviceB: { deviceId: string; deviceToken: string };

async function issuePairingToken(): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: `/v1/vaults/${vaultId}/pairing-tokens`,
    headers: { authorization: `Bearer ${ADMIN}` },
  });
  return (JSON.parse(response.body) as { pairingToken: string }).pairingToken;
}

async function pair(name: string): Promise<{ deviceId: string; deviceToken: string }> {
  const token = await issuePairingToken();
  const response = await app.inject({
    method: 'POST',
    url: `/v1/vaults/${vaultId}/devices`,
    headers: { authorization: `Bearer ${token}` },
    payload: { deviceName: name, platform: 'test' },
  });
  const body = JSON.parse(response.body) as { deviceId: string; deviceToken: string };
  return { deviceId: body.deviceId, deviceToken: body.deviceToken };
}

function client(device: { deviceId: string; deviceToken: string }): SyncClient {
  return new SyncClient({ baseUrl, vaultId, deviceId: device.deviceId, deviceToken: device.deviceToken });
}

function cardRecord(deviceId: string, card: Card): EncryptedRecord {
  return sealRecord(key, {
    collection: 'cards',
    id: card.id,
    rev: Math.floor(Date.parse(card.updatedAt) / 1000),
    updatedAt: card.updatedAt,
    deviceId,
    data: card,
  });
}

const baseCard: Card = {
  id: 'card_e2e_0001',
  kind: 'credit',
  issuer: '招商银行',
  network: 'unionpay',
  nickname: '测试卡',
  last4: '1234',
  currency: 'CNY',
  creditLimitMinor: 1000000,
  updatedAt: '2026-11-01T10:00:00.000Z',
};

beforeAll(async () => {
  app = createAppWithMemoryDb(ADMIN);
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  if (!address || typeof address === 'string') throw new Error('无法获取测试端口');
  baseUrl = `http://127.0.0.1:${address.port}`;

  const salt = generateSalt();
  const kdf = toStoredKdfConfig(salt, KDF_PARAMS);
  const created = await app.inject({
    method: 'POST',
    url: '/v1/vaults',
    headers: { authorization: `Bearer ${ADMIN}` },
    payload: { kdf },
  });
  vaultId = (JSON.parse(created.body) as { vaultId: string }).vaultId;

  key = await deriveSyncKey('correct horse battery staple', salt, KDF_PARAMS);
  deviceA = await pair('MacBook');
  deviceB = await pair('iPhone');
});

afterAll(async () => {
  await app.close();
});

describe('两台设备经服务器同步', () => {
  it('设备 A 写入后，设备 B 能解密出同样的内容', async () => {
    const push = await client(deviceA).push([cardRecord(deviceA.deviceId, baseCard)]);
    expect(push.accepted).toBe(1);

    const pull = await client(deviceB).pull(0);
    expect(pull.records).toHaveLength(1);
    const decrypted = openRecord<Card>(key, pull.records[0]!);
    expect(decrypted?.issuer).toBe('招商银行');
    expect(decrypted?.creditLimitMinor).toBe(1000000);
  });

  it('服务器响应里没有明文', async () => {
    const pull = await client(deviceB).pull(0);
    const wire = JSON.stringify(pull);
    expect(wire).not.toContain('招商银行');
    expect(wire).not.toContain('1234');
  });

  it('并发修改按 LWW 收敛，两端最终一致', async () => {
    const newer: Card = { ...baseCard, nickname: 'B 改的名字', updatedAt: '2026-11-02T10:00:00.000Z' };
    await client(deviceB).push([cardRecord(deviceB.deviceId, newer)]);

    const aPull = await client(deviceA).pull(0);
    const bPull = await client(deviceB).pull(0);
    const aRecord = aPull.records[0]!;
    const bRecord = bPull.records[0]!;
    expect(compareVersions(aRecord, bRecord)).toBe(0);

    const aCard = openRecord<Card>(key, aRecord);
    const bCard = openRecord<Card>(key, bRecord);
    expect(aCard?.nickname).toBe('B 改的名字');
    expect(bCard?.nickname).toBe('B 改的名字');
  });

  it('旧版本回推不会覆盖新版本', async () => {
    const stale = cardRecord(deviceA.deviceId, baseCard); // updatedAt 更早
    const result = await client(deviceA).push([stale]);
    expect(result.accepted).toBe(0);

    const pull = await client(deviceB).pull(0);
    expect(openRecord<Card>(key, pull.records[0]!)?.nickname).toBe('B 改的名字');
  });

  it('增量游标只返回新记录', async () => {
    const first = await client(deviceB).pull(0);
    const secondCard: Card = { ...baseCard, id: 'card_e2e_0002', last4: '5678', updatedAt: '2026-11-03T10:00:00.000Z' };
    await client(deviceA).push([cardRecord(deviceA.deviceId, secondCard)]);

    const incremental = await client(deviceB).pull(first.cursor);
    expect(incremental.records).toHaveLength(1);
    expect(incremental.records[0]?.id).toBe('card_e2e_0002');
  });

  it('用错误口令派生出的密钥解不开', async () => {
    const wrongKey = await deriveSyncKey('wrong password 123456', generateSalt(), KDF_PARAMS);
    const pull = await client(deviceB).pull(0);
    expect(() => openRecord<Card>(wrongKey, pull.records[0]!)).toThrow();
  });
});
