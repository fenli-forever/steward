import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import {
  buildDashboard,
  daysUntilDue,
  formatMoney,
  hostDisplayName,
  daysUntil,
  type Statement,
} from '@steward/core';
import { useAppStore } from '../data/store';
import { Badge, EmptyState, PageHeader, StatCard } from '../components/ui';

export default function DashboardPage() {
  const { cards, statements, hosts } = useAppStore();

  const dashboard = useMemo(
    () => buildDashboard({ cards, statements, hosts }),
    [cards, statements, hosts],
  );

  const recentLines = useMemo(() => {
    const lines = statements
      .flatMap((statement) => statement.lines.map((line) => ({ ...line, statement })))
      .sort((a, b) => (a.postedAt < b.postedAt ? 1 : -1))
      .slice(0, 6);
    return lines;
  }, [statements]);

  const utilization =
    dashboard.creditLimitMinor > 0
      ? Math.min(1, dashboard.creditUsedMinor / dashboard.creditLimitMinor)
      : null;

  return (
    <>
      <PageHeader
        title="总览"
        description="资产、负债和云资源，一屏看完；数据默认只存在这台设备上。"
      />

      <div className="grid grid-4">
        <StatCard
          label="账户余额合计"
          value={formatMoney(dashboard.totalAssetsMinor, dashboard.currency, { signed: false })}
          foot={`${cards.filter((c) => c.kind === 'debit' && !c.archived).length} 张借记卡`}
        />
        <StatCard
          label="本期信用卡待还"
          value={formatMoney(dashboard.creditUsedMinor, dashboard.currency, { signed: false })}
          foot={
            utilization === null
              ? '未设置授信额度'
              : `已用 ${(utilization * 100).toFixed(1)}% · 额度 ${formatMoney(dashboard.creditLimitMinor, dashboard.currency, { signed: false })}`
          }
          accent={dashboard.creditUsedMinor > 0 ? 'amber' : undefined}
        />
        <StatCard
          label="云主机"
          value={`${dashboard.hostsRunning} / ${dashboard.hostsTotal}`}
          foot="运行中 / 总数"
        />
        <StatCard
          label="云成本（月）"
          value={formatMoney(dashboard.monthlyCloudCostMinor, dashboard.currency, { signed: false })}
          foot="按当前配置估算"
        />
      </div>

      <div className="split section-gap">
        <section className="panel">
          <div className="panel-head">
            <h2 className="panel-title">待还款</h2>
            <Link className="btn btn-ghost btn-sm" to="/cards">
              去卡包 →
            </Link>
          </div>
          {dashboard.upcomingDue.length === 0 ? (
            <EmptyState>没有待还账单，保持住 ✌️</EmptyState>
          ) : (
            dashboard.upcomingDue.map((statement) => (
              <StatementRow key={statement.id} statement={statement} cards={cards} />
            ))
          )}
        </section>

        <section className="panel">
          <div className="panel-head">
            <h2 className="panel-title">云主机到期提醒</h2>
            <Link className="btn btn-ghost btn-sm" to="/cloud">
              去管理 →
            </Link>
          </div>
          {dashboard.expiringHosts.length === 0 ? (
            <EmptyState>未来 30 天没有到期的主机</EmptyState>
          ) : (
            dashboard.expiringHosts.map((host) => {
              const remaining = daysUntil(host.expiresAt);
              return (
                <div className="row" key={host.id}>
                  <div className="row-main">
                    <div className="avatar">{host.provider.slice(0, 2).toUpperCase()}</div>
                    <div style={{ minWidth: 0 }}>
                      <div className="ellipsis">{hostDisplayName(host)}</div>
                      <div className="dim" style={{ fontSize: 12 }}>
                        {host.region} · {host.spec.cpuCores}C/{Math.round(host.spec.memoryMb / 1024)}G
                      </div>
                    </div>
                  </div>
                  <Badge tone={remaining !== null && remaining <= 7 ? 'red' : 'amber'}>
                    {remaining} 天后到期
                  </Badge>
                </div>
              );
            })
          )}
        </section>
      </div>

      <section className="panel section-gap">
        <div className="panel-head">
          <h2 className="panel-title">最近交易</h2>
          <span className="dim" style={{ fontSize: 12 }}>
            来自已导入的账单
          </span>
        </div>
        {recentLines.length === 0 ? (
          <EmptyState>导入一份信用卡账单后，这里会出现最近的交易记录</EmptyState>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>日期</th>
                  <th>商户</th>
                  <th>卡</th>
                  <th style={{ textAlign: 'right' }}>金额</th>
                </tr>
              </thead>
              <tbody>
                {recentLines.map((line) => {
                  const card = cards.find((c) => c.id === line.statement.cardId);
                  return (
                    <tr key={line.id}>
                      <td className="mono dim">{line.postedAt}</td>
                      <td>{line.merchant}</td>
                      <td className="dim">{card ? `${card.issuer} · ${card.last4}` : '—'}</td>
                      <td
                        style={{
                          textAlign: 'right',
                          color: line.direction === 'credit' ? 'var(--green)' : 'var(--text)',
                          fontVariantNumeric: 'tabular-nums',
                        }}
                      >
                        {line.direction === 'credit' ? '+' : '−'}
                        {formatMoney(line.amountMinor, line.currency, { signed: false })}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}

function StatementRow({
  statement,
  cards,
}: {
  statement: Statement;
  cards: ReturnType<typeof useAppStore.getState>['cards'];
}) {
  const card = cards.find((c) => c.id === statement.cardId);
  const remaining = daysUntilDue(statement.dueDate);

  return (
    <div className="row">
      <div className="row-main">
        <div className="avatar">{(card?.issuer ?? '卡').slice(0, 1)}</div>
        <div style={{ minWidth: 0 }}>
          <div className="ellipsis">
            {card?.issuer ?? '未知卡片'} · {card?.nickname}
          </div>
          <div className="dim" style={{ fontSize: 12 }}>
            到期 {statement.dueDate}
            {statement.minimumPaymentMinor
              ? ` · 最低还款 ${formatMoney(statement.minimumPaymentMinor, statement.currency, { signed: false })}`
              : ''}
          </div>
        </div>
      </div>
      <div style={{ textAlign: 'right' }}>
        <div style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 600 }}>
          {formatMoney(statement.totalAmountMinor, statement.currency, { signed: false })}
        </div>
        <div style={{ marginTop: 3 }}>
          {remaining < 0 ? (
            <Badge tone="red">已逾期 {Math.abs(remaining)} 天</Badge>
          ) : remaining <= 3 ? (
            <Badge tone="red">{remaining} 天后还款</Badge>
          ) : remaining <= 7 ? (
            <Badge tone="amber">{remaining} 天后还款</Badge>
          ) : (
            <span className="dim" style={{ fontSize: 12 }}>
              {remaining} 天后还款
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
