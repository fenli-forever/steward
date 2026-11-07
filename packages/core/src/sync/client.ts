import type { EncryptedRecord } from './records.js';
import type { StoredKdfConfig } from '../crypto/keys.js';

/**
 * 同步客户端。只做三件事：绑定设备、推增量、拉增量。
 *
 * 服务端 API（见 services/sync）：
 *   POST /v1/vaults/:vaultId/devices   用配对令牌换设备令牌
 *   GET  /v1/vaults/:vaultId/records?since=<cursor>
 *   POST /v1/vaults/:vaultId/records
 *
 * 注意：服务器只拿到 `EncryptedRecord`，看不到任何明文。
 */

export interface SyncEndpointConfig {
  baseUrl: string;
  vaultId: string;
  deviceId: string;
  deviceToken: string;
  /** 便于测试注入；默认用全局 fetch。 */
  fetch?: typeof fetch;
}

export class SyncError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'SyncError';
  }
}

export interface PullResult {
  records: EncryptedRecord[];
  cursor: number;
}

export interface PushResult {
  accepted: number;
  cursor: number;
}

export class SyncClient {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly config: SyncEndpointConfig) {
    this.fetchImpl = config.fetch ?? globalThis.fetch.bind(globalThis);
  }

  private url(path: string): string {
    return `${this.config.baseUrl.replace(/\/+$/, '')}${path}`;
  }

  private headers(): Record<string, string> {
    return {
      authorization: `Bearer ${this.config.deviceToken}`,
      'content-type': 'application/json',
    };
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await this.fetchImpl(this.url(path), { ...init, headers: this.headers() });
    const text = await response.text();
    let payload: unknown = null;
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = { message: text };
      }
    }
    if (!response.ok) {
      const body = payload as { error?: string; message?: string } | null;
      throw new SyncError(
        body?.message ?? `同步请求失败 (${response.status})`,
        response.status,
        body?.error,
      );
    }
    return payload as T;
  }

  async pull(since = 0): Promise<PullResult> {
    const result = await this.request<Partial<PullResult>>(
      `/v1/vaults/${encodeURIComponent(this.config.vaultId)}/records?since=${since}`,
    );
    return { records: result.records ?? [], cursor: result.cursor ?? since };
  }

  async push(records: EncryptedRecord[]): Promise<PushResult> {
    if (records.length === 0) return { accepted: 0, cursor: 0 };
    const result = await this.request<Partial<PushResult>>(
      `/v1/vaults/${encodeURIComponent(this.config.vaultId)}/records`,
      { method: 'POST', body: JSON.stringify({ deviceId: this.config.deviceId, records }) },
    );
    return { accepted: result.accepted ?? 0, cursor: result.cursor ?? 0 };
  }
}

/* ------------------------------------------------------------------ */
/* 配对：用一次性配对码把新设备接入自建服务器                              */
/* ------------------------------------------------------------------ */

export interface PairingRequest {
  vaultId: string;
  deviceName: string;
  platform: string;
}

export interface PairingResponse {
  deviceId: string;
  deviceToken: string;
  vaultId: string;
  /** 服务端下发的 KDF 参数，保证每台设备派生出同一把同步密钥。 */
  kdf?: StoredKdfConfig;
}

/**
 * 用管理员在服务器上生成的一次性配对令牌注册本机。
 * 配对令牌只用于这一次请求，注册后立刻作废（服务端强制单次使用）。
 */
export async function pairDevice(
  baseUrl: string,
  pairingToken: string,
  payload: PairingRequest,
  fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis),
): Promise<PairingResponse> {
  const response = await fetchImpl(`${baseUrl.replace(/\/+$/, '')}/v1/vaults/${payload.vaultId}/devices`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${pairingToken}` },
    body: JSON.stringify({ deviceName: payload.deviceName, platform: payload.platform }),
  });
  const text = await response.text();
  const body = text ? (JSON.parse(text) as Partial<PairingResponse> & { message?: string }) : {};
  if (!response.ok) {
    throw new SyncError(body.message ?? `配对失败 (${response.status})`, response.status);
  }
  if (!body.deviceId || !body.deviceToken) {
    throw new SyncError('配对响应缺少设备凭据', 500);
  }
  return {
    deviceId: body.deviceId,
    deviceToken: body.deviceToken,
    vaultId: payload.vaultId,
    ...(body.kdf ? { kdf: body.kdf } : {}),
  };
}
