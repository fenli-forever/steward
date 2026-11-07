//! 共享的 HTTP 客户端。
//!
//! 统一超时、UA 和错误信息格式；错误信息里绝不打印 URL 查询串
//! （阿里云的 Signature 就在 query 里，AWS 的在 header 里）。

use std::time::Duration;

pub fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .connect_timeout(Duration::from_secs(10))
        .user_agent("Steward/0.1 (+https://github.com/fenli-forever/steward)")
        .build()
        .map_err(|err| format!("初始化 HTTP 客户端失败: {err}"))
}

/// 把厂商返回的错误体压成一行可读文本。
pub fn summarize_error(status: u16, body: &str) -> String {
    let trimmed = body.trim();
    let cut = trimmed
        .char_indices()
        .nth(600)
        .map(|(i, _)| i)
        .unwrap_or(trimmed.len());
    if trimmed.is_empty() {
        format!("HTTP {status}")
    } else {
        format!("HTTP {status}: {}", &trimmed[..cut])
    }
}
