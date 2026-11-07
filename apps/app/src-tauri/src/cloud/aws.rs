//! AWS EC2（Query API + Signature Version 4）。
//!
//! 用 Query API 而不是 JSON：EC2 只提供 Query，返回 XML。
//! 签名自己实现（SigV4 规范明确，且能用官方示例做单元测试），
//! 不引入 aws-sdk 那样上百个 crate 的依赖。

use std::collections::BTreeMap;

use hmac::{Hmac, Mac};
use quick_xml::events::Event;
use quick_xml::Reader;
use sha2::{Digest, Sha256};

use super::{normalize_status, CloudCredentials, CloudHost};

const API_VERSION: &str = "2016-11-15";
const SERVICE: &str = "ec2";
const MAX_PAGES: usize = 5;
const DEFAULT_REGION: &str = "us-east-1";

type HmacSha256 = Hmac<Sha256>;

fn hmac(key: &[u8], data: &[u8]) -> Vec<u8> {
    let mut mac = HmacSha256::new_from_slice(key).expect("HMAC 接受任意长度的密钥");
    mac.update(data);
    mac.finalize().into_bytes().to_vec()
}

fn sha256_hex(data: &[u8]) -> String {
    hex::encode(Sha256::digest(data))
}

fn signing_key(secret: &str, date: &str, region: &str, service: &str) -> Vec<u8> {
    let k_date = hmac(format!("AWS4{secret}").as_bytes(), date.as_bytes());
    let k_region = hmac(&k_date, region.as_bytes());
    let k_service = hmac(&k_region, service.as_bytes());
    hmac(&k_service, b"aws4_request")
}

/// 构造 Authorization 头。所有 header 名必须已经小写。
///
/// 格式参考 AWS 文档：
/// `AWS4-HMAC-SHA256 Credential=<AK>/<date>/<region>/<service>/aws4_request, SignedHeaders=..., Signature=...`
pub(crate) fn build_authorization(
    access_key_id: &str,
    secret: &str,
    method: &str,
    path: &str,
    query: &str,
    headers: &BTreeMap<String, String>,
    payload_hash: &str,
    amz_date: &str,
    region: &str,
    service: &str,
) -> String {
    let mut canonical_headers = String::new();
    for (name, value) in headers {
        canonical_headers.push_str(name);
        canonical_headers.push(':');
        canonical_headers.push_str(value.trim());
        canonical_headers.push('\n');
    }

    let signed_headers = headers.keys().cloned().collect::<Vec<_>>().join(";");
    let canonical_request =
        format!("{method}\n{path}\n{query}\n{canonical_headers}\n{signed_headers}\n{payload_hash}");

    let (date, scope) = {
        // amz_date 形如 20261107T120000Z
        let date = &amz_date[..8];
        (
            date.to_string(),
            format!("{date}/{region}/{service}/aws4_request"),
        )
    };

    let string_to_sign = format!(
        "AWS4-HMAC-SHA256\n{amz_date}\n{scope}\n{}",
        sha256_hex(canonical_request.as_bytes())
    );

    let key = signing_key(secret, &date, region, service);
    let signature = hex::encode(hmac(&key, string_to_sign.as_bytes()));

    format!(
        "AWS4-HMAC-SHA256 Credential={access_key_id}/{scope}, SignedHeaders={signed_headers}, Signature={signature}"
    )
}

/// 发一个 EC2 Query 请求（POST + form body）。
async fn call(creds: &CloudCredentials, region: &str, body: &str) -> Result<String, String> {
    let host = format!("ec2.{region}.amazonaws.com");
    let now = chrono::Utc::now();
    let amz_date = now.format("%Y%m%dT%H%M%SZ").to_string();

    let mut headers = BTreeMap::new();
    headers.insert(
        "content-type".to_string(),
        "application/x-www-form-urlencoded; charset=utf-8".to_string(),
    );
    headers.insert("host".to_string(), host.clone());
    headers.insert("x-amz-date".to_string(), amz_date.clone());
    if let Some(token) = &creds.session_token {
        headers.insert("x-amz-security-token".to_string(), token.clone());
    }

    let payload_hash = sha256_hex(body.as_bytes());
    let authorization = build_authorization(
        &creds.access_key_id,
        &creds.access_key_secret,
        "POST",
        "/",
        "",
        &headers,
        &payload_hash,
        &amz_date,
        region,
        SERVICE,
    );

    let mut request = super::http::client()?
        .post(format!("https://{host}/"))
        .header("x-amz-date", &amz_date)
        .header("x-amz-content-sha256", &payload_hash)
        .header(
            "content-type",
            "application/x-www-form-urlencoded; charset=utf-8",
        )
        .header("authorization", authorization);

    if let Some(token) = &creds.session_token {
        request = request.header("x-amz-security-token", token);
    }

    let response = request
        .body(body.to_string())
        .send()
        .await
        .map_err(|err| format!("请求 AWS 失败（{region}）: {err}"))?;

    let status = response.status();
    let text = response
        .text()
        .await
        .map_err(|err| format!("读取 AWS 响应失败: {err}"))?;

    if !status.is_success() {
        return Err(format!(
            "AWS 返回错误: {}",
            describe_api_error(&text, status.as_u16())
        ));
    }

    Ok(text)
}

