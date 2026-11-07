import { describe, expect, it } from 'vitest';
import { buildDashboard, creditUtilization, daysUntilDue, nextDueDates } from '../src/dashboard.js';
import { summarizeHosts, MockCloudAdapter, daysUntil } from '../src/cloud/adapters.js';
import type { Card, Host, Statement } from '../src/types.js';

const NOW = Date.parse('2026-11-07T09:00:00.000Z');

const debitCard: Card = {
  id: 'card_debit',
  kind: 'debit',
  issuer: '招商银行',
  network: 'unionpay',
  nickname: '工资卡',
  last4: '1234',
  currency: 'CNY',
  balanceMinor: 800000,
  updatedAt: '2026-11-01T00:00:00.000Z',
};

const creditCard: Card = {
  id: 'card_credit',
  kind: 'credit',
  issuer: '中信银行',
  network: 'visa',
  nickname: '白金卡',
  last4: '8888',
  currency: 'CNY',
  creditLimitMinor: 5000000,
  billingDay: 5,
  dueDay: 25,
  updatedAt: '2026-11-01T00:00:00.000Z',
};

const statement: Statement = {
  id: 'stmt_1',
  cardId: 'card_credit',
  periodStart: '2026-10-05',
  periodEnd: '2026-11-04',
  dueDate: '2026-11-25',
  currency: 'CNY',
  totalAmountMinor: 1234500,
  isPaid: false,
  lines: [],
  updatedAt: '2026-11-05T00:00:00.000Z',
};

function host(overrides: Partial<Host> = {}): Host {
  return {
    id: 'acc/i-001',
    cloudAccountId: 'acc',
    provider: 'aliyun',
    instanceId: 'i-001',
    name: 'web-1',
    region: 'cn-hangzhou',
    status: 'running',
    spec: { cpuCores: 2, memoryMb: 4096, diskGb: 80 },
    publicIps: ['47.1.2.3'],
    monthlyCostMinor: 18600,
    currency: 'CNY',
    updatedAt: '2026-11-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('首页聚合', () => {
  it('汇总资产、信用额度与云成本', () => {
    const dashboard = buildDashboard({
      cards: [debitCard, creditCard],
      statements: [statement],
      hosts: [host(), host({ id: 'acc/i-002', status: 'stopped' })],
      now: NOW,
    });
    expect(dashboard.totalAssetsMinor).toBe(800000);
    expect(dashboard.creditUsedMinor).toBe(1234500);
    expect(dashboard.creditLimitMinor).toBe(5000000);
    expect(dashboard.hostsRunning).toBe(1);
    expect(dashboard.hostsTotal).toBe(2);
    expect(dashboard.monthlyCloudCostMinor).toBe(37200);
    expect(dashboard.upcomingDue).toHaveLength(1);
  });

  it('只统计主币种，避免混合币种静默相加', () => {
    const usdCard: Card = { ...debitCard, id: 'card_usd', currency: 'USD', balanceMinor: 100000 };
    const dashboard = buildDashboard({
      cards: [debitCard, usdCard],
      statements: [],
      hosts: [],
      now: NOW,
    });
    expect(dashboard.totalAssetsMinor).toBe(800000);
  });

  it('排除归档卡片', () => {
    const archived: Card = { ...debitCard, archived: true };
    const dashboard = buildDashboard({ cards: [archived], statements: [], hosts: [], now: NOW });
    expect(dashboard.totalAssetsMinor).toBe(0);
  });

  it('已还清的账单不计入待还', () => {
    const paid: Statement = { ...statement, isPaid: true };
    const dashboard = buildDashboard({ cards: [creditCard], statements: [paid], hosts: [], now: NOW });
    expect(dashboard.creditUsedMinor).toBe(0);
    expect(dashboard.upcomingDue).toHaveLength(0);
  });

  it('还款日距离计算含逾期', () => {
    expect(daysUntilDue('2026-11-25', NOW)).toBe(18);
    expect(daysUntilDue('2026-11-01', NOW)).toBe(-6);
  });

  it('额度为 0 时使用率返回 null 而不是 0', () => {
    expect(creditUtilization(100, 0)).toBeNull();
    expect(creditUtilization(100, 1000)).toBeCloseTo(0.1);
    expect(creditUtilization(2000, 1000)).toBe(1);
  });

  it('按账单日推算下个还款日', () => {
    const { billingDate, dueDate } = nextDueDates(5, 25, new Date('2026-11-07T00:00:00.000Z'));
    // 11 月 7 日已过 11 月 5 日的账单日，所以下一次是 12 月 5 日出账、12 月 25 日还款
    expect(billingDate).toBe('2026-12-05');
    expect(dueDate).toBe('2026-12-25');
  });
});

describe('多云聚合', () => {
  it('按状态与币种汇总，并找出即将到期的主机', () => {
    const soon = host({ id: 'acc/i-003', expiresAt: new Date(NOW + 5 * 86_400_000).toISOString() });
    const far = host({ id: 'acc/i-004', expiresAt: new Date(NOW + 200 * 86_400_000).toISOString() });
    const summary = summarizeHosts([host(), soon, far], NOW);
    expect(summary.total).toBe(3);
    expect(summary.byStatus.running).toBe(3);
    expect(summary.monthlyCostByCurrency.get('CNY')).toBe(55800);
    expect(summary.expiringSoon.map((h) => h.id)).toEqual(['acc/i-003']);
  });

  it('到期天数计算', () => {
    expect(daysUntil(new Date(NOW + 3 * 86_400_000).toISOString(), NOW)).toBe(3);
    expect(daysUntil(undefined, NOW)).toBeNull();
  });

  it('Mock 适配器对同一账号输出稳定（便于演示与测试）', async () => {
    const adapter = new MockCloudAdapter('aliyun', () => NOW);
    const creds = { accessKeyId: 'AKID-test', accessKeySecret: 'secret' };
    const first = await adapter.listHosts(creds, ['cn-hangzhou']);
    const second = await adapter.listHosts(creds, ['cn-hangzhou']);
    expect(first.data?.map((h) => h.instanceId)).toEqual(second.data?.map((h) => h.instanceId));
  });

  it('缺少凭据时返回错误而不是抛异常', async () => {
    const adapter = new MockCloudAdapter('aws');
    const result = await adapter.validateCredentials({ accessKeyId: '', accessKeySecret: '' });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('AccessKey');
  });

  it('关机操作改变后续查询的状态', async () => {
    const adapter = new MockCloudAdapter('tencent', () => NOW);
    const creds = { accessKeyId: 'AKID-test', accessKeySecret: 'secret' };
    const [target] = (await adapter.listHosts(creds, ['ap-guangzhou'])).data ?? [];
    expect(target).toBeDefined();
    await adapter.stopHost(creds, target!);
    const after = await adapter.listHosts(creds, ['ap-guangzhou']);
    expect(after.data?.find((h) => h.id === target!.id)?.status).toBe('stopped');
  });
});
