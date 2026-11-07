import { parseAmountMinor, MINOR_UNIT_DIGITS } from '../money.js';
import type { Currency, ISODate, StatementLineDirection } from '../types.js';

/**
 * 银行/支付平台导出的 CSV 解析。
 *
 * 现实约束：国内没有面向个人的开放银行接口，账单只能靠用户手动导出再解析。
 * 因此这个模块的第一原则是 **不要抛异常** —— 一行解析失败不能毁掉整份账单，
 * 必须把问题行原样回传给用户，让他能手工补录或反馈格式。
 */

export interface ParsedStatementLine {
  postedAt: ISODate;
  merchant: string;
  amountMinor: number;
  currency: Currency;
  direction: StatementLineDirection;
  note?: string;
}

export interface ImportIssue {
  /** 源文件中的 1-based 行号，方便用户定位。 */
  line: number;
  raw: string;
  reason: string;
}

export interface ImportResult {
  lines: ParsedStatementLine[];
  issues: ImportIssue[];
  meta: {
    delimiter: string;
    rowCount: number;
    currency: Currency;
    cardLast4?: string;
    /** 表头识别到的列，便于 UI 展示「我们读到了什么」。 */
    columns: Partial<Record<ColumnRole, string>>;
  };
}

export type ColumnRole =
  | 'date'
  | 'merchant'
  | 'amount'
  | 'debit'
  | 'credit'
  | 'currency'
  | 'type'
  | 'card'
  | 'note';

const HEADER_ALIASES: Record<ColumnRole, string[]> = {
  date: ['交易日期', '记账日期', '交易日', '交易时间', '日期', '入账日期', 'date', 'transaction date'],
  merchant: ['交易摘要', '摘要', '交易描述', '商户名称', '商户', '对方户名', '用途', 'description', 'merchant', 'payee'],
  amount: ['人民币金额', '交易金额', '金额', '发生额', 'amount', '交易额'],
  debit: ['支出金额', '支出', '借方金额', '借方发生额', 'debit'],
  credit: ['收入金额', '收入', '贷方金额', '贷方发生额', '存入金额', 'credit'],
  currency: ['币种', '货币', '交易币种', 'currency'],
  type: ['交易类型', '交易种类', '业务类型', 'type', '收支'],
  card: ['卡号末四位', '卡号后四位', '卡号', 'card number', 'card'],
  note: ['备注', '附言', 'note', 'memo'],
};

/** 表头里出现这些词说明是汇总行，直接跳过而不是报错。 */
const SUMMARY_PREFIXES = ['合计', '总计', '小计', '本期应还', 'total'];

const CURRENCY_HINTS: Record<string, Currency> = {
  CNY: 'CNY',
  人民币: 'CNY',
  RMB: 'CNY',
  USD: 'USD',
  美元: 'USD',
  HKD: 'HKD',
  港币: 'HKD',
  EUR: 'EUR',
  欧元: 'EUR',
  JPY: 'JPY',
  日元: 'JPY',
  GBP: 'GBP',
  英镑: 'GBP',
  SGD: 'SGD',
  新加坡元: 'SGD',
};

const CREDIT_HINTS = ['还款', '退款', '退货', '存入', '转入', '入账', '贷方', '溢缴款', 'refund', 'payment', 'credit'];
const DEBIT_HINTS = ['消费', '支出', '取现', '转出', '借方', '扣款', 'purchase', 'debit'];

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** 检测分隔符：看表头行里哪个候选字符最多，默认逗号。 */
export function detectDelimiter(text: string): string {
  const sample = text.split(/\r?\n/).filter((l) => l.trim() !== '').slice(0, 5).join('\n');
  const candidates = [',', ';', '\t', '|'];
  let best = ',';
  let bestCount = 0;
  for (const candidate of candidates) {
    const count = sample.split(candidate).length - 1;
    if (count > bestCount) {
      best = candidate;
      bestCount = count;
    }
  }
  return best;
}

/** RFC 4180 风格解析：支持引号包裹、字段内换行、双引号转义。 */
export function parseDelimited(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  const input = stripBom(text);

  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
    } else if (ch === delimiter) {
      row.push(field);
      field = '';
    } else if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (ch === '\r') {
      // 交给 \n 处理，单独的 \r 也不应产生空行
      if (input[i + 1] !== '\n') {
        row.push(field);
        rows.push(row);
        row = [];
        field = '';
      }
    } else {
      field += ch;
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((cell) => cell.trim() !== ''));
}

