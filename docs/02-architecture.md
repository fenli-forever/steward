# 02 · 技术架构

## 1. 为什么是 Tauri 2

| 方案 | 四端覆盖 | 包体 | 原生能力 | 风险 |
| --- | --- | --- | --- | --- |
| **Tauri 2（选中）** | 桌面 + iOS + Android，一套 React 前端 | 桌面 ~10MB | Rust 侧可调系统钥匙串、SDK、文件 | Rust 学习曲线；WebView 差异 |
| Flutter | 四端，UI 一致性好 | ~20MB | Dart FFI 可用 | 云厂商无官方 Dart SDK，需自写 HTTP 签名 |
| Electron + RN | 桌面与移动两套壳 | 100MB+ | Node 生态最全 | 两套构建链路，维护成本高 |
| 纯 PWA | 只有浏览器 | 0 | 无钥匙串、无局域网发现 | 无法满足核心需求 |

决定性因素：**密钥必须进系统钥匙串**（PWA 做不到），且**不想维护两套壳**（排除 Electron+RN）。
Tauri 的 WebView 复用系统内核，桌面包体小，移动端也能用同一份前端。

代价与对策：

- WebView 版本差异 → `vite.config.ts` 中按平台设置 `build.target`（Windows `chrome105`，其余 `safari15`）。
- Rust 侧代码量 → 尽量薄，只放「前端做不到的事」（钥匙串、后续的原生 SDK）。

## 2. 分层

```
┌──────────────────────────────────────────────┐
│ UI 层（React 19 + react-router + zustand）    │  apps/app/src
│  · 只做展示与交互，不写业务规则                 │
├──────────────────────────────────────────────┤
│ 应用编排层（store / sync 编排 / 凭据适配）      │  apps/app/src/data
├──────────────────────────────────────────────┤
│ 领域层（纯 TS，无 DOM/无网络）                  │  packages/core
│  · 金额、账单解析、聚合、加密、同步合并          │
├──────────────────────────────────────────────┤
│ 平台层                                        │
│  · Tauri 命令（钥匙串）  src-tauri/src/lib.rs  │
│  · 同步服务 HTTP API     services/sync         │
└──────────────────────────────────────────────┘
```

**硬性约束**：`packages/core` 不允许 import React、DOM API、Node API 或任何云厂商 SDK。
它同时被浏览器、Tauri WebView、Node 服务端测试使用；一旦引入平台依赖，这套复用就崩了。

## 3. 数据流

### 3.1 本地写入

```
用户操作 → zustand action → 生成/更新实体（带 updatedAt）
        → persist 到 localStorage（Web） / 后续换 SQLite（Tauri）
        → UI 重渲染
```

> v0.1 用 zustand persist 存 localStorage，是为了让浏览器预览与 Tauri 共用一份代码。
> v0.2 会在 Tauri 侧换成 SQLite（`tauri-plugin-sql`），localStorage 仅保留为 Web 预览的降级实现。

### 3.2 云主机刷新

```
同步按钮 → 从钥匙串读 AK/SK（仅内存）
        → CloudProviderAdapter.listHosts(creds, regions)
        → 标准化 Host（id = `${accountId}/${instanceId}`）
        → 覆盖该账号下的主机快照
```

主机数据**不做端到端同步**：它随时可以从云厂商拉取，属于「缓存」而非「用户资产」。
只有云账号的元数据（别名、地域、secretRef）参与同步。

### 3.3 双向同步

```
设备 A                     服务器（只存密文）                设备 B
  │  pull(since=0) ────────────▶ │
  │  ◀──── records[] (密文) ───── │
  │  解密 + 按 (updatedAt,rev,deviceId) LWW 合并
  │  push(本地更新的记录) ───────▶ │ ── seq++ ──▶ 持久化
  │                              │  ◀──── pull(since=cursor) ──
```

## 4. 领域模型

| 实体 | 关键字段 | 同步 | 说明 |
| --- | --- | --- | --- |
| `Card` | kind, issuer, last4, creditLimitMinor, billingDay, dueDay, secretRef | ✅ | 只存末四位 |
| `Statement` | cardId, period, dueDate, totalAmountMinor, lines[] | ✅ | 含明细行 |
| `CloudAccount` | provider, alias, regions, secretRef | ✅ | secretRef 只是本地索引 |
| `Host` | instanceId, region, status, spec, cost | ❌ | 从云端实时拉取的缓存 |
| `SmartHomeHub` | kind, endpoint, secretRef | ✅ | v2 |
| 凭据（AK/SK、密码） | — | ❌ | 系统钥匙串，永不出设备 |

金额统一用**最小货币单位整数**（分）。`JPY` 没有小数位，`money.ts` 里单独处理。
跨币种操作直接抛错，强制调用方显式做汇率换算——静默相加是财务类 App 最危险的 bug 来源。

## 5. 同步协议

### 端点

