//! 阿里云 ECS（RPC 风格 OpenAPI + Signature 1.0）。
//!
//! 用 V1 签名而不是新的 V3：V1 的规范更简单、实现更容易验证，
//! ECS 的 RPC 接口目前仍然接受。等真机验证通过后再考虑迁移到 V3。
//!
//! 文档：https://help.aliyun.com/zh/ecs/developer-reference/api-ecs-2014-05-26-*（签名机制）

use std::collections::BTreeMap;

use base64::Engine;
use hmac::{Hmac, Mac};
use serde_json::Value;
use sha1::Sha1;

use super::{normalize_status, CloudCredentials, CloudHost};

const API_VERSION: &str = "2014-05-26";
const PAGE_SIZE: u32 = 100;
const MAX_PAGES: u32 = 5;
const MAX_REGIONS: usize = 8;

type HmacSha1 = Hmac<Sha1>;

/// RFC 3986 编码：除 `A-Z a-z 0-9 - _ . ~` 外全部百分号编码。
/// 阿里云要求空格编成 `%20` 而不是 `+`，`*` 编成 `%2A`，`~` 不编码。
pub(crate) fn percent_encode(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for byte in input.as_bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(*byte as char);
            }
            _ => out.push_str(&format!("%{:02X}", byte)),
        }
    }
    out
}

fn canonicalize(params: &BTreeMap<String, String>) -> String {
    params
        .iter()
        .map(|(key, value)| format!("{}={}", percent_encode(key), percent_encode(value)))
        .collect::<Vec<_>>()
        .join("&")
}

/// Signature 1.0：`Base64(HMAC-SHA1(secret + "&", "GET&%2F&" + encode(canonical)))`
pub(crate) fn sign(params: &BTreeMap<String, String>, secret: &str) -> String {
    let canonical = canonicalize(params);
    let string_to_sign = format!("GET&%2F&{}", percent_encode(&canonical));

    let mut mac =
        HmacSha1::new_from_slice(format!("{secret}&").as_bytes()).expect("HMAC 接受任意长度的密钥");
    mac.update(string_to_sign.as_bytes());
    base64::engine::general_purpose::STANDARD.encode(mac.finalize().into_bytes())
}

fn common_params(creds: &CloudCredentials, action: &str) -> BTreeMap<String, String> {
    let mut params = BTreeMap::new();
    params.insert("Action".into(), action.to_string());
    params.insert("Format".into(), "JSON".into());
    params.insert("Version".into(), API_VERSION.into());
    params.insert("AccessKeyId".into(), creds.access_key_id.clone());
    params.insert("SignatureMethod".into(), "HMAC-SHA1".into());
    params.insert("SignatureVersion".into(), "1.0".into());
    params.insert("SignatureNonce".into(), uuid::Uuid::new_v4().to_string());
    params.insert(
        "Timestamp".into(),
        chrono::Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string(),
    );
    if let Some(token) = &creds.session_token {
        params.insert("SecurityToken".into(), token.clone());
    }
    params
}

async fn call(
    creds: &CloudCredentials,
    region: &str,
    action: &str,
    extra: Vec<(&str, String)>,
) -> Result<Value, String> {
    let mut params = common_params(creds, action);
    for (key, value) in extra {
        params.insert(key.to_string(), value);
    }

    let signature = sign(&params, &creds.access_key_secret);
    let mut query = canonicalize(&params);
    query.push_str("&Signature=");
    query.push_str(&percent_encode(&signature));

    let url = format!("https://ecs.{region}.aliyuncs.com/?{query}");
    let response = super::http::client()?
        .get(&url)
        .send()
        .await
        .map_err(|err| format!("请求阿里云失败（{region}）: {err}"))?;

    let status = response.status();
    let body = response
        .text()
        .await
        .map_err(|err| format!("读取阿里云响应失败: {err}"))?;

    if !status.is_success() {
        return Err(format!(
            "阿里云返回错误（{action}）: {}",
            describe_api_error(&body, status.as_u16())
        ));
    }

    serde_json::from_str(&body).map_err(|err| format!("解析阿里云响应失败: {err}"))
}

