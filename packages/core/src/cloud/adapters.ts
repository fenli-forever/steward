import type {
  CloudAccount,
  CloudProviderId,
  Currency,
  Host,
  HostStatus,
  ISODateTime,
} from '../types.js';

/**
 * 多云适配层。
 *
 * 关键设计：**事件与凭据都在本地**。AK/SK 从系统钥匙串读出，
 * 只在本机内存里参与签名，绝不经过同步服务器。
 *
 * 第一个可用实现是 MockCloudAdapter（确定性地造假数据），
 * 让 UI 和多云汇总逻辑可以脱离真实账号先跑通；真实适配器
 * （阿里云 ECS / 腾讯云 CVM / AWS EC2）在 v1 接入，见 docs/04-roadmap.md。
 */

export interface ProviderCredentials {
  accessKeyId: string;
  accessKeySecret: string;
  /** 部分厂商需要 STS token。 */
  sessionToken?: string;
  /** 账号级默认地域。 */
  region?: string;
}

export interface ProviderResult<T> {
  ok: boolean;
  data?: T;
  error?: string;
  /** 云厂商的请求 ID，排障时非常有用。 */
  requestId?: string;
}

export interface CloudProviderAdapter {
  readonly provider: CloudProviderId;
  /** 只读探测凭据是否有效，用于「测试连接」。 */
  validateCredentials(credentials: ProviderCredentials): Promise<ProviderResult<{ accountId?: string }>>;
  listHosts(credentials: ProviderCredentials, regions: string[]): Promise<ProviderResult<Host[]>>;
  startHost(credentials: ProviderCredentials, host: Host): Promise<ProviderResult<void>>;
  stopHost(credentials: ProviderCredentials, host: Host): Promise<ProviderResult<void>>;
  rebootHost(credentials: ProviderCredentials, host: Host): Promise<ProviderResult<void>>;
}

/* ------------------------------------------------------------------ */
/* 确定性 Mock 适配器                                                   */
/* ------------------------------------------------------------------ */

