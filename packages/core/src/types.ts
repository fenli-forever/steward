/**
 * Steward 领域模型。
 *
 * 设计约束（详见 docs/03-security.md）：
 * 1. 这里的所有实体都是「可同步的元数据」，不含任何密码、CVV、AK/SK 明文；
 *    凭据只以 `secretRef` 的形式存在，真实密文留在设备本地钥匙串里。
 * 2. 每个实体都有稳定的 `id`，可跨设备合并；时间统一用 ISO 8601 字符串。
 * 3. 金额一律用「最小货币单位」的整数（分）表示，禁止用浮点数存钱。
 */

/** RFC 3339 时间戳，例如 2026-11-07T09:30:00.000Z */
export type ISODateTime = string;

/** 仅日期，例如 2026-11-07 */
export type ISODate = string;

export const CURRENCIES = ['CNY', 'USD', 'HKD', 'EUR', 'JPY', 'GBP', 'SGD'] as const;
export type Currency = (typeof CURRENCIES)[number];

/** 本地实体通用字段；`updatedAt` 由仓储层负责维护。 */
export interface Entity {
  id: string;
  updatedAt: ISODateTime;
}

/* ------------------------------------------------------------------ */
/* 卡包：借记卡 / 信用卡                                                */
/* ------------------------------------------------------------------ */

export type CardKind = 'debit' | 'credit';
export type CardNetwork = 'unionpay' | 'visa' | 'mastercard' | 'amex' | 'jcb' | 'other';

export interface Card extends Entity {
  kind: CardKind;
  /** 发卡行，例如「招商银行」。 */
  issuer: string;
  network: CardNetwork;
  /** 用户自定义别名，例如「工资卡」。 */
  nickname: string;
  /** 卡号末四位，用于人工识别；完整卡号永不明文存储。 */
  last4: string;
  currency: Currency;
  /** 仅信用卡：授信额度（分）。 */
  creditLimitMinor?: number;
  /** 仅信用卡：账单日（1-28），避免月末日期歧义。 */
  billingDay?: number;
  /** 仅信用卡：还款日（1-28）。 */
  dueDay?: number;
  openedAt?: ISODate;
  expiresAt?: ISODate;
  /** 归档后不再出现在默认列表，但保留历史数据。 */
  archived?: boolean;
  /** 指向本地钥匙串中的凭据条目，永远不会离开设备。 */
  secretRef?: string;
  /**
   * 当前余额（分），仅借记卡有意义。
   * 来源可以是手动记账，也可能是用户主动开启的余额同步；为空表示未维护。
   */
  balanceMinor?: number;
  balanceUpdatedAt?: ISODateTime;
}

export type StatementLineDirection = 'debit' | 'credit';

export interface StatementLine {
  id: string;
  postedAt: ISODate;
  merchant: string;
  /** 恒为正数，方向由 `direction` 表达。 */
  amountMinor: number;
  currency: Currency;
  direction: StatementLineDirection;
  category?: string;
  note?: string;
}

export interface Statement extends Entity {
  cardId: string;
  periodStart: ISODate;
  periodEnd: ISODate;
  dueDate: ISODate;
  currency: Currency;
  /** 本期应还金额（分）。 */
  totalAmountMinor: number;
  minimumPaymentMinor?: number;
  paidAmountMinor?: number;
  isPaid: boolean;
  lines: StatementLine[];
}

/* ------------------------------------------------------------------ */
/* 多云主机                                                             */
/* ------------------------------------------------------------------ */

export const CLOUD_PROVIDERS = ['aliyun', 'tencent', 'aws', 'azure', 'huawei', 'volcengine'] as const;
export type CloudProviderId = (typeof CLOUD_PROVIDERS)[number];

export interface CloudAccount extends Entity {
  provider: CloudProviderId;
  alias: string;
  /** 云厂商侧的账号 ID，仅用于展示与对账。 */
  accountId?: string;
  /** 指向本地钥匙串中的 AK/SK 条目，永不同步。 */
  secretRef: string;
  regions: string[];
  lastSyncedAt?: ISODateTime;
  /** 最近一次同步失败的原因，用于界面提示。 */
  lastSyncError?: string;
}

export type HostStatus =
  | 'running'
  | 'stopped'
  | 'starting'
  | 'stopping'
  | 'rebooting'
  | 'error'
  | 'unknown';

export interface HostSpec {
  cpuCores: number;
  memoryMb: number;
  diskGb: number;
  /** 云厂商的规格名，例如 ecs.g7.large、t3.medium。 */
  instanceType?: string;
}

export interface Host {
  /** 主键：`${cloudAccountId}/${instanceId}`，保证多账号同名实例不冲突。 */
  id: string;
  cloudAccountId: string;
  provider: CloudProviderId;
  instanceId: string;
  name: string;
  region: string;
  zone?: string;
  status: HostStatus;
  spec: HostSpec;
  publicIps: string[];
  privateIp?: string;
  os?: string;
  createdAt?: ISODateTime;
  /** 包年包月到期时间；按量付费为空。 */
  expiresAt?: ISODateTime;
  /** 预估月成本（分）；按量付费为最近 30 天估算值。 */
  monthlyCostMinor?: number;
  currency?: Currency;
  tags?: Record<string, string>;
  updatedAt: ISODateTime;
}

export interface HostAction {
  hostId: string;
  action: 'start' | 'stop' | 'reboot';
  requestedAt: ISODateTime;
}

/* ------------------------------------------------------------------ */
/* 智能家居（v2，占位定义保证数据模型向前兼容）                           */
/* ------------------------------------------------------------------ */

export const SMART_HOME_HUBS = ['home_assistant', 'matter', 'apple_home', 'mi_home', 'tuya'] as const;
export type SmartHomeHubKind = (typeof SMART_HOME_HUBS)[number];

export interface SmartHomeHub extends Entity {
  kind: SmartHomeHubKind;
  name: string;
  /** 局域网地址或云端地址；不包含 access token。 */
  endpoint?: string;
  secretRef?: string;
  deviceCount?: number;
  lastSyncedAt?: ISODateTime;
}

/* ------------------------------------------------------------------ */
/* 用户与设备                                                           */
/* ------------------------------------------------------------------ */

export interface Device extends Entity {
  name: string;
  platform: 'macos' | 'windows' | 'linux' | 'ios' | 'android' | 'web';
  /** 最后一次与本机同步成功的时间。 */
  lastSeenAt?: ISODateTime;
}

/** 客户端展示用的聚合视图，不落库。 */
export interface DashboardSnapshot {
  totalAssetsMinor: number;
  currency: Currency;
  creditUsedMinor: number;
  creditLimitMinor: number;
  hostsRunning: number;
  hostsTotal: number;
  monthlyCloudCostMinor: number;
  upcomingDue: Statement[];
  expiringHosts: Host[];
}
