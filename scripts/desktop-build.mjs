#!/usr/bin/env node
/**
 * 桌面端打包的统一入口（CI 与本地共用）。
 *
 * 为什么需要它：自动更新要求「端点 + 公钥」在**编译期**写进二进制，
 * 而这些值只有 CI 知道（仓库地址、公钥变量）。Tauri CLI 支持 `--config`
 * 做配置合并，这里负责把环境变量翻译成那段 JSON。
 *
 * 用法：
 *   node scripts/desktop-build.mjs                      # 本机打包，不带更新
 *   node scripts/desktop-build.mjs --target universal-apple-darwin
 *   GITHUB_REPOSITORY=me/steward TAURI_UPDATER_PUBKEY=... \
 *     TAURI_SIGNING_PRIVATE_KEY=... node scripts/desktop-build.mjs
 */

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const extraArgs = process.argv.slice(2);

const repo = process.env.GITHUB_REPOSITORY;
const pubkey = process.env.TAURI_UPDATER_PUBKEY;
const hasSigningKey = Boolean(process.env.TAURI_SIGNING_PRIVATE_KEY);
if (!hasSigningKey) {
  // CI 里未配置 secret 时变量是空字符串，务必清掉，避免 Tauri 拿到空私钥报错
  delete process.env.TAURI_SIGNING_PRIVATE_KEY;
  delete process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD;
}

const config = {};

if (repo && pubkey) {
  config.plugins = {
    updater: {
      // GitHub 的 latest 重定向：只认「已发布」的 Release，草稿不算
      endpoints: [`https://github.com/${repo}/releases/latest/download/latest.json`],
      pubkey,
    },
  };
} else {
  console.warn('[build] 缺少 GITHUB_REPOSITORY 或 TAURI_UPDATER_PUBKEY，本次构建不启用自动更新。');
}

if (hasSigningKey) {
  if (config.plugins) {
    // 只有配置了公钥时才值得生成签名产物，否则 latest.json 也校验不过
    config.bundle = { createUpdaterArtifacts: true };
  } else {
    console.warn('[build] 检测到签名私钥，但缺少更新端点/公钥配置，跳过 updater 产物。');
  }
}

const cliArgs = ['tauri', 'build'];
if (Object.keys(config).length > 0) {
  cliArgs.push('--config', JSON.stringify(config));
}
cliArgs.push(...extraArgs);

if (Object.keys(config).length > 0) {
  console.log(`[build] 更新配置：${JSON.stringify({ ...config, bundle: config.bundle ?? undefined })}`);
}

const result = spawnSync('pnpm', cliArgs, {
  cwd: fileURLToPath(new URL('../apps/app', import.meta.url)),
  stdio: 'inherit',
  shell: process.platform === 'win32',
});

process.exit(result.status ?? 1);
