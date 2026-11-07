import { describe, expect, it } from 'vitest';
import {
  addMoney,
  formatMoney,
  fromMinorUnits,
  groupByCurrency,
  parseAmountMinor,
  parseMoney,
  subtractMoney,
  toMinorUnits,
} from '../src/money.js';

describe('金额转换', () => {
  it('人民币两位小数', () => {
    expect(toMinorUnits(1234.56, 'CNY')).toBe(123456);
    expect(fromMinorUnits(123456, 'CNY')).toBe(1234.56);
  });

  it('日元没有小数位', () => {
    expect(toMinorUnits(1200, 'JPY')).toBe(1200);
    expect(fromMinorUnits(1200, 'JPY')).toBe(1200);
  });

  it('避免浮点误差累积', () => {
    // 0.1 + 0.2 在浮点里是 0.30000000000000004
    expect(toMinorUnits(0.1 + 0.2, 'CNY')).toBe(30);
  });
});

describe('金额解析', () => {
  it('支持常见银行导出格式', () => {
    expect(parseAmountMinor('1,234.56', 'CNY')).toBe(123456);
    expect(parseAmountMinor('¥1,234.56', 'CNY')).toBe(123456);
    expect(parseAmountMinor('￥12.00', 'CNY')).toBe(1200);
    expect(parseAmountMinor(' 12.00 ', 'CNY')).toBe(1200);
  });

  it('识别负数写法', () => {
    expect(parseAmountMinor('-12.00', 'CNY')).toBe(-1200);
    expect(parseAmountMinor('(12.00)', 'CNY')).toBe(-1200);
    expect(parseAmountMinor('12.00-', 'CNY')).toBe(-1200);
  });

  it('归一化全角输入', () => {
    expect(parseAmountMinor('１２３．４５', 'CNY')).toBe(12345);
  });

  it('对无效输入返回 null 而不是抛错', () => {
    expect(parseAmountMinor('', 'CNY')).toBeNull();
    expect(parseAmountMinor('无', 'CNY')).toBeNull();
    expect(parseAmountMinor('1.2.3', 'CNY')).toBeNull();
  });

  it('保留币种信息', () => {
    expect(parseMoney('$20', 'USD')).toEqual({ amountMinor: 2000, currency: 'USD' });
  });
});

describe('格式化与运算', () => {
  it('按币种格式化', () => {
    expect(formatMoney(123456, 'CNY', { signed: false })).toContain('1,234.56');
    expect(formatMoney(1200, 'JPY', { signed: false })).toContain('1,200');
  });

  it('同币种加减', () => {
    const a = { amountMinor: 1000, currency: 'CNY' as const };
    const b = { amountMinor: 300, currency: 'CNY' as const };
    expect(subtractMoney(a, b)).toEqual({ amountMinor: 700, currency: 'CNY' });
    expect(addMoney(a, b)).toEqual({ amountMinor: 1300, currency: 'CNY' });
  });

  it('跨币种直接报错，避免静默算错钱', () => {
    const cny = { amountMinor: 1000, currency: 'CNY' as const };
    const usd = { amountMinor: 1000, currency: 'USD' as const };
    expect(() => addMoney(cny, usd)).toThrow(/Currency mismatch/);
  });

  it('按币种分组汇总', () => {
    const totals = groupByCurrency([
      { amountMinor: 100, currency: 'CNY' },
      { amountMinor: 200, currency: 'CNY' },
      { amountMinor: 500, currency: 'USD' },
    ]);
    expect(totals.get('CNY')).toBe(300);
    expect(totals.get('USD')).toBe(500);
  });
});
