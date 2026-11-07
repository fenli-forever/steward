//! Tauri 壳层。
//!
//! 这里的职责只有两个：
//! 1. 把 WebView 里的前端装进原生窗口（桌面 + iOS/Android）。
//! 2. 提供前端拿不到的能力 —— 目前是系统钥匙串里的凭据读写。
//!
//! 敏感数据一律走 `secret_*` 命令，明文只存在于本次调用的内存里，
//! 不落盘、不经过前端持久化层、更不会进入同步请求。

use keyring::Entry;
use zeroize::Zeroize;

/// 钥匙串里的服务名。改成自己的 Bundle ID，避免和别的 App 撞车。
const SERVICE: &str = "com.steward.app";

const MAX_SECRET_BYTES: usize = 8 * 1024;

fn entry_for(key: &str) -> Result<Entry, String> {
    let trimmed = key.trim();
    if trimmed.is_empty() {
        return Err("凭据 key 不能为空".to_string());
    }
    Entry::new(SERVICE, trimmed).map_err(|err| format!("无法访问系统钥匙串: {err}"))
}

#[tauri::command]
fn secret_set(key: String, value: String) -> Result<(), String> {
    if value.len() > MAX_SECRET_BYTES {
        return Err("凭据过大（超过 8KB），请检查是否传错了内容".to_string());
    }
    let mut value = value;
    let entry = entry_for(&key)?;
    entry
        .set_password(&value)
        .map_err(|err| format!("写入钥匙串失败: {err}"))?;
    // 写入后立刻擦除本进程内存中的副本
    value.zeroize();
    Ok(())
}

#[tauri::command]
fn secret_get(key: String) -> Result<Option<String>, String> {
    let entry = entry_for(&key)?;
    match entry.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(err) => Err(format!("读取钥匙串失败: {err}")),
    }
}

#[tauri::command]
fn secret_delete(key: String) -> Result<(), String> {
    let entry = entry_for(&key)?;
    match entry.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(err) => Err(format!("删除钥匙串条目失败: {err}")),
    }
}

#[derive(serde::Serialize)]
struct AppInfo {
    platform: &'static str,
    arch: &'static str,
    version: &'static str,
    /// 是否使用系统钥匙串（移动端/桌面端恒为 true）。
    secure_storage: bool,
}

#[tauri::command]
fn app_info() -> AppInfo {
    AppInfo {
        platform: std::env::consts::OS,
        arch: std::env::consts::ARCH,
        version: env!("CARGO_PKG_VERSION"),
        secure_storage: true,
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            secret_set,
            secret_get,
            secret_delete,
            app_info
        ])
        .run(tauri::generate_context!())
        .expect("启动 Steward 失败");
}
