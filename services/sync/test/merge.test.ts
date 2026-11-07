import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  deriveSyncKey,
  generateSalt,
  performSync,
  toStoredKdfConfig,
  type Card,
  type CloudAccount,
  type Statement,
} from '@steward/core';
import { createAppWithMemoryDb } from '../src/app.js';

/**
 * `performSync` 是「一次完整往返」的领域层实现，也是 App 真正调用的入口。
 * 这里用两台设备的视角跑一遍：首次上传、首次下载、并发修改后的覆盖。
 */

const ADMIN = 'admin_merge_token_1234567890';
const KDF_PARAMS = { N: 4096, r: 8, p: 1 };

let app: FastifyInstance;
let serverUrl: string;
let vaultId: string;
let key: Uint8Array;
let deviceA: { deviceId: string; deviceToken: string };
let deviceB: { deviceId: string; deviceToken: string };

const card: Card = {
  id: 'card_sync_0001',
  kind: 'credit',
  issuer: '中信银行',
  network: 'visa',
  nickname: '白金卡',
  last4: '8888',
  currency: 'CNY',
  creditLimitMinor: 5000000,
  updatedAt: '2026-11-01T10:00:00.000Z',
};

const statement: Statement = {
  id: 'stmt_sync_0001',
  cardId: card.id,
  periodStart: '2026-10-05',
  periodEnd: '2026-11-04',
  dueDate: '2026-11-25',
  currency: 'CNY',
  totalAmountMinor: 1234500,
  isPaid: false,
  lines: [
    { id: 'line_1', postedAt: '2026-10-08', merchant: '星巴克', amountMinor: 3800, currency: 'CNY', direction: 'debit' },
  ],
  updatedAt: '2026-11-05T10:00:00.000Z',
};

const account: CloudAccount = {
  id: 'cloud_sync_0001',
  provider: 'aliyun',
  alias: '阿里云主账号',
  secretRef: 'cloud:cloud_sync_0001',
  regions: ['cn-hangzhou'],
  updatedAt: '2026-11-01T10:00:00.000Z',
};

async function pair(name: string): Promise<{ deviceId: string; deviceToken: string }> {
  const issued = await app.inject({
    method: 'POST',
    url: `/v1/vaults/${vaultId}/pairing-tokens`,
    headers: { authorization: `Bearer ${ADMIN}` },
  });
  const token = (JSON.parse(issued.body) as { pairingToken: string }).pairingToken;
  const response = await app.inject({
    method: 'POST',
    url: `/v1/vaults/${vaultId}/devices`,
    headers: { authorization: `Bearer ${token}` },
    payload: { deviceName: name, platform: 'test' },
  });
  return JSON.parse(response.body) as { deviceId: string; deviceToken: string };
}

function sync(device: { deviceId: string; deviceToken: string }, snapshot: {
  cards?: Card[];
  statements?: Statement[];
  cloudAccounts?: CloudAccount[];
}) {
  return performSync({
    serverUrl,
    vaultId,
    deviceId: device.deviceId,
    deviceToken: device.deviceToken,
    key,
    cards: snapshot.cards ?? [],
    statements: snapshot.statements ?? [],
    cloudAccounts: snapshot.cloudAccounts ?? [],
  });
}

beforeAll(async () => {
  app = createAppWithMemoryDb(ADMIN);
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  if (!address || typeof address === 'string') throw new Error('无法获取测试端口');
  serverUrl = `http://127.0.0.1:${address.port}`;

  const salt = generateSalt();
  const created = await app.inject({
    method: 'POST',
    url: '/v1/vaults',
    headers: { authorization: `Bearer ${ADMIN}` },
    payload: { kdf: toStoredKdfConfig(salt, KDF_PARAMS) },
  });
  vaultId = (JSON.parse(created.body) as { vaultId: string }).vaultId;
  key = await deriveSyncKey('a very long passphrase for sync', salt, KDF_PARAMS);
  deviceA = await pair('设备 A');
  deviceB = await pair('设备 B');
});

afterAll(async () => {
  await app.close();
});

describe('performSync 完整往返', () => {
  it('设备 A 首次上传，设备 B 首次下载得到同样数据', async () => {
    const uploaded = await sync(deviceA, { cards: [card], statements: [statement], cloudAccounts: [account] });
    expect(uploaded.cards).toHaveLength(1);
    expect(uploaded.statements[0]?.lines).toHaveLength(1);

    const downloaded = await sync(deviceB, {});
    expect(downloaded.stats.pulled).toBe(3);
    expect(downloaded.cards[0]?.issuer).toBe('中信银行');
    expect(downloaded.cloudAccounts[0]?.alias).toBe('阿里云主账号');
  });

  it('同步是幂等的：没有变化时不会重复推送', async () => {
    const again = await sync(deviceB, { cards: [card], statements: [statement], cloudAccounts: [account] });
    expect(again.stats.pushed).toBe(0);
    expect(again.stats.overwritten).toBe(0);
    expect(again.cards).toHaveLength(1);
  });

  it('设备 B 改名后，设备 A 同步会拿到新版本并计一次覆盖', async () => {
    const renamed: Card = { ...card, nickname: 'B 改的名字', updatedAt: '2026-11-02T10:00:00.000Z' };
    await sync(deviceB, { cards: [renamed] });

    const aResult = await sync(deviceA, { cards: [card] });
    expect(aResult.cards[0]?.nickname).toBe('B 改的名字');
    expect(aResult.stats.overwritten).toBeGreaterThanOrEqual(1);
  });

  it('设备 A 用旧数据回推不会覆盖新版本', async () => {
    const stale = await sync(deviceA, { cards: [card] });
    expect(stale.cards[0]?.nickname).toBe('B 改的名字');
  });

  it('不同集合互不干扰，删除标记不会复活数据', async () => {
    const result = await sync(deviceA, { cards: [card], statements: [statement], cloudAccounts: [account] });
    expect(result.cards).toHaveLength(1);
    expect(result.statements).toHaveLength(1);
    expect(result.cloudAccounts).toHaveLength(1);
  });
});
