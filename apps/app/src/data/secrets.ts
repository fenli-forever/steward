/**
 * 本地凭据存储。
 *
 * 敏感信息（银行卡密码、CVV、云厂商 AK/SK）**只存在设备上**：
 * - 桌面端 / 移动端：Tauri 命令 → 系统钥匙串（macOS Keychain、Windows Credential
 *   Manager、iOS Keychain、Android Keystore），密文由操作系统保护。
 * - 浏览器预览模式：退化为 localStorage，仅用于开发调试，界面上会明确警示。
 *
 * 注意：这里存的是「最终密文」的索引，同步服务器永远拿不到这些值。
 */

const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

interface InvokeFn {
  (cmd: string, args?: Record<string, unknown>): Promise<unknown>;
}

let invokeFn: InvokeFn | null = null;

async function invoke(cmd: string, args?: Record<string, unknown>): Promise<unknown> {
  if (!isTauri) throw new Error('当前环境不支持系统钥匙串');
  if (!invokeFn) {
    const mod = (await import('@tauri-apps/api/core')) as { invoke: InvokeFn };
    invokeFn = mod.invoke;
  }
  return invokeFn(cmd, args);
}

const PREFIX = 'steward.secret.';

export const usingSystemKeychain = isTauri;

export async function setSecret(key: string, value: string): Promise<void> {
  if (isTauri) {
    await invoke('secret_set', { key, value });
    return;
  }
  window.localStorage.setItem(PREFIX + key, value);
}

export async function getSecret(key: string): Promise<string | null> {
  if (isTauri) {
    try {
      return (await invoke('secret_get', { key })) as string | null;
    } catch {
      return null;
    }
  }
  return window.localStorage.getItem(PREFIX + key);
}

export async function deleteSecret(key: string): Promise<void> {
  if (isTauri) {
    await invoke('secret_delete', { key });
    return;
  }
  window.localStorage.removeItem(PREFIX + key);
}
