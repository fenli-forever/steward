import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * 认证模型（单用户自托管）：
 *
 * - 管理员令牌（STEWARD_ADMIN_TOKEN）：只用于建库、签发配对码。不参与日常同步。
 * - 配对码：一次性、默认 10 分钟有效、只能换一次设备令牌。
 * - 设备令牌：长期有效，服务端只存哈希；泄漏后可单独吊销。
 *
 * 所有令牌都不落日志、不进数据库明文。
 */

export const PAIRING_TOKEN_TTL_MS = 10 * 60 * 1000;

export function newToken(prefix: string): string {
  return `${prefix}_${randomBytes(32).toString('base64url')}`;
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** 常数时间比较两个哈希值，避免通过响应时间猜令牌。 */
export function safeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
  } catch {
    return false;
  }
}

export function bearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1] ?? null;
}
