import type { Card, CloudAccount, Host, Statement } from '@steward/core';

/**
 * 首次启动的演示数据。
 *
 * 目的不是「好看的假数据」，而是让空状态之外的所有分支（逾期、即将到期、
 * 多币种、跨云）都能被点到，方便开发时验证 UI。
 * 用户点「清空演示数据」后这些会全部删除，不会被同步到服务器。
 */

const NOW = '2026-11-07T09:00:00.000Z';

export interface SeedData {
  cards: Card[];
  statements: Statement[];
  cloudAccounts: CloudAccount[];
  hosts: Host[];
}

export function createSeedData(): SeedData {
  const cards: Card[] = [
    {
      id: 'card_seed_debit_01',
      kind: 'debit',
      issuer: '招商银行',
      network: 'unionpay',
      nickname: '工资卡',
      last4: '1234',
      currency: 'CNY',
      balanceMinor: 8652000,
      balanceUpdatedAt: NOW,
      secretRef: 'secret_seed_debit_01',
      updatedAt: NOW,
    },
    {
      id: 'card_seed_credit_01',
      kind: 'credit',
      issuer: '中信银行',
      network: 'visa',
      nickname: '白金卡',
      last4: '8888',
      currency: 'CNY',
      creditLimitMinor: 5000000,
      billingDay: 5,
      dueDay: 25,
      expiresAt: '2029-08-31',
      secretRef: 'secret_seed_credit_01',
      updatedAt: NOW,
    },
  ];

  const statements: Statement[] = [
    {
      id: 'stmt_seed_2026_11',
      cardId: 'card_seed_credit_01',
      periodStart: '2026-10-05',
      periodEnd: '2026-11-04',
      dueDate: '2026-11-25',
      currency: 'CNY',
      totalAmountMinor: 1234500,
      minimumPaymentMinor: 123450,
      isPaid: false,
      lines: [
        { id: 'line_seed_1', postedAt: '2026-10-08', merchant: '星巴克咖啡', amountMinor: 3800, currency: 'CNY', direction: 'debit' },
        { id: 'line_seed_2', postedAt: '2026-10-11', merchant: '京东商城', amountMinor: 129900, currency: 'CNY', direction: 'debit' },
        { id: 'line_seed_3', postedAt: '2026-10-15', merchant: '中国移动', amountMinor: 19900, currency: 'CNY', direction: 'debit' },
        { id: 'line_seed_4', postedAt: '2026-10-20', merchant: 'Apple Store', amountMinor: 89900, currency: 'CNY', direction: 'debit' },
        { id: 'line_seed_5', postedAt: '2026-10-28', merchant: '还款', amountMinor: 500000, currency: 'CNY', direction: 'credit' },
        { id: 'line_seed_6', postedAt: '2026-11-02', merchant: '海底捞火锅', amountMinor: 68800, currency: 'CNY', direction: 'debit' },
      ],
      updatedAt: '2026-11-05T02:00:00.000Z',
    },
  ];

  const cloudAccounts: CloudAccount[] = [
    {
      id: 'cloud_seed_aliyun',
      provider: 'aliyun',
      alias: '阿里云 · 主账号',
      accountId: '1234****5678',
      secretRef: 'secret_seed_aliyun',
      regions: ['cn-hangzhou', 'cn-shanghai'],
      lastSyncedAt: '2026-11-07T08:40:00.000Z',
      updatedAt: NOW,
    },
    {
      id: 'cloud_seed_aws',
      provider: 'aws',
      alias: 'AWS · 东京',
      accountId: '1234-5678-9012',
      secretRef: 'secret_seed_aws',
      regions: ['ap-northeast-1'],
      lastSyncedAt: '2026-11-07T07:10:00.000Z',
      updatedAt: NOW,
    },
  ];

  const hosts: Host[] = [
    {
      id: 'cloud_seed_aliyun/i-8f2a0001',
      cloudAccountId: 'cloud_seed_aliyun',
      provider: 'aliyun',
      instanceId: 'i-8f2a0001',
      name: 'web-prod-1',
      region: 'cn-hangzhou',
      zone: 'cn-hangzhou-h',
      status: 'running',
      spec: { cpuCores: 2, memoryMb: 4096, diskGb: 80, instanceType: 'ecs.g7.large' },
      publicIps: ['47.96.12.34'],
      privateIp: '172.16.0.11',
      os: 'Ubuntu 24.04 LTS',
      createdAt: '2025-06-01T00:00:00.000Z',
      expiresAt: '2027-06-01T00:00:00.000Z',
      monthlyCostMinor: 18600,
      currency: 'CNY',
      tags: { env: 'prod', role: 'web' },
      updatedAt: NOW,
    },
    {
      id: 'cloud_seed_aliyun/i-8f2a0002',
      cloudAccountId: 'cloud_seed_aliyun',
      provider: 'aliyun',
      instanceId: 'i-8f2a0002',
      name: 'db-prod-1',
      region: 'cn-shanghai',
      zone: 'cn-shanghai-e',
      status: 'running',
      spec: { cpuCores: 4, memoryMb: 8192, diskGb: 200, instanceType: 'ecs.g7.xlarge' },
      publicIps: [],
      privateIp: '172.16.1.21',
      os: 'Debian 12',
      createdAt: '2025-03-14T00:00:00.000Z',
      expiresAt: '2026-11-28T00:00:00.000Z',
      monthlyCostMinor: 37200,
      currency: 'CNY',
      tags: { env: 'prod', role: 'db' },
      updatedAt: NOW,
    },
    {
      id: 'cloud_seed_aliyun/i-8f2a0003',
      cloudAccountId: 'cloud_seed_aliyun',
      provider: 'aliyun',
      instanceId: 'i-8f2a0003',
      name: 'ci-runner',
      region: 'cn-hangzhou',
      status: 'stopped',
      spec: { cpuCores: 8, memoryMb: 16384, diskGb: 120, instanceType: 'ecs.g7.2xlarge' },
      publicIps: ['47.96.55.201'],
      privateIp: '172.16.0.44',
      os: 'Ubuntu 24.04 LTS',
      monthlyCostMinor: 74400,
      currency: 'CNY',
      tags: { env: 'dev', role: 'ci' },
      updatedAt: NOW,
    },
    {
      id: 'cloud_seed_aws/i-0b7c0001',
      cloudAccountId: 'cloud_seed_aws',
      provider: 'aws',
      instanceId: 'i-0b7c0001',
      name: 'api-tokyo-1',
      region: 'ap-northeast-1',
      zone: 'ap-northeast-1a',
      status: 'running',
      spec: { cpuCores: 2, memoryMb: 4096, diskGb: 60, instanceType: 't3.medium' },
      publicIps: ['13.112.88.7'],
      privateIp: '10.0.1.15',
      os: 'Amazon Linux 2023',
      monthlyCostMinor: 24600,
      currency: 'CNY',
      tags: { env: 'prod', role: 'api' },
      updatedAt: NOW,
    },
  ];

  return { cards, statements, cloudAccounts, hosts };
}
