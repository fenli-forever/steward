import { CURRENCIES, type Currency } from './types.js';

/**
 * 各币种的最小单位位数。JPY 没有小数位，必须单独处理，
 * 否则会出现 100 日元显示成 ¥1.00 这类事故。
 */
export const MINOR_UNIT_DIGITS: Record<Currency, number> = {
  CNY: 2,
  USD: 2,
  HKD: 2,
  EUR: 2,
  JPY: 0,
  GBP: 2,
  SGD: 2,
};

export function isCurrency(value: string): value is Currency {
  return (CURRENCIES as readonly string[]).includes(value);
}

export function assertCurrency(value: string): Currency {
  if (!isCurrency(value)) throw new Error(`Unsupported currency: ${value}`);
  return value;
}

/** 100.00 CNY -> 10000 */
export function toMinorUnits(amount: number, currency: Currency): number {
  const digits = MINOR_UNIT_DIGITS[currency];
  return Math.round(amount * 10 ** digits);
}

/** 10000 -> 100 */
export function fromMinorUnits(amountMinor: number, currency: Currency): number {
  return amountMinor / 10 ** MINOR_UNIT_DIGITS[currency];
}

const CLEANUP = /[\s\u00a0,\u3000]/g;
const SYMBOLS = /[¥￥$€£]|CNY|RMB|USD|HKD|EUR|JPY|GBP|SGD/gi;

/**
 * 解析人类/银行导出的金额字符串。支持：
 * `1,234.56`、`¥1,234.56`、`-12.00`、`12.00-`、`(12.00)`（会计负数）、全角字符。
 * 返回最小单位的整数；无法解析时返回 null，由调用方决定如何处理。
 */
export function parseAmountMinor(input: string, currency: Currency): number | null {
  if (typeof input !== 'string') return null;
  let text = input.trim();
  if (text === '') return null;

  // 全角数字/标点归一化（银行导出的文件里很常见）
  text = text.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
  text = text
    .replace(/[．。]/g, '.')
    .replace(/[（]/g, '(')
    .replace(/[）]/g, ')')
    // U+2212 减号、全角连字符、长短破折号都当作负号
    .replace(/[−－–—]/g, '-');

  let negative = false;
  if (/^\(.*\)$/.test(text)) {
    negative = true;
    text = text.slice(1, -1);
  }
  if (text.endsWith('-')) {
    negative = true;
    text = text.slice(0, -1);
  }
  text = text.replace(SYMBOLS, '').replace(CLEANUP, '');
  if (text.startsWith('-')) {
    negative = true;
    text = text.slice(1);
  } else if (text.startsWith('+')) {
    text = text.slice(1);
  }
  if (!/^\d*(\.\d+)?$/.test(text) || text === '' || text === '.') return null;

  const value = Number(text);
  if (!Number.isFinite(value)) return null;
  const minor = toMinorUnits(value, currency);
  return negative ? -minor : minor;
}

/** 解析结果带上币种，便于跨币种场景传递。 */
export interface Money {
  amountMinor: number;
  currency: Currency;
}

export function parseMoney(input: string, currency: Currency): Money | null {
  const amountMinor = parseAmountMinor(input, currency);
  return amountMinor === null ? null : { amountMinor, currency };
}

const formatters = new Map<string, Intl.NumberFormat>();

export interface FormatOptions {
  /** 是否显示正负号，默认 true。 */
  signed?: boolean;
  locale?: string;
  /** 是否使用紧凑写法（1.2万）。 */
  compact?: boolean;
}

export function formatMoney(
  amountMinor: number,
  currency: Currency,
  options: FormatOptions = {},
): string {
  const digits = MINOR_UNIT_DIGITS[currency];
  const locale = options.locale ?? 'zh-CN';
  const key = `${locale}|${currency}|${digits}|${options.compact ? 'c' : 'n'}`;
  let formatter = formatters.get(key);
  if (!formatter) {
    formatter = new Intl.NumberFormat(locale, {
      style: 'currency',
      currency,
      currencyDisplay: 'narrowSymbol',
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
      ...(options.compact ? { notation: 'compact' as const } : {}),
    });
    formatters.set(key, formatter);
  }
  const value = fromMinorUnits(amountMinor, currency);
  const text = formatter.format(value);
  if (options.signed !== false && value > 0) return `+${text}`;
  return text;
}

/** 同币种相减；跨币种直接抛错，强制调用方显式做汇率换算。 */
export function subtractMoney(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return { amountMinor: a.amountMinor - b.amountMinor, currency: a.currency };
}

export function addMoney(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return { amountMinor: a.amountMinor + b.amountMinor, currency: a.currency };
}

export function assertSameCurrency(a: Money, b: Money): void {
  if (a.currency !== b.currency) {
    throw new Error(`Currency mismatch: ${a.currency} vs ${b.currency}`);
  }
}

/**
 * 按币种汇总。混合币种时不做隐式换算，返回分币种的结果，
 * 由上层决定用哪天的汇率合并。
 */
export function groupByCurrency(items: { amountMinor: number; currency: Currency }[]): Map<Currency, number> {
  const totals = new Map<Currency, number>();
  for (const item of items) {
    totals.set(item.currency, (totals.get(item.currency) ?? 0) + item.amountMinor);
  }
  return totals;
}
