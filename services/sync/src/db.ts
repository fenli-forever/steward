import { DatabaseSync } from 'node:sqlite';

/**
 * 同步服务的存储层。
 *
 * 用 Node 内置的 node:sqlite，而不是 better-sqlite3：自托管场景下
 * 少一个需要编译的原生依赖，用户 `docker run` 就能跑起来。
 * SQL 本身是标准的，将来换 libsql / Postgres 只需替换这一层。
 */

export interface DatabaseOptions {
  path: string;
}

export function openDatabase({ path }: DatabaseOptions): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  migrate(db);
  return db;
}

export function migrate(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS vaults (
      id          TEXT PRIMARY KEY,
      kdf         TEXT NOT NULL,
      cursor      INTEGER NOT NULL DEFAULT 0,
      created_at  TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS pairing_tokens (
      token_hash  TEXT PRIMARY KEY,
      vault_id    TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
      expires_at  INTEGER NOT NULL,
      used_at     INTEGER
    );

    CREATE TABLE IF NOT EXISTS devices (
      id           TEXT PRIMARY KEY,
      vault_id     TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
      name         TEXT NOT NULL,
      platform     TEXT NOT NULL,
      token_hash   TEXT NOT NULL UNIQUE,
      created_at   TEXT NOT NULL,
      last_seen_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_devices_vault ON devices(vault_id);

    CREATE TABLE IF NOT EXISTS records (
      vault_id    TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
      collection  TEXT NOT NULL,
      id          TEXT NOT NULL,
      rev         INTEGER NOT NULL,
      updated_at  TEXT NOT NULL,
      device_id   TEXT NOT NULL,
      deleted     INTEGER NOT NULL DEFAULT 0,
      nonce       TEXT NOT NULL,
      ciphertext  TEXT NOT NULL,
      seq         INTEGER NOT NULL,
      PRIMARY KEY (vault_id, collection, id)
    );
    CREATE INDEX IF NOT EXISTS idx_records_seq ON records(vault_id, seq);

    -- 同步游标按设备记录，避免多设备互相「吃掉」增量
    CREATE TABLE IF NOT EXISTS device_cursors (
      device_id TEXT PRIMARY KEY REFERENCES devices(id) ON DELETE CASCADE,
      cursor    INTEGER NOT NULL DEFAULT 0
    );
  `);
}
