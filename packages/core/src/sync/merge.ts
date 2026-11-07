import { SyncClient } from './client.js';
import { compareContentVersion, openRecord, sealRecord, type EncryptedRecord } from './records.js';
import type { Card, CloudAccount, Statement } from '../types.js';

/**
 * 端到端加密同步的一次完整往返（领域层实现，无 UI 依赖）。
 *
 * 流程：拉全量 → 按 (updatedAt, rev, deviceId) 逐条 LWW 合并 → 把合并后的
 * 结果推回服务器。数据量是「个人资产」级别（几百到几千条），全量拉取足够快，
 * 也避免了增量游标在首次配对时对不齐的问题。
 *
 * 已知限制（v0.2 处理）：
 * - 删除以「标记 deleted」同步，暂不支持墓碑清理；
 * - 并发修改会整条覆盖，落败版本目前只计数，没有做成可回滚的冲突快照。
 */

export const COLLECTIONS = {
  cards: 'cards',
  statements: 'statements',
  cloudAccounts: 'cloud_accounts',
} as const;

type CollectionName = (typeof COLLECTIONS)[keyof typeof COLLECTIONS];

export interface SyncSnapshot {
  cards: Card[];
  statements: Statement[];
  cloudAccounts: CloudAccount[];
}

export interface SyncOptions extends SyncSnapshot {
  serverUrl: string;
  vaultId: string;
  deviceId: string;
  deviceToken: string;
  key: Uint8Array;
}

export interface SyncResult extends SyncSnapshot {
  stats: { pulled: number; pushed: number; overwritten: number };
  cursor: number;
}

export async function performSync(options: SyncOptions): Promise<SyncResult> {
  const client = new SyncClient({
    baseUrl: options.serverUrl,
    vaultId: options.vaultId,
    deviceId: options.deviceId,
    deviceToken: options.deviceToken,
  });

  // 1. 拉全量
  const remote = new Map<string, EncryptedRecord>();
  let since = 0;
  let cursor = 0;
  for (;;) {
    const page = await client.pull(since);
    for (const record of page.records) remote.set(`${record.collection}:${record.id}`, record);
    cursor = page.cursor;
    if (page.records.length === 0 || page.cursor === since) break;
    since = page.cursor;
  }

  // 2. 本地加密成记录
  const local = new Map<string, EncryptedRecord>();
  const addLocal = (collection: CollectionName, entities: { id: string; updatedAt: string }[]): void => {
    for (const entity of entities) {
      const record = sealRecord(options.key, {
        collection,
        id: entity.id,
        rev: Math.floor(Date.parse(entity.updatedAt) / 1000),
        updatedAt: entity.updatedAt,
        deviceId: options.deviceId,
        data: entity,
      });
      local.set(`${collection}:${entity.id}`, record);
    }
  };
  addLocal(COLLECTIONS.cards, options.cards);
  addLocal(COLLECTIONS.statements, options.statements);
  addLocal(COLLECTIONS.cloudAccounts, options.cloudAccounts);

  // 3. 合并
  const keys = new Set([...remote.keys(), ...local.keys()]);
  const winners: EncryptedRecord[] = [];
  const toPush: EncryptedRecord[] = [];
  let overwritten = 0;

  for (const key of keys) {
    const remoteRecord = remote.get(key) ?? null;
    const localRecord = local.get(key) ?? null;

    if (remoteRecord && localRecord) {
      const comparison = compareContentVersion(localRecord, remoteRecord);
      if (comparison <= 0) {
        // 远端更新或版本相同：保留远端，避免两台设备互相回推
        winners.push(remoteRecord);
        if (localRecord.updatedAt !== remoteRecord.updatedAt) overwritten += 1;
      } else {
        winners.push(localRecord);
        toPush.push(localRecord);
      }
    } else if (remoteRecord) {
      winners.push(remoteRecord);
    } else if (localRecord) {
      winners.push(localRecord);
      toPush.push(localRecord);
    }
  }

  // 4. 推回差异
  let pushed = 0;
  for (let i = 0; i < toPush.length; i += 100) {
    const batch = toPush.slice(i, i + 100);
    const result = await client.push(batch);
    pushed += result.accepted;
  }

  // 5. 解密合并结果
  const snapshot: SyncSnapshot = { cards: [], statements: [], cloudAccounts: [] };
  for (const record of winners) {
    const data = openRecord<Card | Statement | CloudAccount>(options.key, record);
    if (!data) continue;
    if (record.collection === COLLECTIONS.cards) snapshot.cards.push(data as Card);
    else if (record.collection === COLLECTIONS.statements) snapshot.statements.push(data as Statement);
    else if (record.collection === COLLECTIONS.cloudAccounts) snapshot.cloudAccounts.push(data as CloudAccount);
  }

  return {
    ...snapshot,
    stats: { pulled: remote.size, pushed, overwritten },
    cursor,
  };
}
