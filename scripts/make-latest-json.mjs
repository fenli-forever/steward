#!/usr/bin/env node
/**
 * 把各平台的更新产物汇总成 Tauri updater 需要的 latest.json。
 *
 * 输入：一个目录（CI 里是所有下载下来的 artifact 合并后的目录），里面躺着
 *   Steward_0.1.0_aarch64.app.tar.gz        + .sig
 *   Steward_0.1.0_universal.app.tar.gz      + .sig
 *   Steward_0.1.0_x64-setup.nsis.zip        + .sig
 *   Steward_0.1.0_amd64.AppImage.tar.gz     + .sig
 *
 * 输出：
 *   { version, notes, pub_date, platforms: { "darwin-aarch64": { signature, url }, ... } }
 *
 * 没有 .sig 的文件会被忽略——宁可少一个平台，也不生成一个装了会失败的更新。
 */

import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

function parseArgs(argv) {
  const args = { dir: 'artifacts', out: 'latest.json', notes: '' };
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]?.replace(/^--/, '');
    const value = argv[i + 1];
    if (!key) continue;
    if (key === 'version' || key === 'repo' || key === 'tag' || key === 'notes' || key === 'dir' || key === 'out') {
      args[key] = value;
    }
  }
  return args;
}

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

/** 按文件名推断这是哪个平台的更新包 */
export function platformKeysFor(fileName) {
  const name = fileName.toLowerCase();
  if (name.endsWith('.app.tar.gz')) {
    if (name.includes('universal')) return ['darwin-aarch64', 'darwin-x86_64'];
    if (name.includes('aarch64') || name.includes('arm64')) return ['darwin-aarch64'];
    if (name.includes('x64') || name.includes('x86_64') || name.includes('intel')) return ['darwin-x86_64'];
    return [];
  }
  if (name.endsWith('.nsis.zip')) return ['windows-x86_64'];
  if (name.endsWith('-setup.exe')) return ['windows-x86_64'];
  if (name.endsWith('.appimage.tar.gz')) return ['linux-x86_64'];
  return [];
}

export function buildLatestJson({ files, version, repo, tag, notes = '' }) {
  const platforms = {};
  const sorted = [...files].sort();

  for (const file of sorted) {
    const sigPath = `${file}.sig`;
    const hasSig = sorted.includes(sigPath);
    if (!hasSig) continue;

    const keys = platformKeysFor(basename(file));
    if (keys.length === 0) continue;

    const signature = readFileSync(sigPath, 'utf8').trim();
    if (!signature) continue;

    const url = `https://github.com/${repo}/releases/download/${tag}/${encodeURIComponent(basename(file))}`;
    for (const key of keys) {
      // 同一个平台出现多个候选时，优先保留第一个（例如 nsis.zip 优于 setup.exe）
      if (!platforms[key]) platforms[key] = { signature, url };
    }
  }

  return {
    version,
    notes,
    pub_date: new Date().toISOString(),
    platforms,
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.repo || !args.tag) {
    console.error('用法: node scripts/make-latest-json.mjs --dir artifacts --repo owner/repo --tag v0.1.0 [--version 0.1.0] [--notes ""]');
    process.exit(1);
  }

  const version = args.version ?? JSON.parse(readFileSync('apps/app/src-tauri/tauri.conf.json', 'utf8')).version;
  const files = walk(resolve(args.dir));
  const latest = buildLatestJson({ files, version, repo: args.repo, tag: args.tag, notes: args.notes });

  const platforms = Object.keys(latest.platforms);
  if (platforms.length === 0) {
    console.error('没有找到任何带 .sig 的更新产物，latest.json 不会生成。');
    console.error('常见原因：构建时没有配置 TAURI_SIGNING_PRIVATE_KEY。');
    process.exit(1);
  }

  writeFileSync(args.out, `${JSON.stringify(latest, null, 2)}\n`);
  console.log(`已写入 ${args.out}，包含平台：${platforms.join(', ')}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
