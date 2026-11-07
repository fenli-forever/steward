import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import {
  base64ToBytes,
  bytesToBase64,
  bytesToUtf8,
  utf8ToBytes,
} from './encoding.js';

/**
 * XChaCha20-Poly1305 封装：24 字节随机 nonce + 认证密文。
 *
 * 选 XChaCha 而不是 AES-GCM 的原因：24 字节 nonce 意味着可以放心地
 * 对每条记录随机生成 nonce，不需要像 GCM 那样担心 96 位 nonce 的碰撞界。
 *
 * AAD 用来把密文「绑定」到它所属的记录上：如果有人把 A 记录的密文
 * 挪到 B 记录的位置，解密会直接失败，而不是悄悄解出别人的数据。
 */

export interface SealedData {
  /** 算法版本，为将来换算法留出迁移路径。 */
  v: 1;
  nonce: string; // base64
  ciphertext: string; // base64
}

const NONCE_BYTES = 24;

export function seal(key: Uint8Array, plaintext: Uint8Array, aad?: string): SealedData {
  if (key.length !== 32) throw new Error('密钥必须是 32 字节');
  const nonce = new Uint8Array(NONCE_BYTES);
  globalThis.crypto.getRandomValues(nonce);
  const cipher = xchacha20poly1305(key, nonce, aad ? utf8ToBytes(aad) : undefined);
  const ciphertext = cipher.encrypt(plaintext);
  return {
    v: 1,
    nonce: bytesToBase64(nonce),
    ciphertext: bytesToBase64(ciphertext),
  };
}

export function open(key: Uint8Array, sealed: SealedData, aad?: string): Uint8Array {
  if (sealed.v !== 1) throw new Error(`不支持的密文版本: ${sealed.v}`);
  const nonce = base64ToBytes(sealed.nonce);
  if (nonce.length !== NONCE_BYTES) throw new Error('nonce 长度非法');
  const cipher = xchacha20poly1305(key, nonce, aad ? utf8ToBytes(aad) : undefined);
  // 认证失败会抛异常，调用方不应吞掉它
  return cipher.decrypt(base64ToBytes(sealed.ciphertext));
}

export function sealJson<T>(key: Uint8Array, value: T, aad?: string): SealedData {
  return seal(key, utf8ToBytes(JSON.stringify(value)), aad);
}

export function openJson<T>(key: Uint8Array, sealed: SealedData, aad?: string): T {
  const bytes = open(key, sealed, aad);
  return JSON.parse(bytesToUtf8(bytes)) as T;
}

/** 把记录集合与 ID 绑定为 AAD，防止密文在记录之间被调包。 */
export function recordAad(collection: string, id: string): string {
  return `steward:${collection}:${id}`;
}