function normalizeHeader(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[\s()（）:：*]/g, '');
}

/**
 * 把表头映射到语义角色。
 *
 * 两轮匹配：先找完全相等的列，再做包含匹配。
 * 原因：「借方金额」里包含「金额」，如果只做包含匹配，会被通用金额列抢走，
 * 导致借贷方向丢失 —— 这是账单导入最容易出错的地方。
 */
export function mapColumns(headers: string[]): Partial<Record<ColumnRole, number>> {
  const normalized = headers.map(normalizeHeader);
  const mapping: Partial<Record<ColumnRole, number>> = {};
  const taken = new Set<number>();

  // 借贷两列比通用「金额」更具体，必须优先占位
  const roleOrder: ColumnRole[] = ['date', 'merchant', 'debit', 'credit', 'amount', 'currency', 'type', 'card', 'note'];

  for (const exact of [true, false]) {
    for (const role of roleOrder) {
      if (mapping[role] !== undefined) continue;
      for (const alias of HEADER_ALIASES[role]) {
        const needle = normalizeHeader(alias);
        const index = normalized.findIndex(
          (header, i) => !taken.has(i) && header !== '' && (exact ? header === needle : header.includes(needle)),
        );
        if (index >= 0) {
          mapping[role] = index;
          taken.add(index);
          break;
        }
      }
    }
  }
  return mapping;
}

function findHeaderRow(rows: string[][]): number {
  // 跳过银行加在文件顶部的说明行，最多找前 10 行
  for (let i = 0; i < Math.min(rows.length, 10); i++) {
    const mapping = mapColumns(rows[i]!);
    if (mapping.date !== undefined && (mapping.amount !== undefined || mapping.debit !== undefined || mapping.credit !== undefined)) {
      return i;
    }
  }
  return -1;
}

const DATE_PATTERNS: { re: RegExp; parse: (m: RegExpMatchArray) => [number, number, number] | null }[] = [
  { re: /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/, parse: (m) => [Number(m[1]), Number(m[2]), Number(m[3])] },
  { re: /^(\d{4})(\d{2})(\d{2})$/, parse: (m) => [Number(m[1]), Number(m[2]), Number(m[3])] },
  { re: /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})/, parse: (m) => [Number(m[3]), Number(m[1]), Number(m[2])] },
];

