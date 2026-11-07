# 06 · 自动更新（GitHub Releases）

## 一句话

打一个 tag → CI 构建并签名 → 发布 Release → 桌面端启动时自动发现新版本，用户点一下就能升级。

```
       git tag v0.2.0 && git push
                  │
                  ▼
   GitHub Actions：打包 + Ed25519 签名
                  │
                  ▼
   Release 资产：Steward.app.tar.gz / .nsis.zip / .AppImage.tar.gz / *.sig / latest.json
                  │
                  ▼
   客户端启动 3 秒后：GET /releases/latest/download/latest.json
                  │  版本更高？
                  ▼
        下载 → 用内置公钥验签 → 安装 → 重启
```

移动端不参与：iOS / Android 的更新必须走 App Store / Play，客户端自更新会被拒审。

## 1. 一次性配置（3 分钟）

### 1.1 生成签名密钥对

```bash
pnpm tauri signer generate -w ~/.tauri/steward.key
```

会输出：

```
Your keypair was generated successfully
Private: ~/.tauri/steward.key（还会打印一串 Private key，二选一保存）
Public:  <一串 base64>
```

- **公钥**：可以公开，写进仓库变量 `TAURI_UPDATER_PUBKEY`。
- **私钥**：绝不能进仓库。写进仓库 Secret `TAURI_SIGNING_PRIVATE_KEY`（内容就是 `.key` 文件的文本，或生成时打印的那串）。
  如果生成时设了密码，再存一个 `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`。

> 这个私钥决定了「谁能给你的用户推更新」。泄漏 = 别人可以给你所有用户推任意程序。
> 建议放在 1Password / Vault 里，只以 Secret 形式注入 CI。

### 1.2 在 GitHub 上配置

| 类型 | 名称 | 值 |
| --- | --- | --- |
| Variable | `TAURI_UPDATER_PUBKEY` | 上一步的公钥 |
| Secret | `TAURI_SIGNING_PRIVATE_KEY` | 私钥文本 |
| Secret | `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | 私钥密码（没设可留空） |
| Variable（可选） | `PUBLISH_DRAFT` | 设为 `false` 时 tag 直接发布，默认是草稿 |

`TAURI_UPDATER_PUBKEY` 会在打包时通过 `--config` 注入到二进制里（见 `scripts/desktop-build.mjs`），
所以**换公钥必须重新打包发版**，不能只改仓库变量。

## 2. 发一个新版本

```bash
pnpm version:bump 0.2.0      # 同步 4 个文件：两份 package.json、tauri.conf.json、Cargo.toml/lock
git add -A && git commit -m "chore: release v0.2.0"
git tag v0.2.0 && git push origin main --tags
```

CI 会：

1. 跑完测试；
2. 三个桌面平台分别打包，生成 `.app.tar.gz` / `.nsis.zip` / `.AppImage.tar.gz` 以及对应的 `.sig`；
3. 在 release job 里用 `scripts/make-latest-json.mjs` 汇总成 `latest.json`；
4. 创建 Release（默认草稿）并挂上全部产物。

**草稿 Release 不会被 `releases/latest/download` 命中**，必须在 GitHub 上点「Publish release」，
或者在仓库变量里把 `PUBLISH_DRAFT` 设为 `false` 直接自动发布。

## 3. latest.json 长什么样

```json
{
  "version": "0.2.0",
  "notes": "",
  "pub_date": "2026-11-07T04:29:12.745Z",
  "platforms": {
    "darwin-aarch64": {
      "signature": "dW50cnVzdGVkIGNvbW1lbnQ6...",
      "url": "https://github.com/<owner>/<repo>/releases/download/v0.2.0/Steward_0.2.0_universal.app.tar.gz"
    },
    "windows-x86_64": { "signature": "...", "url": "...nsis.zip" },
    "linux-x86_64": { "signature": "...", "url": "...AppImage.tar.gz" }
  }
}
```

`signature` 就是 `.sig` 文件的内容，客户端用内置公钥验签，验不过直接拒绝安装。
macOS 的 universal 包会同时写入 `darwin-aarch64` 与 `darwin-x86_64` 两个键。

本地可以手动跑一遍验证产物是否齐全：

```bash
pnpm release:latest-json --dir artifacts --repo owner/repo --tag v0.2.0 --out /tmp/latest.json
```

## 4. 客户端的表现

- 启动 3 秒后静默检查一次，失败不打扰用户（更新源没配 / 离线都属正常）。
- 发现新版本：侧边栏底部出现「有新版本 vX →」，设置页「版本与更新」卡片可查看详情。
- 点「下载并安装」显示进度条；下载完成后按钮变成「重启生效」。
- 浏览器预览模式 / 移动端显示「当前环境不支持自动更新」。

## 5. 安全边界

| 问题 | 处理 |
| --- | --- |
| 更新包被替换 | Ed25519 签名 + 内置公钥校验，验签失败拒绝安装 |
| 私钥泄漏 | 攻击者能推任意更新。轮换公钥需要发一次手动更新（旧版本只认旧公钥） |
| 中间人 | HTTPS + 签名双重保护；签名是根本防线 |
| 降级攻击 | 客户端只接受版本号更高的包 |
| 自动更新劫持用户数据 | 更新只替换程序本体，不动本地数据库；同步口令不在磁盘上 |

## 6. 常见问题

| 现象 | 原因 | 排查 |
| --- | --- | --- |
| 一直提示「暂时无法检查更新」 | Release 还是草稿 / 仓库没有 Release | 发布 Release，或确认 `https://github.com/<owner>/<repo>/releases/latest` 能打开 |
| 提示签名不匹配 | 打包时的私钥与仓库变量里的公钥不是一对 | 重新生成密钥对并更新两处，然后发版 |
| 检查到新版本但下载 404 | Release 资产名字变了（例如改了 productName） | 看 `latest.json` 里的 url 是否与实际资产一致 |
| 只有 macOS 有更新 | Windows/Linux 的 update 产物没上传 | 确认对应 job 生成了 `.nsis.zip` / `.AppImage.tar.gz` 与 `.sig` |
| 打了 tag 却什么都没发生 | 仓库没配 remote / Actions 未启用 | 先 `git push` 到 GitHub |

## 7. 为什么不给移动端做自更新

- iOS：非 App Store 渠道的分发本身受限，自下载二进制会被审核和系统双重拒绝。
- Android：技术上可行（下载 APK 安装），但需要「安装未知应用」权限，且与 Play 政策冲突；
  对管钱的 App 来说，绕过应用商店的更新通道是负资产。

移动端更新走商店；商店之外只保留 debug/签名 IPA 给内部测试。
