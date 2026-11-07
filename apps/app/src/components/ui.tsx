import type { ReactNode } from 'react';
import { useEffect } from 'react';
import type { HostStatus } from '@steward/core';

export function Badge({
  tone = 'muted',
  children,
}: {
  tone?: 'green' | 'amber' | 'red' | 'blue' | 'muted';
  children: ReactNode;
}) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

const HOST_STATUS_LABEL: Record<HostStatus, { text: string; tone: 'green' | 'amber' | 'red' | 'muted' | 'blue' }> = {
  running: { text: '运行中', tone: 'green' },
  stopped: { text: '已关机', tone: 'muted' },
  starting: { text: '启动中', tone: 'blue' },
  stopping: { text: '关机中', tone: 'amber' },
  rebooting: { text: '重启中', tone: 'amber' },
  error: { text: '异常', tone: 'red' },
  unknown: { text: '未知', tone: 'muted' },
};

export function HostStatusBadge({ status }: { status: HostStatus }) {
  const config = HOST_STATUS_LABEL[status] ?? HOST_STATUS_LABEL.unknown;
  return (
    <Badge tone={config.tone}>
      <span className="dot" />
      {config.text}
    </Badge>
  );
}

export function StatCard({
  label,
  value,
  foot,
  accent,
}: {
  label: string;
  value: ReactNode;
  foot?: ReactNode;
  accent?: 'green' | 'amber' | 'red';
}) {
  return (
    <div className="stat">
      <div className="stat-label">{label}</div>
      <div className="stat-value" style={accent ? { color: `var(--${accent})` } : undefined}>
        {value}
      </div>
      {foot ? <div className="stat-foot">{foot}</div> : null}
    </div>
  );
}

export function Modal({
  open,
  title,
  description,
  onClose,
  children,
  footer,
}: {
  open: boolean;
  title: string;
  description?: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label={title} onClick={onClose}>
      <div className="modal" onClick={(event) => event.stopPropagation()}>
        <h2 className="modal-title">{title}</h2>
        {description ? <p className="modal-sub">{description}</p> : null}
        {children}
        {footer ? <div className="modal-actions">{footer}</div> : null}
      </div>
    </div>
  );
}

export function EmptyState({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

export function Notice({
  tone = 'info',
  children,
}: {
  tone?: 'info' | 'warn' | 'ok';
  children: ReactNode;
}) {
  const className = tone === 'warn' ? 'notice notice-warn' : tone === 'ok' ? 'notice notice-ok' : 'notice';
  return <div className={className}>{children}</div>;
}

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <header className="page-head">
      <div>
        <h1 className="page-title">{title}</h1>
        {description ? <p className="page-desc">{description}</p> : null}
      </div>
      {actions ? <div style={{ display: 'flex', gap: 8 }}>{actions}</div> : null}
    </header>
  );
}