| 方法 | 路径 | 鉴权 | 说明 |
| --- | --- | --- | --- |
| `POST` | `/v1/vaults` | 管理员令牌 | 建仓库，返回 Vault ID + 一次性配对码 |
| `POST` | `/v1/vaults/:id/pairing-tokens` | 管理员令牌 | 给新设备签配对码 |
| `POST` | `/v1/vaults/:id/devices` | 配对码 | 换设备令牌（配对码一次性、10 分钟过期） |
| `GET` | `/v1/vaults/:id/records?since=` | 设备令牌 | 增量拉取，按 `seq` 游标 |
| `POST` | `/v1/vaults/:id/records` | 设备令牌 | 批量推送，服务端按同一套 LWW 规则拒绝回退 |

### 记录格式

```jsonc
{
  "collection": "cards",          // 集合名（服务端可见）
  "id": "card_01JC...",           // ULID（服务端可见）
  "rev": 1730455200,              // 本地修订号，用于幂等与排序
  "updatedAt": "2026-11-01T10:00:00.000Z",
  "deviceId": "dev_xxx",
  "deleted": false,
  "sealed": {                     // 内容全部加密
    "v": 1,
    "nonce": "base64(24B)",
    "ciphertext": "base64"
  }
}
```

服务端看不到 `sealed` 里是什么，只知道这是 `cards` 集合里的一条记录。

### 冲突策略

LWW，比较顺序：`updatedAt` → `rev` → `deviceId`（字典序）。
三台设备用同一套比较函数，保证收敛到同一结果。

**为什么不用 CRDT**：单用户、低并发、记录量小；LWW 的实现与排障成本低一个数量级。
代价是并发编辑会整条覆盖。v0.2 会在覆盖前把落败版本写入本地冲突日志，给用户 7 天恢复窗口。

## 6. 云适配器

```ts
interface CloudProviderAdapter {
  validateCredentials(creds): Promise<Result<{ accountId?: string }>>;
  listHosts(creds, regions): Promise<Result<Host[]>>;
  startHost(creds, host): Promise<Result<void>>;
  stopHost(creds, host): Promise<Result<void>>;
  rebootHost(creds, host): Promise<Result<void>>;
}
```

- 所有方法**返回 Result 而不抛异常**：云厂商的限流、地域不可用、AK 过期都是常态，必须能在 UI 上逐条呈现。
- `Host.id = ${cloudAccountId}/${instanceId}`：同名实例在不同账号/地域下不会互相覆盖。
- 真实实现放在 `apps/app/src-tauri`（Rust SDK）或 前端 `fetch` + 签名？**选择 Rust 侧**：
  AK/SK 不出现在 JS 内存，且各厂商 Rust SDK 已成熟（阿里云 `alibabacloud-*`、AWS `aws-sdk-ec2`、腾讯云签名手写）。
  前端只调用 `tauri::command` 拿标准化后的 `Host[]`。

## 7. 构建与分发

| 目标 | 命令 | 说明 |
| --- | --- | --- |
| 桌面 | `pnpm tauri build` | 产出 `.app` / `.msi` / `.AppImage` |
| iOS | `pnpm tauri ios init && pnpm tauri ios build` | 需 Xcode 15+ 与开发者证书 |
| Android | `pnpm tauri android init && pnpm tauri android build` | 需 Android Studio + NDK |
| 浏览器预览 | `pnpm dev` | 无原生能力，凭据降级到 localStorage |

签名与公证：macOS 需 Developer ID + 公证；iOS 走 TestFlight；Android 用 Play App Signing。
这些属于发布流程，不进仓库。

## 8. 同步服务部署

```bash
# 单机
STEWARD_ADMIN_TOKEN=$(openssl rand -base64 32) \
STEWARD_DATA_DIR=/var/lib/steward \
  node services/sync/dist/main.js
```

- 单文件 SQLite（WAL 模式），备份 = 复制 `steward.db`。
- 建议放在内网 / Tailscale，或前置 Caddy 做 TLS。
- 容量估算：5000 条记录 × 平均 2KB 密文 ≈ 10MB，SQLite 完全够用。

## 9. 容量与性能

- 单用户卡片 < 50、账单明细 < 5000/年、主机 < 500：全部可一次性载入内存。
- 全量同步 < 1MB，局域网内 < 1s。
- 账单解析 1 万行 CSV：单线程 < 100ms（实测 200 行 < 5ms）。

## 10. 技术债清单

1. localStorage 存业务数据，在多标签页下会互相覆盖（v0.2 换 SQLite + 单实例锁）。
2. 同步没有后台调度，只有手动触发。
3. `node:sqlite` 是实验 API，Node 升级需回归。
4. 桌面端未在 CI 编译（当前环境无 Rust），首次构建可能遇到工具链问题。
5. 前端没有路由级代码分割，首包 360KB（gzip 119KB），可接受但可优化。
