import { useMemo, useState } from 'react';
import {
  CLOUD_PROVIDERS,
  daysUntil,
  formatMoney,
  hostDisplayName,
  lastSeenLabel,
  summarizeHosts,
  type CloudProviderId,
} from '@steward/core';
import { useAppStore } from '../data/store';
import { Badge, EmptyState, HostStatusBadge, Modal, Notice, PageHeader, StatCard } from '../components/ui';

const PROVIDER_LABEL: Record<CloudProviderId, string> = {
  aliyun: '阿里云',
  tencent: '腾讯云',
  aws: 'AWS',
  azure: 'Azure',
  huawei: '华为云',
  volcengine: '火山引擎',
};

const REGION_PRESETS: Record<CloudProviderId, string[]> = {
  aliyun: ['cn-hangzhou', 'cn-shanghai', 'cn-beijing', 'ap-southeast-1'],
  tencent: ['ap-guangzhou', 'ap-shanghai', 'ap-beijing', 'ap-hongkong'],
  aws: ['us-east-1', 'ap-northeast-1', 'ap-southeast-1', 'eu-west-1'],
  azure: ['eastasia', 'southeastasia', 'japaneast'],
  huawei: ['cn-north-4', 'cn-east-3', 'ap-southeast-1'],
  volcengine: ['cn-beijing', 'cn-shanghai', 'cn-guangzhou'],
};

