import type { SealedData } from '../crypto/vault.js';
import { recordAad, sealJson, openJson } from '../crypto/vault.js';
import type { ISODateTime } from '../types.js';

/**
 * 同步单元：一条记录 = 一个实体的完整快照（而不是字段级 diff）。
 *
 * 为什么用整条快照：个人资产场景的记录量级很小（几百到几千条），
 * 整条覆盖的合并语义最简单，出问题时也最容易人工修复。
 * 代价是并发编辑会整条覆盖，所以下面用 (updatedAt, rev, deviceId)
 * 做确定性的 LWW，并且把败者保留在冲突日志里，而不是静默丢弃。
 */

export interface EncryptedRecord {
  collection: string;
  id: string;
  /** 设备本地的单调修订号，用于幂等与排序，不是全局时钟。 */
  rev: number;
  updatedAt: ISODateTime;
  deviceId: string;
  deleted: boolean;
  sealed: SealedData;
}

export interface SyncBatch {
  cursor: number;
  records: EncryptedRecord[];
}

export interface Conflict<T> {
  collection: string;
  id: string;
  localWinner: T | null;
  remoteLoser: T | null;
  reason: 'remote-newer' | 'local-newer' | 'tie-local';
}

/** 版本比较：先看时间，再看 rev，最后用 deviceId 打破平局（保证各端结果一致）。 */
export function compareVersions(a: EncryptedRecord, b: EncryptedRecord): number {
  const at = Date.parse(a.updatedAt);
  const bt = Date.parse(b.updatedAt);
  if (at !== bt) return at < bt ? -1 : 1;
  if (a.rev !== b.rev) return a.rev < b.rev ? -1 : 1;
  if (a.deviceId === b.deviceId) return 0;
  return a.deviceId < b.deviceId ? -1 : 1;
}

export function isNewer(a: EncryptedRecord, b: EncryptedRecord): boolean {
  return compareVersions(a, b) > 0;
}

/**
 * 合并本地与远端记录。返回值里的 `conflict` 非空表示两边都改过，
 * 调用方应当把落败版本写入本地冲突日志供用户查看/恢复。
 */
export function mergeRecords(
  local: EncryptedRecord | null,
  remote: EncryptedRecord,
): { winner: EncryptedRecord; conflict: boolean; loser: EncryptedRecord | null } {
  if (!local) return { winner: remote, conflict: false, loser: null };
  const cmp = compareVersions(remote, local);
  if (cmp > 0) return { winner: remote, conflict: true, loser: local };
  if (cmp < 0) return { winner: local, conflict: true, loser: remote };
  return { winner: local, conflict: false, loser: null };
}

/** 加密一条记录。AAD 绑定 collection + id，防止密文被调包。 */
export function sealRecord<T>(
  key: Uint8Array,
  input: {
    collection: string;
    id: string;
    rev: number;
    updatedAt: ISODateTime;
    deviceId: string;
    deleted?: boolean;
    data: T;
  },
): EncryptedRecord {
  return {
    collection: input.collection,
    id: input.id,
    rev: input.rev,
    updatedAt: input.updatedAt,
    deviceId: input.deviceId,
    deleted: input.deleted ?? false,
    sealed: sealJson(key, input.data, recordAad(input.collection, input.id)),
  };
}

export function openRecord<T>(key: Uint8Array, record: EncryptedRecord): T | null {
  if (record.deleted) return null;
  return openJson<T>(key, record.sealed, recordAad(record.collection, record.id));
}

/** 本地仓储与同步层之间的最简接口，便于替换成 SQLite/IndexedDB 实现。 */
export interface RecordStore {
  get(collection: string, id: string): Promise<EncryptedRecord | null>;
  list(collection: string): Promise<EncryptedRecord[]>;
  put(record: EncryptedRecord): Promise<void>;
}

/** 内存实现，用于测试与 Web 预览模式。 */
export class MemoryRecordStore implements RecordStore {
  private readonly rows = new Map<string, EncryptedRecord>();

  private keyOf(collection: string, id: string): string {
    return `${collection}\u0000${id}`;
  }

  async get(collection: string, id: string): Promise<EncryptedRecord | null> {
    return this.rows.get(this.keyOf(collection, id)) ?? null;
  }

  async list(collection: string): Promise<EncryptedRecord[]> {
    return [...this.rows.values()].filter((r) => r.collection === collection);
  }

  async put(record: EncryptedRecord): Promise<void> {
    this.rows.set(this.keyOf(record.collection, record.id), record);
  }

  /** 仅测试用：导出全部记录。 */
  all(): EncryptedRecord[] {
    return [...this.rows.values()];
  }
}
