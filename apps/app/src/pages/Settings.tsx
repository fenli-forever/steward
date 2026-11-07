import { useState } from 'react';
import { estimatePassphraseStrength, MIN_PASSPHRASE_LENGTH } from '@steward/core';
import { useAppStore } from '../data/store';
import { usingSystemKeychain } from '../data/secrets';
import { useUpdater } from '../data/updater';
import { Badge, Notice, PageHeader } from '../components/ui';

const STRENGTH_LABEL = ['太短', '弱', '一般', '不错', '很强'];

export default function SettingsPage() {
  const {
    settings,
    syncPassphrase,
    setSyncPassphrase,
    updateSyncSettings,
    pairWithCode,
    syncNow,
    busy,
    lastError,
    cards,
    statements,
    cloudAccounts,
    resetDemoData,
    clearAll,
  } = useAppStore();

  const [serverUrl, setServerUrl] = useState(settings.serverUrl);
  const [vaultId, setVaultId] = useState(settings.vaultId);
  const [pairingCode, setPairingCode] = useState('');
  const [message, setMessage] = useState<string | null>(null);

  const strength = estimatePassphraseStrength(syncPassphrase);

  const saveConnection = () => {
    updateSyncSettings({ serverUrl: serverUrl.trim(), vaultId: vaultId.trim() });
    setMessage('连接配置已保存');
  };

  const handlePair = async () => {
    setMessage(null);
    updateSyncSettings({ serverUrl: serverUrl.trim(), vaultId: vaultId.trim() });
    try {
      await pairWithCode(pairingCode.trim());
      setMessage('配对成功，本机已加入同步');
      setPairingCode('');
    } catch {
      // 错误已经写进 store.lastError
    }
  };

  const handleSync = async () => {
    setMessage(null);
    try {
      const stats = await syncNow();
      setMessage(`同步完成：拉取 ${stats.pulled} 条，推送 ${stats.pushed} 条，覆盖 ${stats.overwritten} 条`);
    } catch {
      // 同上
    }
  };

  const exportData = () => {
    const payload = {
      exportedAt: new Date().toISOString(),
      schemaVersion: 1,
      cards,
      statements,
      cloudAccounts,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `steward-export-${new Date().toISOString().slice(0, 10)}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
    setMessage('已导出明文备份，请妥善保管（其中不含任何密码/密钥）');
  };

  return (
    <>
      <PageHeader title="设置" description="同步、安全与数据管理。默认离线可用，同步是可选增强。" />

      <div className="split">
        <section className="panel">
          <div className="panel-head">
            <h2 className="panel-title">自建同步服务</h2>
            {settings.keyReady ? <Badge tone="green">已配对</Badge> : <Badge tone="muted">未配对</Badge>}
          </div>

          <label className="field">
            <span className="field-label">服务器地址</span>
            <input value={serverUrl} onChange={(e) => setServerUrl(e.target.value)} placeholder="http://127.0.0.1:8787" />
            <span className="field-hint">
              本机调试用 <span className="mono">pnpm --filter @steward/sync dev</span> 起服务，默认 8787 端口。
            </span>
          </label>

          <label className="field">
            <span className="field-label">Vault ID</span>
            <input value={vaultId} onChange={(e) => setVaultId(e.target.value)} placeholder="服务端 init 命令输出的仓库 ID" />
          </label>

          <button className="btn" onClick={saveConnection}>
            保存连接配置
          </button>

          <hr style={{ border: 'none', borderTop: '1px solid var(--border)', margin: '18px 0' }} />

          <label className="field">
            <span className="field-label">同步口令</span>
            <input
              type="password"
              value={syncPassphrase}
              onChange={(e) => setSyncPassphrase(e.target.value)}
              placeholder={`至少 ${MIN_PASSPHRASE_LENGTH} 位，建议 16 位以上`}
              autoComplete="new-password"
            />
            <span className="field-hint">
              强度：{STRENGTH_LABEL[strength]}
              {' · '}
              口令只存在内存里，不写入磁盘、不上传服务器；忘记口令 = 无法解密已同步数据。
            </span>
          </label>

          <label className="field">
            <span className="field-label">配对码（一次性）</span>
            <input
              value={pairingCode}
              onChange={(e) => setPairingCode(e.target.value)}
              placeholder="pair_..."
              spellCheck={false}
            />
          </label>

          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button
              className="btn btn-primary"
              onClick={() => void handlePair()}
              disabled={!pairingCode || !vaultId || !syncPassphrase || busy === 'pair'}
            >
              {busy === 'pair' ? '配对中…' : '配对这台设备'}
            </button>
            <button
              className="btn"
              onClick={() => void handleSync()}
              disabled={!settings.keyReady || !syncPassphrase || busy === 'sync'}
            >
              {busy === 'sync' ? '同步中…' : '立即同步'}
            </button>
          </div>

          {settings.keyReady ? (
            <dl className="kv" style={{ marginTop: 16 }}>
              <dt>设备 ID</dt>
              <dd className="mono">{settings.deviceId}</dd>
              <dt>上次同步</dt>
              <dd>{settings.lastSyncedAt ? new Date(settings.lastSyncedAt).toLocaleString('zh-CN') : '尚未同步'}</dd>
              <dt>KDF</dt>
              <dd className="mono">
                {settings.kdf ? `scrypt N=${settings.kdf.N} r=${settings.kdf.r} p=${settings.kdf.p}` : '—'}
              </dd>
            </dl>
          ) : null}

          {message ? (
            <div style={{ marginTop: 14 }}>
              <Notice tone="ok">{message}</Notice>
            </div>
          ) : null}
          {lastError ? (
            <div style={{ marginTop: 14 }}>
              <Notice tone="warn">{lastError}</Notice>
            </div>
          ) : null}
        </section>

        <div className="grid" style={{ alignContent: 'start' }}>
          <UpdatePanel />

          <section className="panel">
            <div className="panel-head">
              <h2 className="panel-title">安全模型</h2>
            </div>
            <ul style={{ margin: 0, paddingLeft: 18, color: 'var(--text-muted)', fontSize: 13, lineHeight: 1.9 }}>
              <li>
                卡号只保留<strong style={{ color: 'var(--text)' }}>末四位</strong>；完整卡号、CVV、密码不进入本应用数据库。
              </li>
              <li>
                云厂商 AK/SK 存在{usingSystemKeychain ? '系统钥匙串' : '浏览器 localStorage（仅开发模式）'}，
                同步时也不会被序列化。
              </li>
              <li>同步数据用 XChaCha20-Poly1305 端到端加密，服务器只看到密文与集合名。</li>
              <li>服务器上的每个密文都绑定了它所属的记录 ID（AAD），无法互相调包。</li>
            </ul>
            {!usingSystemKeychain ? (
              <div style={{ marginTop: 12 }}>
                <Notice tone="warn">
                  当前是浏览器预览模式，凭据落在 <span className="mono">localStorage</span>。装成桌面/移动 App
                  后会自动改用系统钥匙串。
                </Notice>
              </div>
            ) : null}
          </section>

          <section className="panel">
            <div className="panel-head">
              <h2 className="panel-title">数据</h2>
            </div>
            <dl className="kv" style={{ marginBottom: 14 }}>
              <dt>卡片</dt>
              <dd>{cards.length} 张</dd>
              <dt>账单</dt>
              <dd>{statements.length} 期</dd>
              <dt>云账号</dt>
              <dd>{cloudAccounts.length} 个</dd>
            </dl>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button className="btn btn-sm" onClick={exportData}>
                导出 JSON 备份
              </button>
              <button className="btn btn-sm" onClick={resetDemoData}>
                恢复演示数据
              </button>
              <button
                className="btn btn-sm btn-danger"
                onClick={() => {
                  if (window.confirm('清空本机所有卡片、账单与云账号？此操作不可撤销。')) clearAll();
                }}
              >
                清空全部数据
              </button>
            </div>
          </section>

          <section className="panel">
            <div className="panel-head">
              <h2 className="panel-title">关于</h2>
            </div>
            <dl className="kv">
              <dt>版本</dt>
              <dd>0.1.0 · MVP 骨架</dd>
              <dt>技术栈</dt>
              <dd>Tauri 2 / React 19 / TypeScript / Rust</dd>
              <dt>许可证</dt>
              <dd>待定</dd>
            </dl>
            <div style={{ marginTop: 12 }}>
              <Notice>
                这是一个可运行的骨架：本地数据、账单解析、云端聚合、端到端加密同步协议都已打通；
                真实云厂商 SDK 与智能家居接入见 <span className="mono">docs/04-roadmap.md</span>。
              </Notice>
            </div>
          </section>
        </div>
      </div>
    </>
  );
}

/**
 * 版本与更新。
 * 桌面端从 GitHub Releases 的 latest.json 检查更新；移动端交给应用商店。
 */
function UpdatePanel() {
  const { status, currentVersion, available, progress, error, check, install, restart } = useUpdater();

  const statusText: Record<typeof status, string> = {
    idle: '尚未检查',
    unsupported: '当前环境不支持自动更新（浏览器预览 / 移动端）',
    checking: '正在检查…',
    available: `发现新版本 v${available?.version ?? ''}`,
    'up-to-date': '已是最新版本',
    downloading: '正在下载…',
    ready: '下载完成，重启后生效',
    error: error ?? '检查失败',
  };

  return (
    <section className="panel">
      <div className="panel-head">
        <h2 className="panel-title">版本与更新</h2>
        <Badge tone={status === 'available' ? 'green' : 'muted'}>v{currentVersion}</Badge>
      </div>

      <p className="muted" style={{ margin: '0 0 12px', fontSize: 12.5 }}>
        {statusText[status]}
        {status === 'available' && available?.date ? ` · 发布于 ${new Date(available.date).toLocaleDateString('zh-CN')}` : ''}
      </p>

      {status === 'downloading' && progress !== null ? (
        <div className="usage" style={{ marginBottom: 12 }}>
          <div className="usage-fill" style={{ width: `${Math.round(progress * 100)}%` }} />
        </div>
      ) : null}

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button
          className="btn btn-sm"
          onClick={() => void check()}
          disabled={status === 'unsupported' || status === 'checking' || status === 'downloading'}
        >
          检查更新
        </button>
        {status === 'available' ? (
          <button className="btn btn-sm btn-primary" onClick={() => void install()}>
            下载并安装 v{available?.version}
          </button>
        ) : null}
        {status === 'ready' ? (
          <button className="btn btn-sm btn-primary" onClick={() => void restart()}>
            重启生效
          </button>
        ) : null}
      </div>

      {status === 'error' ? (
        <div style={{ marginTop: 12 }}>
          <Notice tone="warn">{error}</Notice>
        </div>
      ) : null}

      <p className="dim" style={{ margin: '12px 0 0', fontSize: 11.5, lineHeight: 1.6 }}>
        更新包用 Ed25519 签名，应用内置公钥校验；签名不匹配会被拒绝安装。
        更新源来自 GitHub Releases，不会上传任何本地数据。
      </p>
    </section>
  );
}
