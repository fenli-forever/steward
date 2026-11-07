import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { buildApp } from './app.js';
import { openDatabase } from './db.js';
import { hashToken, newToken } from './auth.js';

/**
 * 启动入口。
 *
 *   STEWARD_ADMIN_TOKEN=...  node dist/main.js
 *   node dist/main.js init     # 建一个仓库并打印配对码
 *
 * 默认数据目录是 ./data，单文件 SQLite，备份 = 复制一个文件。
 */

const DEFAULT_PORT = 8787;
const DEFAULT_DB = './data/steward.db';

function resolveAdminToken(dataDir: string): string {
  const fromEnv = process.env.STEWARD_ADMIN_TOKEN;
  if (fromEnv && fromEnv.length >= 16) return fromEnv;

  const tokenPath = resolve(dataDir, 'admin.token');
  try {
    const existing = readFileSync(tokenPath, 'utf8').trim();
    if (existing.length >= 16) return existing;
  } catch {
    // 首次启动，继续生成
  }
  const token = newToken('admin');
  mkdirSync(dirname(tokenPath), { recursive: true });
  writeFileSync(tokenPath, `${token}\n`, { mode: 0o600 });
  console.warn(`[steward-sync] 已生成管理员令牌，写入 ${tokenPath}`);
  return token;
}

async function serve(): Promise<void> {
  const dataDir = resolve(process.env.STEWARD_DATA_DIR ?? './data');
  mkdirSync(dataDir, { recursive: true });
  const dbPath = process.env.STEWARD_DB_PATH ?? resolve(dataDir, 'steward.db');
  const adminToken = resolveAdminToken(dataDir);
  const port = Number.parseInt(process.env.PORT ?? String(DEFAULT_PORT), 10);
  const host = process.env.HOST ?? '127.0.0.1';

  const app = buildApp({ db: openDatabase({ path: dbPath }), adminToken, logger: true });
  const address = await app.listen({ port, host });
  app.log.info(`Steward 同步服务已启动：${address}（数据库 ${dbPath}）`);

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info(`收到 ${signal}，正在关闭…`);
    await app.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

async function initVault(): Promise<void> {
  const dataDir = resolve(process.env.STEWARD_DATA_DIR ?? './data');
  mkdirSync(dataDir, { recursive: true });
  const dbPath = process.env.STEWARD_DB_PATH ?? resolve(dataDir, 'steward.db');
  // 与 serve 共用同一套令牌解析：首次运行会生成并落盘
  const adminToken = resolveAdminToken(dataDir);
  const app = buildApp({ db: openDatabase({ path: dbPath }), adminToken });

  const salt = randomBytes(16).toString('base64');
  const response = await app.inject({
    method: 'POST',
    url: '/v1/vaults',
    headers: { authorization: `Bearer ${adminToken}` },
    payload: { kdf: { algorithm: 'scrypt', salt, N: 32768, r: 8, p: 1 } },
  });
  await app.close();

  if (response.statusCode !== 201) {
    console.error(`建库失败 (${response.statusCode}): ${response.body}`);
    process.exitCode = 1;
    return;
  }
  const body = JSON.parse(response.body) as { vaultId: string; pairingToken: string; pairingExpiresAt: string };

  console.log('\n仓库已创建：');
  console.log(`  Vault ID     ${body.vaultId}`);
  console.log(`  配对码       ${body.pairingToken}`);
  console.log(`  有效期至     ${body.pairingExpiresAt}`);
  console.log('\n把 Vault ID 和配对码填进 App 的「设置 → 同步」即可绑定第一台设备。');
  console.log('注意：配对码只能使用一次，10 分钟内有效。');
  // 防止误把管理员令牌当成配对码使用
  if (hashToken(adminToken) === hashToken(body.pairingToken)) {
    console.error('内部错误：配对码不应等于管理员令牌');
    process.exitCode = 1;
  }
}

const command = process.argv[2];
if (command === 'init') {
  await initVault();
} else {
  await serve();
}
