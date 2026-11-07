//! 云厂商适配（Rust 侧）。
//!
//! 为什么放在 Rust：AccessKey 从系统钥匙串读出来就直接参与签名，
//! 不进 JS 内存、不进日志、不会被持久化层或同步逻辑碰到。
//!
//! 目前实现两家：
//! - 阿里云 ECS：RPC 风格 OpenAPI，Signature 1.0（HMAC-SHA1）
//! - AWS EC2：Query API + SigV4
//!
//! 腾讯云 / Azure / 华为云 / 火山引擎仍是前端 Mock，等这里补齐。

pub mod aliyun;
pub mod aws;
mod http;

use serde::{Deserialize, Serialize};

/// 云厂商凭据。只在本进程内存里存在，用完即弃（调用方负责从钥匙串读出）。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudCredentials {
    pub access_key_id: String,
    pub access_key_secret: String,
    /// STS 临时凭据才需要
    #[serde(default)]
    pub session_token: Option<String>,
}

impl CloudCredentials {
    fn validate(&self) -> Result<(), String> {
        if self.access_key_id.trim().is_empty() || self.access_key_secret.trim().is_empty() {
            return Err("AccessKeyId / AccessKeySecret 不能为空".into());
        }
        Ok(())
    }
}

/// 标准化后的主机。前端会把它映射成 `@steward/core` 的 `Host`。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudHost {
    pub instance_id: String,
    pub name: String,
    pub region: String,
    pub zone: String,
    pub status: String,
    pub instance_type: String,
    pub cpu: u32,
    pub memory_mb: u32,
    pub public_ips: Vec<String>,
    pub private_ip: Option<String>,
    pub os: Option<String>,
    pub created_at: Option<String>,
    pub expires_at: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Provider {
    Aliyun,
    Aws,
}

impl std::str::FromStr for Provider {
    type Err = String;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "aliyun" => Ok(Provider::Aliyun),
            "aws" => Ok(Provider::Aws),
            other => Err(format!(
                "暂不支持的云厂商: {other}（当前支持 aliyun / aws）"
            )),
        }
    }
}

/// 把各厂商五花八门的状态收敛成前端的 HostStatus。
pub(crate) fn normalize_status(raw: &str) -> String {
    let lower = raw.to_ascii_lowercase();
    match lower.as_str() {
        "running" | "started" => "running",
        "stopped" | "stopping" => {
            if lower == "stopping" {
                "stopping"
            } else {
                "stopped"
            }
        }
        "starting" | "pending" => "starting",
        "rebooting" | "stopping-pending" => "rebooting",
        _ => "unknown",
    }
    .to_string()
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ValidateResult {
    pub ok: bool,
    pub detail: String,
}

/// 列出主机。`regions` 为空时使用厂商默认地域策略。
#[tauri::command]
pub async fn cloud_list_hosts(
    provider: String,
    creds: CloudCredentials,
    regions: Vec<String>,
) -> Result<Vec<CloudHost>, String> {
    creds.validate()?;
    let provider: Provider = provider.parse()?;

    let result = match provider {
        Provider::Aliyun => aliyun::list_hosts(&creds, &regions).await,
        Provider::Aws => aws::list_hosts(&creds, &regions).await,
    };

    result.map_err(|err| format!("{}", err))
}

/// 启停 / 重启。只允许这三个动作，避免前端传进来任意 Action。
#[tauri::command]
pub async fn cloud_power(
    provider: String,
    creds: CloudCredentials,
    region: String,
    instance_id: String,
    action: String,
) -> Result<(), String> {
    creds.validate()?;
    let provider: Provider = provider.parse()?;
    if region.trim().is_empty() || instance_id.trim().is_empty() {
        return Err("region / instanceId 不能为空".into());
    }

    let result = match provider {
        Provider::Aliyun => aliyun::power(&creds, &region, &instance_id, &action).await,
        Provider::Aws => aws::power(&creds, &region, &instance_id, &action).await,
    };
    result.map_err(|err| format!("{}", err))
}

/// 测试凭据：调一个最小的只读接口，顺便把账号 ID 带回来。
#[tauri::command]
pub async fn cloud_validate(
    provider: String,
    creds: CloudCredentials,
) -> Result<ValidateResult, String> {
    creds.validate()?;
    let provider: Provider = provider.parse()?;
    let detail = match provider {
        Provider::Aliyun => aliyun::validate(&creds).await,
        Provider::Aws => aws::validate(&creds).await,
    }?;
    Ok(ValidateResult { ok: true, detail })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn status_mapping() {
        assert_eq!(normalize_status("Running"), "running");
        assert_eq!(normalize_status("Stopped"), "stopped");
        assert_eq!(normalize_status("Stopping"), "stopping");
        assert_eq!(normalize_status("Pending"), "starting");
        assert_eq!(normalize_status("weird"), "unknown");
    }

    #[test]
    fn provider_parsing() {
        assert_eq!("aliyun".parse::<Provider>().unwrap(), Provider::Aliyun);
        assert_eq!("aws".parse::<Provider>().unwrap(), Provider::Aws);
        assert!("tencent".parse::<Provider>().is_err());
    }
}
