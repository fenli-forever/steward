/**
 * 可排序的 ID（ULID 风格）：前 10 位是毫秒时间戳的 Crockford Base32，
 * 后 16 位是 80 位随机数。
 *
 * 为什么不用 UUID v4：同步是按游标增量拉取的，时间有序的主键能让
 * 「新插入的记录」在索引和合并时更快，也更方便排障。
 */

const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford Base32，去掉 I L O U
const TIME_LEN = 10;
const RANDOM_LEN = 16;

function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  globalThis.crypto.getRandomValues(bytes);
  return bytes;
}

function encodeTime(now: number): string {
  if (now < 0 || now > 2 ** 48 - 1) throw new RangeError('Time out of range for id');
  let out = '';
  let remaining = now;
  for (let i = 0; i < TIME_LEN; i++) {
    const mod = remaining % 32;
    out = ENCODING[mod] + out;
    remaining = (remaining - mod) / 32;
  }
  return out;
}

function encodeRandom(): string {
  const bytes = randomBytes(RANDOM_LEN);
  let out = '';
  for (let i = 0; i < RANDOM_LEN; i++) {
    out += ENCODING[bytes[i]! % 32];
  }
  return out;
}

export function newId(): string {
  return encodeTime(Date.now()) + encodeRandom();
}

/**
 * 带业务前缀的 ID，例如 `card_01JC...`。
 * 前缀只用于可读性与调试，不参与排序。
 */
export function newPrefixedId(prefix: string): string {
  return `${prefix}_${newId()}`;
}

/** 校验 ULID 的字符集与长度，用于外部输入（导入、API）的防御性检查。 */
export function isValidId(value: string, prefix?: string): boolean {
  if (typeof value !== 'string') return false;
  const body = prefix ? value.slice(prefix.length + 1) : value;
  if (prefix && !value.startsWith(`${prefix}_`)) return false;
  if (body.length !== TIME_LEN + RANDOM_LEN) return false;
  for (const ch of body.toUpperCase()) {
    if (!ENCODING.includes(ch)) return false;
  }
  return true;
}
