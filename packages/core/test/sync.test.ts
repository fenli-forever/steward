import { describe, expect, it } from 'vitest';
import {
  MemoryRecordStore,
  compareContentVersion,
  compareVersions,
  mergeRecords,
  sealRecord,
  openRecord,
  type EncryptedRecord,
} from '../src/sync/records.js';
import { deriveSyncKey, generateSalt, estimatePassphraseStrength } from '../src/crypto/keys.js';
import { open, openJson, recordAad, seal, sealJson } from '../src/crypto/vault.js';
import { randomBytes, utf8ToBytes } from '../src/crypto/encoding.js';

const KEY = new Uint8Array(32).fill(7);

function record(overrides: Partial<EncryptedRecord> = {}): EncryptedRecord {
  return {
    collection: 'cards',
    id: 'card_1',
    rev: 1,
    updatedAt: '2026-11-01T10:00:00.000Z',
    deviceId: 'device_a',
    deleted: false,
    sealed: { v: 1, nonce: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', ciphertext: 'AAAA' },
    ...overrides,
  };
}

describe('本地加密', () => {
  it('加解密往返', () => {
    const sealed = seal(KEY, utf8ToBytes('招商银行 · 尾号 1234'));
    const plain = open(KEY, sealed);
    expect(new TextDecoder().decode(plain)).toBe('招商银行 · 尾号 1234');
  });

  it('每次加密的 nonce 都不同', () => {
    const a = sealJson(KEY, { hello: 'world' });
    const b = sealJson(KEY, { hello: 'world' });
    expect(a.nonce).not.toBe(b.nonce);
    expect(a.ciphertext).not.toBe(b.ciphertext);
  });

  it('错误密钥或篡改的密文会认证失败', () => {
    const sealed = sealJson(KEY, { secret: 'cvv' });
    const wrongKey = new Uint8Array(32).fill(8);
    expect(() => openJson(wrongKey, sealed)).toThrow();

    const tampered = { ...sealed, ciphertext: 'A' + sealed.ciphertext.slice(1) };
    expect(() => openJson(KEY, tampered)).toThrow();
  });

  it('AAD 不匹配时拒绝解密（防止密文被挪到别的记录）', () => {
    const sealed = sealJson(KEY, { merchant: '星巴克' }, recordAad('cards', 'card_1'));
    expect(() => openJson(KEY, sealed, recordAad('cards', 'card_2'))).toThrow();
    expect(openJson(KEY, sealed, recordAad('cards', 'card_1'))).toEqual({ merchant: '星巴克' });
  });
});

describe('同步记录', () => {
  it('加密后服务器看不到明文', () => {
    const enc = sealRecord(KEY, {
      collection: 'cards',
      id: 'card_1',
      rev: 1,
      updatedAt: '2026-11-01T10:00:00.000Z',
      deviceId: 'device_a',
      data: { issuer: '招商银行', last4: '1234' },
    });
    expect(JSON.stringify(enc)).not.toContain('招商银行');
    expect(openRecord(KEY, enc)).toEqual({ issuer: '招商银行', last4: '1234' });
  });

  it('删除标记不返回数据', () => {
    const enc = sealRecord(KEY, {
      collection: 'cards',
      id: 'card_1',
      rev: 2,
      updatedAt: '2026-11-01T10:00:00.000Z',
      deviceId: 'device_a',
      deleted: true,
      data: {},
    });
    expect(openRecord(KEY, enc)).toBeNull();
  });

  it('版本比较是确定性的，且各端结果一致', () => {
    const older = record({ updatedAt: '2026-11-01T10:00:00.000Z' });
    const newer = record({ updatedAt: '2026-11-01T10:00:01.000Z' });
    expect(compareVersions(older, newer)).toBeLessThan(0);
    expect(compareVersions(newer, older)).toBeGreaterThan(0);

    const a = record({ deviceId: 'device_a' });
    const b = record({ deviceId: 'device_b' });
    expect(compareVersions(a, b)).toBeLessThan(0);
    expect(compareVersions(b, a)).toBeGreaterThan(0);
  });

  it('内容版本比较忽略设备差异（防止两台设备无限互推）', () => {
    const a = record({ deviceId: 'device_a' });
    const b = record({ deviceId: 'device_b' });
    expect(compareContentVersion(a, b)).toBe(0);
    expect(compareVersions(a, b)).not.toBe(0);
    expect(compareContentVersion(record({ updatedAt: '2026-11-02T00:00:00.000Z' }), a)).toBeGreaterThan(0);
    expect(compareContentVersion(record({ rev: 5 }), a)).toBeGreaterThan(0);
  });

  it('合并时以较新版本为准，并标记冲突', () => {
    const local = record({ updatedAt: '2026-11-01T10:00:00.000Z', deviceId: 'device_a' });
    const remote = record({ updatedAt: '2026-11-01T11:00:00.000Z', deviceId: 'device_b' });
    const { winner, conflict, loser } = mergeRecords(local, remote);
    expect(winner).toBe(remote);
    expect(conflict).toBe(true);
    expect(loser).toBe(local);
  });

  it('本地更新时保留本地版本', () => {
    const local = record({ updatedAt: '2026-11-02T10:00:00.000Z' });
    const remote = record({ updatedAt: '2026-11-01T10:00:00.000Z' });
    expect(mergeRecords(local, remote).winner).toBe(local);
  });

  it('首次收到远端记录不算冲突', () => {
    expect(mergeRecords(null, record()).conflict).toBe(false);
  });

  it('内存仓储按集合隔离', async () => {
    const store = new MemoryRecordStore();
    await store.put(record({ id: 'a', collection: 'cards' }));
    await store.put(record({ id: 'b', collection: 'hosts' }));
    expect(await store.list('cards')).toHaveLength(1);
    expect((await store.get('hosts', 'b'))?.id).toBe('b');
    expect(await store.get('cards', 'b')).toBeNull();
  });
});

describe('同步密钥派生', () => {
  it('同一口令 + 同一 salt 派生出同一把钥匙', async () => {
    const salt = generateSalt();
    const k1 = await deriveSyncKey('correct horse battery staple', salt, { N: 2 ** 12, r: 8, p: 1 });
    const k2 = await deriveSyncKey('correct horse battery staple', salt, { N: 2 ** 12, r: 8, p: 1 });
    expect(Array.from(k1)).toEqual(Array.from(k2));
    expect(k1).toHaveLength(32);
  });

  it('不同 salt 得到不同密钥', async () => {
    const k1 = await deriveSyncKey('correct horse battery staple', generateSalt(), { N: 2 ** 12, r: 8, p: 1 });
    const k2 = await deriveSyncKey('correct horse battery staple', generateSalt(), { N: 2 ** 12, r: 8, p: 1 });
    expect(Array.from(k1)).not.toEqual(Array.from(k2));
  });

  it('拒绝过短口令', async () => {
    await expect(deriveSyncKey('1234', randomBytes(16))).rejects.toThrow(/至少需要/);
  });

  it('口令强度评分', () => {
    expect(estimatePassphraseStrength('1234567')).toBe(0);
    expect(estimatePassphraseStrength('abcdefgh')).toBe(1);
    expect(estimatePassphraseStrength('Abcdefgh1234!')).toBeGreaterThanOrEqual(3);
  });
});