/// 阿里云的错误体是 JSON：`{ "Code": "...", "Message": "...", "RequestId": "..." }`
fn describe_api_error(body: &str, status: u16) -> String {
    if let Ok(value) = serde_json::from_str::<Value>(body) {
        let code = value
            .get("Code")
            .and_then(|v| v.as_str())
            .unwrap_or("Unknown");
        let message = value.get("Message").and_then(|v| v.as_str()).unwrap_or("");
        let request_id = value
            .get("RequestId")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        return format!("HTTP {status} {code}: {message} (RequestId {request_id})");
    }
    super::http::summarize_error(status, body)
}

fn string_list(value: Option<&Value>) -> Vec<String> {
    match value {
        Some(Value::Array(items)) => items
            .iter()
            .filter_map(|item| item.as_str().map(|s| s.to_string()))
            .collect(),
        Some(Value::String(single)) => vec![single.clone()],
        _ => Vec::new(),
    }
}

fn as_u32(value: Option<&Value>) -> u32 {
    value
        .and_then(|v| {
            v.as_u64()
                .or_else(|| v.as_str().and_then(|s| s.parse().ok()))
        })
        .unwrap_or(0) as u32
}

fn as_string(value: Option<&Value>) -> Option<String> {
    value.and_then(|v| v.as_str()).map(|s| s.to_string())
}

fn parse_instance(instance: &Value, fallback_region: &str) -> CloudHost {
    let mut public_ips = string_list(instance.pointer("/PublicIpAddress/IpAddress"));
    if let Some(eip) = instance
        .pointer("/EipAddress/IpAddress")
        .and_then(|v| v.as_str())
    {
        if !eip.is_empty() && !public_ips.contains(&eip.to_string()) {
            public_ips.push(eip.to_string());
        }
    }

    let private_ips = string_list(instance.pointer("/VpcAttributes/PrivateIpAddress/IpAddress"));
    let private_ip = private_ips.first().cloned().or_else(|| {
        string_list(instance.pointer("/InnerIpAddress/IpAddress"))
            .first()
            .cloned()
    });

    CloudHost {
        instance_id: as_string(instance.get("InstanceId")).unwrap_or_default(),
        name: as_string(instance.get("InstanceName"))
            .filter(|name| !name.is_empty())
            .unwrap_or_else(|| as_string(instance.get("InstanceId")).unwrap_or_default()),
        region: as_string(instance.get("RegionId")).unwrap_or_else(|| fallback_region.to_string()),
        zone: as_string(instance.get("ZoneId")).unwrap_or_default(),
        status: normalize_status(&as_string(instance.get("Status")).unwrap_or_default()),
        instance_type: as_string(instance.get("InstanceType")).unwrap_or_default(),
        cpu: as_u32(instance.get("Cpu")),
        memory_mb: as_u32(instance.get("Memory")),
        public_ips,
        private_ip,
        os: as_string(instance.get("OSName")),
        created_at: as_string(instance.get("CreationTime")),
        expires_at: as_string(instance.get("ExpiredTime")),
    }
}

pub async fn list_hosts(
    creds: &CloudCredentials,
    regions: &[String],
) -> Result<Vec<CloudHost>, String> {
    let regions: Vec<String> = if regions.is_empty() {
        vec!["cn-hangzhou".to_string()]
    } else {
        regions.iter().take(MAX_REGIONS).cloned().collect()
    };

    let mut hosts = Vec::new();
    for region in regions {
        for page in 1..=MAX_PAGES {
            let value = call(
                creds,
                &region,
                "DescribeInstances",
                vec![
                    ("RegionId", region.clone()),
                    ("PageSize", PAGE_SIZE.to_string()),
                    ("PageNumber", page.to_string()),
                ],
            )
            .await?;

            let instances = value
                .pointer("/Instances/Instance")
                .and_then(|v| v.as_array())
                .cloned()
                .unwrap_or_default();

            let count = instances.len();
            for instance in &instances {
                hosts.push(parse_instance(instance, &region));
            }

            let total = as_u32(value.get("TotalCount"));
            if count < PAGE_SIZE as usize || hosts.len() as u32 >= total {
                break;
            }
        }
    }

    Ok(hosts)
}