export default function CloudPage() {
  const { cloudAccounts, hosts, syncCloudAccount, setHostPower, busy, lastError, removeCloudAccount } =
    useAppStore();
  const [showAdd, setShowAdd] = useState(false);
  const [filter, setFilter] = useState<string>('all');

  const summary = useMemo(() => summarizeHosts(hosts), [hosts]);
  const monthlyCost = summary.monthlyCostByCurrency.get('CNY') ?? 0;
  const visibleHosts = filter === 'all' ? hosts : hosts.filter((h) => h.cloudAccountId === filter);

  return (
    <>
      <PageHeader
        title="多云主机"
        description="阿里云、腾讯云、AWS 等放在一起管。AccessKey 只保存在本机钥匙串，同步服务器拿不到。"
        actions={
          <button className="btn btn-primary" onClick={() => setShowAdd(true)}>
            + 添加云账号
          </button>
        }
      />

      {lastError ? (
        <div style={{ marginBottom: 14 }}>
          <Notice tone="warn">
            <strong>操作失败：</strong>
            {lastError}
          </Notice>
        </div>
      ) : null}

      <div className="grid grid-4">
        <StatCard label="主机总数" value={summary.total} foot={`${cloudAccounts.length} 个云账号`} />
        <StatCard label="运行中" value={summary.byStatus.running} foot={`已关机 ${summary.byStatus.stopped}`} accent="green" />
        <StatCard
          label="月成本（CNY）"
          value={formatMoney(monthlyCost, 'CNY', { signed: false })}
          foot="按当前配置估算"
        />
        <StatCard
          label="30 天内到期"
          value={summary.expiringSoon.length}
          foot="包年包月实例"
          accent={summary.expiringSoon.length > 0 ? 'amber' : undefined}
        />
      </div>

      <section className="panel section-gap">
        <div className="panel-head">
          <h2 className="panel-title">云账号</h2>
          <span className="dim" style={{ fontSize: 12 }}>
            凭据存于系统钥匙串
          </span>
        </div>
        {cloudAccounts.length === 0 ? (
          <EmptyState>还没有绑定云账号。支持阿里云、腾讯云、AWS、Azure、华为云、火山引擎。</EmptyState>
        ) : (
          <div className="grid grid-2">
            {cloudAccounts.map((account) => (
              <div className="stat" key={account.id} style={{ padding: '14px 16px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'flex-start' }}>
                  <div>
                    <div style={{ fontWeight: 600 }}>{account.alias}</div>
                    <div className="dim" style={{ fontSize: 12, marginTop: 2 }}>
                      {PROVIDER_LABEL[account.provider]} · {account.regions.join(' / ') || '未设置地域'}
                    </div>
                  </div>
                  <Badge tone="blue">{PROVIDER_LABEL[account.provider]}</Badge>
                </div>
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    marginTop: 12,
                    gap: 10,
                  }}
                >
                  <span className="dim" style={{ fontSize: 12 }}>
                    {account.lastSyncError ? `同步失败：${account.lastSyncError}` : `同步于 ${lastSeenLabel(account)}`}
                  </span>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <button
                      className="btn btn-sm"
                      onClick={() => void syncCloudAccount(account.id)}
                      disabled={busy === `sync:${account.id}`}
                    >
                      {busy === `sync:${account.id}` ? '同步中…' : '同步'}
                    </button>
                    <button
                      className="btn btn-sm btn-ghost"
                      onClick={() => {
                        if (window.confirm(`解除绑定「${account.alias}」？本机保存的凭据会一并删除。`)) {
                          void removeCloudAccount(account.id);
                        }
                      }}
                    >
                      移除
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="panel section-gap">
        <div className="panel-head">
          <h2 className="panel-title">主机</h2>
          <div className="chips">
            <button className={`chip ${filter === 'all' ? 'active' : ''}`} onClick={() => setFilter('all')}>
              全部
            </button>
            {cloudAccounts.map((account) => (
              <button
                key={account.id}
                className={`chip ${filter === account.id ? 'active' : ''}`}
                onClick={() => setFilter(account.id)}
              >
                {PROVIDER_LABEL[account.provider]}
              </button>
            ))}
          </div>
        </div>

        {visibleHosts.length === 0 ? (
          <EmptyState>没有主机。绑定云账号后点「同步」拉取实例列表。</EmptyState>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>实例</th>
                  <th>地域</th>
                  <th>规格</th>
                  <th>公网 IP</th>
                  <th>状态</th>
                  <th style={{ textAlign: 'right' }}>月成本</th>
                  <th style={{ textAlign: 'right' }}>操作</th>
                </tr>
              </thead>
              <tbody>
                {visibleHosts.map((host) => {
                  const remaining = daysUntil(host.expiresAt);
                  return (
                    <tr key={host.id}>
                      <td>
                        <div style={{ fontWeight: 550 }}>{hostDisplayName(host)}</div>
                        <div className="dim mono" style={{ fontSize: 11.5 }}>
                          {host.instanceId}
                          {remaining !== null && remaining <= 30 ? (
                            <span style={{ color: 'var(--amber)' }}> · {remaining} 天后到期</span>
                          ) : null}
                        </div>
                      </td>
                      <td className="dim">{host.region}</td>
                      <td className="dim">
                        {host.spec.cpuCores}C / {Math.round(host.spec.memoryMb / 1024)}G / {host.spec.diskGb}G
                      </td>
                      <td className="mono dim">{host.publicIps[0] ?? '—'}</td>
                      <td>
                        <HostStatusBadge status={host.status} />
                      </td>
                      <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }} className="dim">
                        {host.monthlyCostMinor !== undefined && host.currency
                          ? formatMoney(host.monthlyCostMinor, host.currency, { signed: false })
                          : '—'}
                      </td>
                      <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                        {host.status === 'running' ? (
                          <button
                            className="btn btn-sm"
                            onClick={() => void setHostPower(host.id, 'stop')}
                            disabled={busy === `power:${host.id}`}
                          >
                            关机
                          </button>
                        ) : (
                          <button
                            className="btn btn-sm"
                            onClick={() => void setHostPower(host.id, 'start')}
                            disabled={busy === `power:${host.id}`}
                          >
                            开机
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {showAdd ? <AddCloudAccountModal onClose={() => setShowAdd(false)} /> : null}
    </>
  );
}

function AddCloudAccountModal({ onClose }: { onClose: () => void }) {
  const addCloudAccount = useAppStore((s) => s.addCloudAccount);
  const [provider, setProvider] = useState<CloudProviderId>('aliyun');
  const [alias, setAlias] = useState('阿里云 · 主账号');
  const [accessKeyId, setAccessKeyId] = useState('');
  const [accessKeySecret, setAccessKeySecret] = useState('');
  const [regions, setRegions] = useState<string[]>(REGION_PRESETS.aliyun.slice(0, 1));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    if (!accessKeyId.trim() || !accessKeySecret.trim()) {
      setError('请填写 AccessKeyId 与 AccessKeySecret');
      return;
    }
    setSaving(true);
    try {
      await addCloudAccount({ provider, alias, accessKeyId, accessKeySecret, regions });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSaving(false);
    }
  };

  return (
    <Modal
      open
      title="绑定云账号"
      description="建议使用只读 + 最小权限的子账号 AccessKey。凭据只写入本机系统钥匙串，不会上传。"
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose}>
            取消
          </button>
          <button className="btn btn-primary" onClick={() => void submit()} disabled={saving}>
            {saving ? '绑定中…' : '绑定并同步'}
          </button>
        </>
      }
    >
      <div className="form-row">
        <label className="field">
          <span className="field-label">云厂商</span>
          <select
            value={provider}
            onChange={(e) => {
              const next = e.target.value as CloudProviderId;
              setProvider(next);
              setAlias(`${PROVIDER_LABEL[next]} · 主账号`);
              setRegions(REGION_PRESETS[next].slice(0, 1));
            }}
          >
            {CLOUD_PROVIDERS.map((p) => (
              <option key={p} value={p}>
                {PROVIDER_LABEL[p]}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span className="field-label">别名</span>
          <input value={alias} onChange={(e) => setAlias(e.target.value)} />
        </label>
      </div>

      <label className="field">
        <span className="field-label">AccessKeyId</span>
        <input value={accessKeyId} onChange={(e) => setAccessKeyId(e.target.value)} placeholder="LTAI5t..." spellCheck={false} />
      </label>
      <label className="field">
        <span className="field-label">AccessKeySecret</span>
        <input
          type="password"
          value={accessKeySecret}
          onChange={(e) => setAccessKeySecret(e.target.value)}
          placeholder="••••••••"
        />
      </label>

      <div className="field">
        <span className="field-label">同步地域</span>
        <div className="chips">
          {REGION_PRESETS[provider].map((region) => {
            const active = regions.includes(region);
            return (
              <button
                key={region}
                type="button"
                className={`chip ${active ? 'active' : ''}`}
                onClick={() =>
                  setRegions((prev) => (active ? prev.filter((r) => r !== region) : [...prev, region]))
                }
              >
                {region}
              </button>
            );
          })}
        </div>
      </div>

      <Notice tone="warn">
        当前版本使用 <strong>Mock 适配器</strong>：不会真正调用云厂商 API，只用于打通界面与数据流。
        真实 SDK 接入见 <span className="mono">docs/04-roadmap.md</span>。
      </Notice>

      {error ? (
        <div style={{ marginTop: 10 }}>
          <Notice tone="warn">{error}</Notice>
        </div>
      ) : null}
    </Modal>
  );
}