/** 把多种日期写法归一成 YYYY-MM-DD；非法日期返回 null（例如 2026-02-31）。 */
export function parseStatementDate(value: string): ISODate | null {
  const text = value.trim().replace(/[年月]/g, '-').replace(/日/g, '').replace(/\s+.*$/, '');
  for (const pattern of DATE_PATTERNS) {
    const match = text.match(pattern.re);
    if (!match) continue;
    const parts = pattern.parse(match);
    if (!parts) continue;
    const [year, month, day] = parts;
    if (month < 1 || month > 12 || day < 1 || day > 31) continue;
    const date = new Date(Date.UTC(year, month - 1, day));
    if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) continue;
    return `${year.toString().padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  }
  return null;
}

function detectCurrency(...values: (string | undefined)[]): Currency {
  for (const value of values) {
    if (!value) continue;
    const key = value.trim().toUpperCase();
    const hit = CURRENCY_HINTS[key];
    if (hit) return hit;
  }
  return 'CNY';
}

function directionFromType(type: string | undefined): StatementLineDirection | null {
  if (!type) return null;
  const text = type.toLowerCase();
  if (CREDIT_HINTS.some((h) => text.includes(h))) return 'credit';
  if (DEBIT_HINTS.some((h) => text.includes(h))) return 'debit';
  return null;
}

function extractLast4(card: string | undefined): string | undefined {
  if (!card) return undefined;
  const digits = card.replace(/\D/g, '');
  return digits.length >= 4 ? digits.slice(-4) : undefined;
}

function isSummaryRow(row: string[]): boolean {
  const first = (row[0] ?? '').trim().toLowerCase();
  return SUMMARY_PREFIXES.some((p) => first.startsWith(p));
}

export interface ParseOptions {
  /** 单金额列且无类型列时，正数默认算支出（信用卡账单的常见约定）。 */
  defaultDirection?: StatementLineDirection;
  /** 覆盖自动识别出的币种。 */
  currency?: Currency;
}

/**
 * 主入口。返回解析成功的行 + 失败行的诊断信息，永不抛异常。
 * 真正「不是账单」的判断交给调用方：如果 lines 为空且 issues 很多，就提示格式不支持。
 */
export function parseStatementCsv(text: string, options: ParseOptions = {}): ImportResult {
  const delimiter = detectDelimiter(text);
  const rows = parseDelimited(text, delimiter);
  const issues: ImportIssue[] = [];
  const lines: ParsedStatementLine[] = [];

  const headerIndex = findHeaderRow(rows);
  if (headerIndex < 0) {
    return {
      lines,
      issues: [{ line: 1, raw: (rows[0] ?? []).join(delimiter), reason: '未能识别表头（需要至少包含日期和金额列）' }],
      meta: { delimiter, rowCount: 0, currency: options.currency ?? 'CNY', columns: {} },
    };
  }

  const headers = rows[headerIndex]!;
  const columns = mapColumns(headers);
  let currencyOverride = options.currency;
  let cardLast4: string | undefined;

  for (let i = headerIndex + 1; i < rows.length; i++) {
    const row = rows[i]!;
    const line = i + 1; // 1-based，且 i 是 0-based 行索引
    if (isSummaryRow(row)) continue;

    const cell = (role: ColumnRole): string | undefined => {
      const index = columns[role];
      return index === undefined ? undefined : (row[index] ?? '').trim();
    };

    const postedAt = parseStatementDate(cell('date') ?? '');
    if (!postedAt) {
      issues.push({ line, raw: row.join(delimiter), reason: '日期无法解析' });
      continue;
    }

    const rowCurrency = currencyOverride ?? detectCurrency(cell('currency'));
    if (!currencyOverride) currencyOverride = rowCurrency;
    cardLast4 ??= extractLast4(cell('card'));

    let amountMinor: number | null = null;
    let direction: StatementLineDirection | null = null;

    const debitCell = cell('debit');
    const creditCell = cell('credit');
    if (debitCell) {
      amountMinor = parseAmountMinor(debitCell, rowCurrency);
      direction = 'debit';
    }
    if ((amountMinor === null || amountMinor === 0) && creditCell) {
      const credit = parseAmountMinor(creditCell, rowCurrency);
      if (credit !== null && credit !== 0) {
        amountMinor = Math.abs(credit);
        direction = 'credit';
      }
    }
    if (amountMinor === null) {
      const raw = cell('amount');
      const parsed = raw ? parseAmountMinor(raw, rowCurrency) : null;
      if (parsed !== null) {
        // 带符号金额：负号表示入账（还款/退款），正数表示支出
        if (parsed < 0) {
          direction = 'credit';
          amountMinor = Math.abs(parsed);
        } else {
          direction = 'debit';
          amountMinor = parsed;
        }
      }
    }
    if (amountMinor === null || amountMinor === 0) {
      issues.push({ line, raw: row.join(delimiter), reason: '金额为空或无法解析' });
      continue;
    }

    const typeDirection = directionFromType(cell('type'));
    if (typeDirection) direction = typeDirection;
    if (!direction) direction = options.defaultDirection ?? 'debit';
    if (rowCurrency === 'JPY') {
      // 日元没有小数位，parseAmountMinor 已按 0 位处理；这里仅做可读性兜底
      amountMinor = Math.round(amountMinor);
    }

    const merchant = cell('merchant') || cell('note') || '未标注商户';
    const note = cell('note');

    lines.push({
      postedAt,
      merchant,
      amountMinor: Math.abs(amountMinor),
      currency: rowCurrency ?? 'CNY',
      direction,
      ...(note ? { note } : {}),
    });
  }

  const columnNames: Partial<Record<ColumnRole, string>> = {};
  for (const [role, index] of Object.entries(columns) as [ColumnRole, number][]) {
    columnNames[role] = headers[index]!.trim();
  }

  return {
    lines,
    issues,
    meta: {
      delimiter,
      rowCount: rows.length - headerIndex - 1,
      currency: currencyOverride ?? 'CNY',
      ...(cardLast4 ? { cardLast4 } : {}),
      columns: columnNames,
    },
  };
}

/** 金额规模校验：挡住「把 1234.56 当成 123456 分」之外的常见错误，例如误读信用卡额度列。 */
export function suspiciousAmount(amountMinor: number, currency: Currency): boolean {
  const digits = MINOR_UNIT_DIGITS[currency];
  return amountMinor > 10 ** (digits + 9); // 十亿以上，大概率是解析错了
}