/// EC2 的错误体是 XML：`<Response><Errors><Error><Code>..</Code><Message>..</Message>`
fn describe_api_error(body: &str, status: u16) -> String {
    let code = extract_tag(body, "Code").unwrap_or_else(|| "Unknown".to_string());
    let message = extract_tag(body, "Message").unwrap_or_default();
    if message.is_empty() {
        super::http::summarize_error(status, body)
    } else {
        format!("HTTP {status} {code}: {message}")
    }
}

fn extract_tag(xml: &str, tag: &str) -> Option<String> {
    let open = format!("<{tag}>");
    let close = format!("</{tag}>");
    let start = xml.find(&open)? + open.len();
    let end = xml[start..].find(&close)? + start;
    Some(xml[start..end].trim().to_string())
}

#[derive(Default)]
struct InstanceBuilder {
    instance_id: String,
    name: String,
    status: String,
    instance_type: String,
    zone: String,
    private_ip: Option<String>,
    public_ip: Option<String>,
    launch_time: Option<String>,
}

impl InstanceBuilder {
    fn into_host(self, region: &str) -> CloudHost {
        let mut public_ips = Vec::new();
        if let Some(ip) = self.public_ip.filter(|ip| !ip.is_empty()) {
            public_ips.push(ip);
        }
        CloudHost {
            instance_id: self.instance_id.clone(),
            name: if self.name.is_empty() {
                self.instance_id
            } else {
                self.name
            },
            region: region.to_string(),
            zone: self.zone,
            status: normalize_status(&self.status),
            instance_type: self.instance_type,
            // EC2 的规格要另调 DescribeInstanceTypes，这里先不猜
            cpu: 0,
            memory_mb: 0,
            public_ips,
            private_ip: self.private_ip.filter(|ip| !ip.is_empty()),
            os: None,
            created_at: self.launch_time,
            expires_at: None,
        }
    }
}

fn local_name(name: &[u8]) -> String {
    let full = String::from_utf8_lossy(name);
    full.rsplit(':').next().unwrap_or(&full).to_string()
}

/// 解析 DescribeInstances 的 XML。只取我们需要的字段，其余忽略。
pub(crate) fn parse_instances(xml: &str, region: &str) -> Result<Vec<CloudHost>, String> {
    let mut reader = Reader::from_str(xml);
    reader.config_mut().trim_text(true);

    let mut path: Vec<String> = Vec::new();
    let mut hosts = Vec::new();
    let mut current: Option<InstanceBuilder> = None;
    let mut instance_depth: Option<usize> = None;
    let mut tag_key: Option<String> = None;

    loop {
        match reader.read_event() {
            Ok(Event::Start(event)) => {
                let name = local_name(event.name().as_ref());
                path.push(name.clone());

                if name == "item"
                    && path.len() >= 2
                    && path[path.len() - 2] == "instancesSet"
                    && current.is_none()
                {
                    current = Some(InstanceBuilder::default());
                    instance_depth = Some(path.len());
                }
            }
            Ok(Event::Text(event)) => {
                let Some(builder) = current.as_mut() else {
                    continue;
                };
                let raw = event.decode().unwrap_or_default().to_string();
                let text = quick_xml::escape::unescape(&raw)
                    .map(|c| c.to_string())
                    .unwrap_or(raw);
                if text.is_empty() {
                    continue;
                }
                match path.last().map(|s| s.as_str()) {
                    Some("instanceId") => builder.instance_id = text,
                    Some("instanceType") => builder.instance_type = text,
                    Some("privateIpAddress") => builder.private_ip = Some(text),
                    Some("ipAddress") => builder.public_ip = Some(text),
                    Some("launchTime") => builder.launch_time = Some(text),
                    Some("name") => {
                        // instanceState/name
                        if path.len() >= 2 && path[path.len() - 2] == "instanceState" {
                            builder.status = text;
                        }
                    }
                    Some("availabilityZone") => builder.zone = text,
                    Some("key") => tag_key = Some(text),
                    Some("value") => {
                        if tag_key.as_deref() == Some("Name") && builder.name.is_empty() {
                            builder.name = text;
                        }
                        tag_key = None;
                    }
                    _ => {}
                }
            }
            Ok(Event::End(event)) => {
                let name = local_name(event.name().as_ref());
                if name == "item" && instance_depth == Some(path.len()) {
                    if let Some(builder) = current.take() {
                        hosts.push(builder.into_host(region));
                    }
                    instance_depth = None;
                }
                path.pop();
            }
            Ok(Event::Eof) => break,
            Err(err) => return Err(format!("解析 AWS 响应 XML 失败: {err}")),
            _ => {}
        }
    }

    Ok(hosts)
}

