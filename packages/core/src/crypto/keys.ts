import { scryptAsync } from '@noble/hashes/scrypt.js';
import { randomBytes } from './encoding.js';
import { bytesToBase64, base64ToBytes } from './encoding.js';

/**
 * 两把钥匙，用途完全不同，不能混用：
 *
 * 1. 本地保险箱密钥（vault key）：32 字节随机数，只存在操作系统的钥匙串里
 *    （macOS Keychain / Windows Credential Manager / iOS Keychain / Android Keystore）。
 *    用来加密卡号、密码、云厂商 AK/SK。**永远不出设备。**
 *
 * 2. 同步密钥（sync key）：由用户记住的「同步口令」经 scrypt 派生。
 *    用来端到端加密要同步的元数据。服务器只看到密文。
 *    换设备时输入同一口令即可解密，所以它必须可重建、且强度足够。
 */

export const KEY_BYTES = 32;
export const SALT_BYTES = 16;

export interface SyncKdfParams {
  /** CPU/内存成本，2 的幂。2^15 在手机上约 0.3–1s。 */
  N: number;
  r: number;
  p: number;
}

export const DEFAULT_SYNC_KDF_PARAMS: SyncKdfParams = { N: 32768, r: 8, p: 1 };

/** 口令弱于 8 位时，scrypt 也救不了；这是产品层的硬性阈值。 */
export const MIN_PASSPHRASE_LENGTH = 8;

export function generateVaultKey(): Uint8Array {
  return randomBytes(KEY_BYTES);
}

export function generateSalt(): Uint8Array {
  return randomBytes(SALT_BYTES);
}

/**
 * 从一个高熵口令派生同步密钥。故意不做任何「口令强度」的静默修补：
 * 弱口令应当在 UI 上被拒绝，而不是在这里被悄悄变成别的东西。
 */
export async function deriveSyncKey(
  passphrase: string,
  salt: Uint8Array,
  params: SyncKdfParams = DEFAULT_SYNC_KDF_PARAMS,
): Promise<Uint8Array> {
  if (passphrase.length < MIN_PASSPHRASE_LENGTH) {
    throw new Error(`同步口令至少需要 ${MIN_PASSPHRASE_LENGTH} 个字符`);
  }
  if (salt.length !== SALT_BYTES) {
    throw new Error(`salt 长度必须是 ${SALT_BYTES} 字节`);
  }
  return scryptAsync(new TextEncoder().encode(passphrase.normalize('NFKC')), salt, {
    N: params.N,
    r: params.r,
    p: params.p,
    dkLen: KEY_BYTES,
  });
}

/**
 * 口令强度的一个轻量评分，只用于 UI 提示，不参与密钥派生。
 * 返回 0–4，>=2 才允许启用同步。
 */
export function estimatePassphraseStrength(passphrase: string): number {
  if (passphrase.length < MIN_PASSPHRASE_LENGTH) return 0;
  let score = 1; // 达到最小长度先给 1 分
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((re) => re.test(passphrase)).length;
  if (passphrase.length >= 12) score += 1;
  if (classes >= 2) score += 1;
  if (classes >= 3) score += 1;
  return Math.min(4, score);
}

/** 序列化 KDF 参数与 salt，写进同步仓库的公开元数据。 */
export interface StoredKdfConfig {
  algorithm: 'scrypt';
  salt: string; // base64
  N: number;
  r: number;
  p: number;
}

export function toStoredKdfConfig(salt: Uint8Array, params: SyncKdfParams = DEFAULT_SYNC_KDF_PARAMS): StoredKdfConfig {
  return { algorithm: 'scrypt', salt: bytesToBase64(salt), N: params.N, r: params.r, p: params.p };
}

export function fromStoredKdfConfig(config: StoredKdfConfig): { salt: Uint8Array; params: SyncKdfParams } {
  if (config.algorithm !== 'scrypt') throw new Error(`不支持的 KDF: ${config.algorithm}`);
  return {
    salt: base64ToBytes(config.salt),
    params: { N: config.N, r: config.r, p: config.p },
  };
}