function hashSeed(input: string): number {
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const MOCK_REGIONS: Record<CloudProviderId, string[]> = {
  aliyun: ['cn-hangzhou', 'cn-shanghai', 'cn-beijing', 'ap-southeast-1'],
  tencent: ['ap-guangzhou', 'ap-shanghai', 'ap-beijing', 'ap-hongkong'],
  aws: ['us-east-1', 'ap-northeast-1', 'ap-southeast-1', 'eu-west-1'],
  azure: ['eastasia', 'southeastasia', 'japaneast'],
  huawei: ['cn-north-4', 'cn-east-3', 'ap-southeast-1'],
  volcengine: ['cn-beijing', 'cn-shanghai', 'cn-guangzhou'],
};

const SPECS = [
  { cpuCores: 1, memoryMb: 1024, diskGb: 40, instanceType: 'ecs.t6-c1m1.large', monthlyCostMinor: 4200 },
  { cpuCores: 2, memoryMb: 4096, diskGb: 80, instanceType: 'ecs.g7.large', monthlyCostMinor: 18600 },
  { cpuCores: 4, memoryMb: 8192, diskGb: 160, instanceType: 'ecs.g7.xlarge', monthlyCostMinor: 37200 },
  { cpuCores: 8, memoryMb: 16384, diskGb: 320, instanceType: 'ecs.g7.2xlarge', monthlyCostMinor: 74400 },
];

const ROLE_NAMES = ['web', 'api', 'db', 'cache', 'ci', 'proxy'];

/** 用账号 ID 做种子，保证同一账号每次列出的主机一致（便于测试与演示）。 */
export class MockCloudAdapter implements CloudProviderAdapter {
  private readonly overrides = new Map<string, HostStatus>();

  constructor(
    readonly provider: CloudProviderId,
    private readonly now: () => number = Date.now,
  ) {}

  async validateCredentials(credentials: ProviderCredentials): Promise<ProviderResult<{ accountId?: string }>> {
    if (!credentials.accessKeyId || !credentials.accessKeySecret) {
      return { ok: false, error: '缺少 AccessKeyId 或 AccessKeySecret' };
    }
    return { ok: true, data: { accountId: `mock-${hashSeed(credentials.accessKeyId).toString(16)}` } };
  }

  async listHosts(credentials: ProviderCredentials, regions: string[]): Promise<ProviderResult<Host[]>> {
    const validation = await this.validateCredentials(credentials);
    if (!validation.ok) return { ok: false, error: validation.error };

    const seed = hashSeed(`${this.provider}:${credentials.accessKeyId}`);
    const rand = mulberry32(seed);
    const effectiveRegions = regions.length > 0 ? regions : MOCK_REGIONS[this.provider];
    const count = 2 + Math.floor(rand() * 4);
    const hosts: Host[] = [];

    for (let i = 0; i < count; i++) {
      const region = effectiveRegions[Math.floor(rand() * effectiveRegions.length)] ?? effectiveRegions[0]!;
      const spec = SPECS[Math.floor(rand() * SPECS.length)]!;
      const role = ROLE_NAMES[Math.floor(rand() * ROLE_NAMES.length)]!;
      const instanceId = `i-${(seed % 0xffff).toString(16).padStart(4, '0')}${i.toString(16).padStart(4, '0')}`;
      const accountId = credentials.accessKeyId;
      const id = `${accountId}/${instanceId}`;
      const uptimeDays = Math.floor(rand() * 400);
      const status = this.overrides.get(id) ?? (rand() > 0.25 ? 'running' : 'stopped');

      hosts.push({
        id,
        cloudAccountId: accountId,
        provider: this.provider,
        instanceId,
        name: `${role}-${region}-${i + 1}`,
        region,
        zone: `${region}-${'abc'[Math.floor(rand() * 3)]}`,
        status,
        spec,
        publicIps: [`47.${Math.floor(rand() * 255)}.${Math.floor(rand() * 255)}.${Math.floor(rand() * 254) + 1}`],
        privateIp: `172.16.${Math.floor(rand() * 255)}.${Math.floor(rand() * 254) + 1}`,
        os: rand() > 0.5 ? 'Ubuntu 24.04 LTS' : 'Debian 12',
        createdAt: new Date(this.now() - uptimeDays * 86_400_000).toISOString(),
        expiresAt: new Date(this.now() + (30 - uptimeDays) * 86_400_000).toISOString(),
        monthlyCostMinor: spec.monthlyCostMinor,
        currency: 'CNY',
        tags: { env: rand() > 0.5 ? 'prod' : 'dev', owner: 'me' },
        updatedAt: new Date(this.now()).toISOString(),
      });
    }
    return { ok: true, data: hosts };
  }

  async startHost(_credentials: ProviderCredentials, host: Host): Promise<ProviderResult<void>> {
    this.overrides.set(host.id, 'running');
    return { ok: true };
  }

  async stopHost(_credentials: ProviderCredentials, host: Host): Promise<ProviderResult<void>> {
    this.overrides.set(host.id, 'stopped');
    return { ok: true };
  }

  async rebootHost(_credentials: ProviderCredentials, host: Host): Promise<ProviderResult<void>> {
    this.overrides.set(host.id, 'running');
    return { ok: true };
  }
}

/**
 * 适配器工厂。v1 在这里注册真实实现：
 *   aliyun → @alicloud/ecs20140526（或 Rust 侧 SDK，见 docs/02-architecture.md）
 *   tencent → tencentcloud-sdk-nodejs
 *   aws → @aws-sdk/client-ec2
 */
export function createCloudAdapter(provider: CloudProviderId): CloudProviderAdapter {
  return new MockCloudAdapter(provider);
}

/* ------------------------------------------------------------------ */
/* 聚合                                                                */
/* ------------------------------------------------------------------ */

export interface HostSummary {
  total: number;
  byStatus: Record<HostStatus, number>;
  monthlyCostByCurrency: Map<Currency, number>;
  /** 30 天内到期的包年包月主机。 */
  expiringSoon: Host[];
}

export function summarizeHosts(hosts: Host[], now: number = Date.now(), withinDays = 30): HostSummary {
  const byStatus = {
    running: 0,
    stopped: 0,
    starting: 0,
    stopping: 0,
    rebooting: 0,
    error: 0,
    unknown: 0,
  } satisfies Record<HostStatus, number>;

  const monthlyCostByCurrency = new Map<Currency, number>();
  const expiringSoon: Host[] = [];

  for (const host of hosts) {
    byStatus[host.status] = (byStatus[host.status] ?? 0) + 1;
    if (host.monthlyCostMinor && host.currency) {
      monthlyCostByCurrency.set(host.currency, (monthlyCostByCurrency.get(host.currency) ?? 0) + host.monthlyCostMinor);
    }
    if (host.expiresAt) {
      const remaining = Date.parse(host.expiresAt) - now;
      if (remaining > 0 && remaining <= withinDays * 86_400_000) expiringSoon.push(host);
    }
  }

  expiringSoon.sort((a, b) => Date.parse(a.expiresAt ?? '') - Date.parse(b.expiresAt ?? ''));
  return { total: hosts.length, byStatus, monthlyCostByCurrency, expiringSoon };
}

export function daysUntil(iso: string | undefined, now: number = Date.now()): number | null {
  if (!iso) return null;
  const delta = Date.parse(iso) - now;
  if (Number.isNaN(delta)) return null;
  return Math.ceil(delta / 86_400_000);
}

export function hostDisplayName(host: Host): string {
  return host.name || host.instanceId;
}

export function lastSeenLabel(account: CloudAccount, now: number = Date.now()): string {
  if (!account.lastSyncedAt) return '从未同步';
  const diff = now - Date.parse(account.lastSyncedAt);
  if (Number.isNaN(diff)) return '时间未知';
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.floor(hours / 24)} 天前`;
}

export function toIsoNow(now: number = Date.now()): ISODateTime {
  return new Date(now).toISOString();
}