fn form_body(action: &str, extra: &[(&str, String)]) -> String {
    let mut pairs = vec![
        ("Action", action.to_string()),
        ("Version", API_VERSION.to_string()),
    ];
    for (key, value) in extra {
        pairs.push((key, value.clone()));
    }
    pairs
        .into_iter()
        .map(|(key, value)| format!("{}={}", form_encode(key), form_encode(&value)))
        .collect::<Vec<_>>()
        .join("&")
}

/// form-urlencoded 里空格用 `+`，其余按 RFC3986。
fn form_encode(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for byte in input.as_bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(*byte as char)
            }
            b' ' => out.push('+'),
            _ => out.push_str(&format!("%{:02X}", byte)),
        }
    }
    out
}

pub async fn list_hosts(
    creds: &CloudCredentials,
    regions: &[String],
) -> Result<Vec<CloudHost>, String> {
    let regions: Vec<String> = if regions.is_empty() {
        vec![DEFAULT_REGION.to_string()]
    } else {
        regions.to_vec()
    };

    let mut hosts = Vec::new();
    for region in regions {
        let mut next_token: Option<String> = None;
        for _ in 0..MAX_PAGES {
            let mut extra = Vec::new();
            if let Some(token) = &next_token {
                extra.push(("NextToken", token.clone()));
            }
            let body = form_body("DescribeInstances", &extra);
            let xml = call(creds, &region, &body).await?;
            hosts.extend(parse_instances(&xml, &region)?);

            match extract_tag(&xml, "nextToken") {
                Some(token) if !token.is_empty() => next_token = Some(token),
                _ => break,
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
        "start" => "StartInstances",
        "stop" => "StopInstances",
        "reboot" => "RebootInstances",
        other => return Err(format!("不支持的操作: {other}")),
    };

    let body = form_body(api_action, &[("InstanceId.1", instance_id.to_string())]);
    call(creds, region, &body).await?;
    Ok(())
}

pub async fn validate(creds: &CloudCredentials) -> Result<String, String> {
    let body = form_body("DescribeRegions", &[]);
    let xml = call(creds, DEFAULT_REGION, &body).await?;
    let count = xml.matches("<regionName>").count();
    Ok(format!("凭据有效，可用地域 {count} 个"))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// AWS 官方文档的 SigV4 示例（IAM ListUsers）：
    /// 期望签名 5d672d79c15b13162d9279b0855cfba6789a8edb4c82c400e06b5924a6f2b5d7
    #[test]
    fn matches_aws_published_signature() {
        let mut headers = BTreeMap::new();
        headers.insert(
            "content-type".to_string(),
            "application/x-www-form-urlencoded; charset=utf-8".to_string(),
        );
        headers.insert("host".to_string(), "iam.amazonaws.com".to_string());
        headers.insert("x-amz-date".to_string(), "20150830T123600Z".to_string());

        let authorization = build_authorization(
            "AKIDEXAMPLE",
            "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
            "GET",
            "/",
            "Action=ListUsers&Version=2010-05-08",
            &headers,
            &sha256_hex(b""),
            "20150830T123600Z",
            "us-east-1",
            "iam",
        );

        assert!(
            authorization.ends_with(
                "Signature=5d672d79c15b13162d9279b0855cfba6789a8edb4c82c400e06b5924a6f2b5d7"
            ),
            "签名不匹配，实际: {authorization}"
        );
    }

    #[test]
    fn parses_describe_instances_xml() {
        let xml = r#"<?xml version="1.0" encoding="UTF-8"?>
<DescribeInstancesResponse xmlns="http://ec2.amazonaws.com/doc/2016-11-15/">
  <requestId>abc</requestId>
  <reservationSet>
    <item>
      <reservationId>r-1</reservationId>
      <instancesSet>
        <item>
          <instanceId>i-0abc</instanceId>
          <instanceState><code>16</code><name>running</name></instanceState>
          <privateIpAddress>10.0.1.5</privateIpAddress>
          <ipAddress>13.112.1.1</ipAddress>
          <instanceType>t3.medium</instanceType>
          <launchTime>2026-01-02T03:04:05.000Z</launchTime>
          <placement><availabilityZone>ap-northeast-1a</availabilityZone></placement>
          <tagSet>
            <item><key>Name</key><value>api-tokyo</value></item>
          </tagSet>
        </item>
      </instancesSet>
    </item>
  </reservationSet>
</DescribeInstancesResponse>"#;

        let hosts = parse_instances(xml, "ap-northeast-1").unwrap();
        assert_eq!(hosts.len(), 1);
        let host = &hosts[0];
        assert_eq!(host.instance_id, "i-0abc");
        assert_eq!(host.name, "api-tokyo");
        assert_eq!(host.status, "running");
        assert_eq!(host.zone, "ap-northeast-1a");
        assert_eq!(host.private_ip.as_deref(), Some("10.0.1.5"));
        assert_eq!(host.public_ips, vec!["13.112.1.1"]);
        assert_eq!(host.instance_type, "t3.medium");
    }

    #[test]
    fn form_encoding() {
        assert_eq!(form_encode("a b"), "a+b");
        assert_eq!(form_encode("a/b"), "a%2Fb");
    }
}