pub async fn power(
    creds: &CloudCredentials,
    region: &str,
    instance_id: &str,
    action: &str,
) -> Result<(), String> {
    let api_action = match action {
        "start" => "StartInstance",
        "stop" => "StopInstance",
        "reboot" => "RebootInstance",
        other => return Err(format!("不支持的操作: {other}")),
    };

    call(
        creds,
        region,
        api_action,
        vec![("InstanceId", instance_id.to_string())],
    )
    .await?;
    Ok(())
}

pub async fn validate(creds: &CloudCredentials) -> Result<String, String> {
    let value = call(creds, "cn-hangzhou", "DescribeRegions", vec![]).await?;
    let count = value
        .pointer("/Regions/Region")
        .and_then(|v| v.as_array())
        .map(|list| list.len())
        .unwrap_or(0);
    Ok(format!("凭据有效，可用地域 {count} 个"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn percent_encode_rules() {
        assert_eq!(percent_encode("abc-_.~"), "abc-_.~");
        assert_eq!(percent_encode("a b"), "a%20b");
        assert_eq!(percent_encode("a+b"), "a%2Bb");
        assert_eq!(percent_encode("*"), "%2A");
        assert_eq!(percent_encode("/"), "%2F");
        assert_eq!(percent_encode("中文"), "%E4%B8%AD%E6%96%87");
    }

    #[test]
    fn canonical_string_is_sorted() {
        let mut params = BTreeMap::new();
        params.insert("b".to_string(), "2".to_string());
        params.insert("a".to_string(), "1".to_string());
        assert_eq!(canonicalize(&params), "a=1&b=2");
    }

    #[test]
    fn signature_is_deterministic_for_same_params() {
        let mut params = BTreeMap::new();
        params.insert("Action".to_string(), "DescribeInstances".to_string());
        params.insert("Timestamp".to_string(), "2026-11-07T12:00:00Z".to_string());
        params.insert("SignatureNonce".to_string(), "fixed-nonce".to_string());

        let first = sign(&params, "secret");
        let second = sign(&params, "secret");
        assert_eq!(first, second);
        assert_ne!(first, sign(&params, "another-secret"));
        // base64 的 HMAC-SHA1 结果是 20 字节 → 28 个字符（含一个 =）
        assert_eq!(first.len(), 28);
    }

    #[test]
    fn parses_instance_payload() {
        let payload = serde_json::json!({
            "Instances": {
                "Instance": [{
                    "InstanceId": "i-abc123",
                    "InstanceName": "web-1",
                    "Status": "Running",
                    "RegionId": "cn-hangzhou",
                    "ZoneId": "cn-hangzhou-h",
                    "InstanceType": "ecs.g7.large",
                    "Cpu": 2,
                    "Memory": 4096,
                    "OSName": "Ubuntu 24.04",
                    "CreationTime": "2025-06-01T00:00Z",
                    "ExpiredTime": "2027-06-01T00:00Z",
                    "PublicIpAddress": { "IpAddress": ["47.96.1.1"] },
                    "EipAddress": { "IpAddress": "47.96.2.2" },
                    "VpcAttributes": { "PrivateIpAddress": { "IpAddress": ["172.16.0.8"] } }
                }]
            },
            "TotalCount": 1
        });

        let host = parse_instance(&payload["Instances"]["Instance"][0], "cn-hangzhou");
        assert_eq!(host.instance_id, "i-abc123");
        assert_eq!(host.status, "running");
        assert_eq!(host.cpu, 2);
        assert_eq!(host.memory_mb, 4096);
        assert_eq!(host.public_ips, vec!["47.96.1.1", "47.96.2.2"]);
        assert_eq!(host.private_ip.as_deref(), Some("172.16.0.8"));
    }
}
