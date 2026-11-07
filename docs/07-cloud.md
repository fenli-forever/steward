# 07 · 云厂商对接（阿里云 ECS / AWS EC2）

## 状态

| 厂商 | 方式 | 状态 |
| --- | --- | --- |
| 阿里云 ECS | RPC OpenAPI + Signature 1.0（HMAC-SHA1） | ✅ 已实现 |
| AWS EC2 | Query API + SigV4 | ✅ 已实现 |
| 腾讯云 / Azure / 华为云 / 火山引擎 | — | ⛔ 仍是前端 Mock |

调用全部发生在 **Rust 侧**（`apps/app/src-tauri/src/cloud/`），
AccessKey 从系统钥匙串读出后直接参与签名，不进入 JS 内存、不写日志、不参与同步。

## 用到的接口

### 阿里云

| 用途 | Action |
| --- | --- |
| 验证凭据 | `DescribeRegions` |
| 列实例 | `DescribeInstances`（分页 100/页，最多 5 页/地域） |
| 开机 | `StartInstance` |
| 关机 | `StopInstance` |
| 重启 | `RebootInstance` |

端点是 `https://ecs.{region}.aliyuncs.com/`，`Version=2014-05-26`。
签名逻辑在 `cloud/aliyun.rs`，包含 RFC3986 编码、参数排序、HMAC-SHA1。

### AWS

| 用途 | Action |
| --- | --- |
| 验证凭据 | `DescribeRegions` |
| 列实例 | `DescribeInstances`（`NextToken` 分页，最多 5 页/地域） |
| 开机 | `StartInstances` |
| 关机 | `StopInstances` |
| 重启 | `RebootInstances` |

端点 `https://ec2.{region}.amazonaws.com/`，`Version=2016-11-15`。
SigV4 实现在 `cloud/aws.rs`，**单元测试直接对齐 AWS 官方文档示例**：

```
AKIDEXAMPLE / us-east-1 / iam / 20150830T123600Z
→ 5d672d79c15b13162d9279b0855cfba6789a8edb4c82c400e06b5924a6f2b5d7
```

这个断言在 `cargo test` 里跑，签名算法改坏了会立刻红。

## 最小权限

### AWS IAM 策略

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "ec2:DescribeInstances",
        "ec2:DescribeRegions",
        "ec2:DescribeInstanceStatus"
      ],
      "Resource": "*"
    },
    {
      "Effect": "Allow",
      "Action": ["ec2:StartInstances", "ec2:StopInstances", "ec2:RebootInstances"],
      "Resource": "arn:aws:ec2:*:*:instance/*",
      "Condition": {
        "StringEquals": { "ec2:ResourceTag/steward": "true" }
      }
    }
  ]
}
```

只想看不想动，把第二条整段删掉即可 —— 界面上的开/关机按钮会返回权限错误。

### 阿里云 RAM 策略

```json
{
  "Version": "1",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "ecs:DescribeRegions",
        "ecs:DescribeInstances"
      ],
      "Resource": "*"
    },
    {
      "Effect": "Allow",
      "Action": ["ecs:StartInstance", "ecs:StopInstance", "ecs:RebootInstance"],
      "Resource": "acs:ecs:*:*:instance/*"
    }
  ]
}
```

建议再加一条 `acs:RequestTag/steward = true` 的标签条件，避免误操作生产机。

## 数据流

```
钥匙串（AK/SK）
   │  secret_get
   ▼
Rust 命令 cloud_list_hosts
   │  本地签名（HMAC-SHA1 / SigV4）
   ▼
厂商 OpenAPI ──► 标准化 CloudHost { instanceId, region, zone, status, cpu, ... }
   │
   ▼
前端映射为 @steward/core 的 Host（id = cloudAccountId/instanceId）
```

「同步」每次都会实时拉取，主机列表只是缓存，**不参与端到端同步**。

## 当前限制

| 限制 | 说明 | 计划 |
| --- | --- | --- |
| AWS 没有 CPU/内存 | `DescribeInstances` 不返回规格，需要额外调 `DescribeInstanceTypes` | v0.2 补，或先按 `instanceType` 展示 |
| 磁盘大小未采集 | 需要 `DescribeVolumes` / `DescribeDisks` | v0.3 |
| 到期时间只有阿里云有 | AWS 的 RI/Savings Plan 需要另查 | 暂不做 |
| 单次最多 8 个地域 | 防止一次同步打太多请求 | 可配置 |
| 阿里云签名用 V1 | V3 需要更多头字段；V1 目前仍可用 | 后续迁移 |
| 没有退避重试 | 厂商限流时直接报错 | 用 `Retry-After` 做指数退避 |

## 怎么自己验证

1. 桌面端运行 `pnpm tauri dev`
2. 云主机页 → 添加云账号 → 选阿里云或 AWS
3. 填只读 AK/SK → 点「绑定并同步」
   - 会先调一次 `DescribeRegions` 验证凭据，失败会直接显示厂商错误码
   - 成功后立刻拉取实例列表
4. `cargo test --manifest-path apps/app/src-tauri/Cargo.toml --lib` 可以单独验证签名与解析逻辑

浏览器预览模式（`pnpm dev`）下没有 Rust，阿里云/AWS 会自动退回 Mock，并标注「Mock」。
