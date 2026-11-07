#!/usr/bin/env node
/**
 * 一处改版本，四处同步。
 *
 * 这个仓库的版本号散落在 4 个地方（npm 包、Tauri 配置、Cargo 包、Cargo.lock），
 * 手改必漏，漏了就会出现「App 显示 0.1.0、安装包叫 0.2.0、更新检查永远说已最新」。
 *
 * 用法：
 *   pnpm version:bump 0.2.0
 *   git commit -am "chore: release v0.2.0"
 *   git tag v0.2.0 && git push origin v0.2.0
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const version = process.argv[2];
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

if (!version || !SEMVER.test(version)) {
  console.error('用法: node scripts/bump-version.mjs <x.y.z>');
  process.exit(1);
}

const changed = [];

function editJson(path) {
  const data = JSON.parse(readFileSync(path, 'utf8'));
  if (data.version === version) return;
  data.version = version;
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`);
  changed.push(path);
}

function editCargoToml(path) {
  const source = readFileSync(path, 'utf8');
  // 只改 [package] 段里的 version，避免误伤依赖的版本约束
  const next = source.replace(/(\[package\][\s\S]*?\nversion = ")([^"]+)(")/, `$1${version}$3`);
  if (next === source) return;
  writeFileSync(path, next);
  changed.push(path);
}

function editCargoLock(path) {
  if (!existsSync(path)) return;
  const source = readFileSync(path, 'utf8');
  const next = source.replace(/(name = "steward"\nversion = ")([^"]+)(")/, `$1${version}$3`);
  if (next === source) return;
  writeFileSync(path, next);
  changed.push(path);
}

editJson('package.json');
editJson('apps/app/package.json');
editJson('apps/app/src-tauri/tauri.conf.json');
editCargoToml('apps/app/src-tauri/Cargo.toml');
editCargoLock('apps/app/src-tauri/Cargo.lock');

if (changed.length === 0) {
  console.log(`所有文件的版本都已经是 ${version}，无需修改。`);
} else {
  console.log(`已更新到 ${version}：`);
  for (const file of changed) console.log(`  · ${file}`);
  console.log(`\n下一步：\n  git add -A && git commit -m "chore: release v${version}"\n  git tag v${version} && git push origin v${version}`);
}
