import { describe, expect, it } from 'vitest';
import {
  detectDelimiter,
  mapColumns,
  parseDelimited,
  parseStatementCsv,
  parseStatementDate,
} from '../src/bills/csv.js';

describe('分隔符与 CSV 基础解析', () => {
  it('自动识别制表符', () => {
    const text = '交易日期\t交易摘要\t金额\n2026-10-01\t星巴克\t32.00';
    expect(detectDelimiter(text)).toBe('\t');
  });

  it('支持引号内的逗号与换行', () => {
    const text = 'a,b\n"x,1","line1\nline2"';
    expect(parseDelimited(text, ',')).toEqual([
      ['a', 'b'],
      ['x,1', 'line1\nline2'],
    ]);
  });

  it('去掉 BOM', () => {
    const text = '\uFEFF日期,金额\n2026-10-01,10';
    expect(parseDelimited(text, ',')[0]).toEqual(['日期', '金额']);
  });
});

describe('表头映射', () => {
  it('识别招商银行风格表头', () => {
    const mapping = mapColumns(['交易日期', '记账日期', '交易摘要', '人民币金额', '卡号末四位']);
    expect(mapping.date).toBe(0);
    expect(mapping.merchant).toBe(2);
    expect(mapping.amount).toBe(3);
    expect(mapping.card).toBe(4);
  });

  it('区分借方/贷方两列', () => {
    const mapping = mapColumns(['日期', '摘要', '借方金额', '贷方金额']);
    expect(mapping.debit).toBe(2);
    expect(mapping.credit).toBe(3);
  });
});

describe('日期解析', () => {
  it('支持多种写法', () => {
    expect(parseStatementDate('2026-10-01')).toBe('2026-10-01');
    expect(parseStatementDate('2026/1/5')).toBe('2026-01-05');
    expect(parseStatementDate('20261001')).toBe('2026-10-01');
    expect(parseStatementDate('10/01/2026')).toBe('2026-10-01');
    expect(parseStatementDate('2026年10月1日')).toBe('2026-10-01');
  });

  it('拒绝不存在的日期', () => {
    expect(parseStatementDate('2026-02-31')).toBeNull();
    expect(parseStatementDate('2026-13-01')).toBeNull();
  });
});

describe('账单导入', () => {
  const csv = [
    '交易日期,记账日期,交易摘要,人民币金额,卡号末四位',
    '2026-09-28,2026-09-29,星巴克咖啡,32.00,1234',
    '2026-09-29,2026-09-30,"京东商城, 电子",1299.00,1234',
    '2026-10-01,2026-10-02,还款,−2000.00,1234',
    '2026-10-02,2026-10-03,退款,50.00,1234',
    '2026-10-03,2026-10-04,网红餐厅,88.50,1234',
    '合计,,,4519.50,',
  ].join('\n');

  it('解析出所有明细并跳过合计行', () => {
    const result = parseStatementCsv(csv);
    expect(result.lines).toHaveLength(5);
    expect(result.lines[0]).toMatchObject({
      postedAt: '2026-09-28',
      merchant: '星巴克咖啡',
      amountMinor: 3200,
      currency: 'CNY',
      direction: 'debit',
    });
    expect(result.lines[1]?.merchant).toBe('京东商城, 电子');
    expect(result.meta.cardLast4).toBe('1234');
    expect(result.issues).toHaveLength(0);
  });

  it('负号金额识别为入账', () => {
    const result = parseStatementCsv(csv);
    const payment = result.lines.find((l) => l.merchant === '还款');
    expect(payment?.direction).toBe('credit');
    expect(payment?.amountMinor).toBe(200000);
  });

  it('单行失败不影响其他行，并给出原因', () => {
    const broken = ['日期,摘要,金额', '2026-10-01,正常,10.00', '不是日期,坏行,20.00', '2026-10-03,,30.00'].join('\n');
    const result = parseStatementCsv(broken);
    expect(result.lines).toHaveLength(2);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]).toMatchObject({ line: 3, reason: '日期无法解析' });
  });

  it('无表头时返回诊断信息而不是抛异常', () => {
    const result = parseStatementCsv('随便什么内容\n没有任何列');
    expect(result.lines).toHaveLength(0);
    expect(result.issues[0]?.reason).toContain('未能识别表头');
  });

  it('支出/收入两列时优先按列判断方向', () => {
    const text = ['交易时间,摘要,支出,收入', '2026-10-01,工资,,20000.00', '2026-10-02,房租,5000.00,'].join('\n');
    const result = parseStatementCsv(text);
    expect(result.lines.find((l) => l.merchant === '工资')?.direction).toBe('credit');
    expect(result.lines.find((l) => l.merchant === '房租')?.direction).toBe('debit');
    expect(result.lines.find((l) => l.merchant === '工资')?.amountMinor).toBe(2000000);
  });

  it('交易类型列覆盖金额符号的推断', () => {
    const text = ['日期,摘要,金额,交易类型', '2026-10-01,退货入账,100.00,退款'].join('\n');
    const result = parseStatementCsv(text);
    expect(result.lines[0]?.direction).toBe('credit');
  });
});
