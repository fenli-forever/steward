import { invoke } from '@tauri-apps/api/core';
import type { CloudProviderId, Host, HostStatus } from '@steward/core';

/**
 * 云厂商真实 API 的前端封装。
 *
 * 真正的签名与 HTTP 请求都在 Rust 侧完成（`src-tauri/src/cloud/`），
 * 这里只负责：
 *   1. 把钥匙串里读出来的凭据传过去；
 *   2. 把 Rust 返回的标准化结构映射成 `@steward/core` 的 `Host`。
 *
 * 目前真正对接的是阿里云 ECS 与 AWS EC2；其余厂商仍走 Mock。
 */

export interface CloudCredentials {
  accessKeyId: string;
  accessKeySecret: string;
  sessionToken?: string;
}

/** Rust 侧 `CloudHost` 的 camelCase 结构 */
interface RawCloudHost {
  instanceId: string;
  name: string;
  region: string;
  zone: string;
  status: string;
  instanceType: string;
  cpu: number;
  memoryMb: number;
  publicIps: string[];
  privateIp?: string;
  os?: string;
  createdAt?: string;
  expiresAt?: string;
}

const REAL_PROVIDERS: ReadonlySet<CloudProviderId> = new Set<CloudProviderId>(['aliyun', 'aws']);

const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

/** 这个厂商是不是走真实 API（而不是 Mock） */
export function isRealProvider(provider: CloudProviderId): boolean {
  return REAL_PROVIDERS.has(provider) && isTauri;
}

/** 浏览器预览模式下的说明文案 */
export function providerMode(provider: CloudProviderId): 'real' | 'mock' | 'mock-web' {
  if (!REAL_PROVIDERS.has(provider)) return 'mock';
  return isTauri ? 'real' : 'mock-web';
}

function normalizeStatus(raw: string): HostStatus {
  const value = raw.toLowerCase();
  if (value === 'running' || value === 'started') return 'running';
  if (value === 'stopped') return 'stopped';
  if (value === 'starting' || value === 'pending') return 'starting';
  if (value === 'stopping') return 'stopping';
  if (value === 'rebooting') return 'rebooting';
  if (value === 'error') return 'error';
  return 'unknown';
}

/** 校验凭据：失败会抛出带厂商错误码的异常 */
export async function validateCredentials(
  provider: CloudProviderId,
  credentials: CloudCredentials,
): Promise<string> {
  const result = await invoke<{ ok: boolean; detail: string }>('cloud_validate', {
    provider,
    creds: credentials,
  });
  return result.detail;
}

export async function listHosts(
  provider: CloudProviderId,
  credentials: CloudCredentials,
  regions: string[],
  cloudAccountId: string,
): Promise<Host[]> {
  const raw = await invoke<RawCloudHost[]>('cloud_list_hosts', {
    provider,
    creds: credentials,
    regions,
  });
  const now = new Date().toISOString();

  return raw.map((host) => ({
    id: `${cloudAccountId}/${host.instanceId}`,
    cloudAccountId,
    provider,
    instanceId: host.instanceId,
    name: host.name || host.instanceId,
    region: host.region,
    zone: host.zone || undefined,
    status: normalizeStatus(host.status),
    spec: {
      cpuCores: host.cpu,
      memoryMb: host.memoryMb,
      // 磁盘要额外调接口，当前版本不采集
      diskGb: 0,
      instanceType: host.instanceType || undefined,
    },
    publicIps: host.publicIps,
    privateIp: host.privateIp,
    os: host.os,
    createdAt: host.createdAt,
    expiresAt: host.expiresAt,
    updatedAt: now,
  }));
}

export async function powerHost(
  provider: CloudProviderId,
  credentials: CloudCredentials,
  region: string,
  instanceId: string,
  action: 'start' | 'stop' | 'reboot',
): Promise<void> {
  await invoke('cloud_power', {
    provider,
    creds: credentials,
    region,
    instanceId,
    action,
  });
}
