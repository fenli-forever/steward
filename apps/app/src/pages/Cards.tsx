import { useMemo, useRef, useState } from 'react';
import {
  CURRENCIES,
  formatMoney,
  type CardNetwork,
  type CardKind,
  type Currency,
} from '@steward/core';
import { useAppStore, type ImportSummary } from '../data/store';
import { Badge, EmptyState, Modal, Notice, PageHeader } from '../components/ui';

const NETWORKS: { value: CardNetwork; label: string }[] = [
  { value: 'unionpay', label: '银联' },
  { value: 'visa', label: 'Visa' },
  { value: 'mastercard', label: 'Mastercard' },
  { value: 'amex', label: 'American Express' },
  { value: 'jcb', label: 'JCB' },
  { value: 'other', label: '其他' },
];

export default function CardsPage() {
  const { cards, statements, addCard, archiveCard, markStatementPaid, importStatement } = useAppStore();
  const [showAdd, setShowAdd] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const activeCards = cards.filter((c) => !c.archived);

  return (
    <>
      <PageHeader
        title="卡包"
        description="银行卡与信用卡。卡号只保留末四位，密码和 CVV 存在系统钥匙串里，不参与同步。"
        actions={
          <>
            <button className="btn" onClick={() => setShowImport(true)}>
              导入账单
            </button>
            <button className="btn btn-primary" onClick={() => setShowAdd(true)}>
              + 添加卡片
            </button>
          </>
        }
      />

      {activeCards.length === 0 ? (
        <div className="panel">
          <EmptyState>还没有卡片。点右上角「添加卡片」开始。</EmptyState>
        </div>
      ) : (
        <div className="card-grid">
          {activeCards.map((card) => {
            const usedMinor = statements
              .filter((s) => s.cardId === card.id && !s.isPaid)
              .reduce((sum, s) => sum + s.totalAmountMinor, 0);
            const utilization =
              card.kind === 'credit' && card.creditLimitMinor
                ? Math.min(1, usedMinor / card.creditLimitMinor)
                : null;

            return (
              <article className={`credit-card ${card.kind}`} key={card.id}>
                <div className="cc-top">
                  <div>
                    <div className="cc-issuer">{card.issuer}</div>
                    <div className="dim" style={{ fontSize: 12 }}>
                      {card.nickname} · {NETWORKS.find((n) => n.value === card.network)?.label ?? card.network}
                    </div>
                  </div>
                  <Badge tone={card.kind === 'credit' ? 'blue' : 'muted'}>
                    {card.kind === 'credit' ? '信用卡' : '借记卡'}
                  </Badge>
                </div>

                <div className="cc-number">•••• •••• •••• {card.last4}</div>

                <div className="cc-foot">
                  {card.kind === 'credit' ? (
                    <div style={{ flex: 1 }}>
                      <div className="cc-label">已用 / 额度</div>
                      <div className="cc-value">
                        {formatMoney(usedMinor, card.currency, { signed: false })}
                        <span className="dim" style={{ fontSize: 12, fontWeight: 400 }}>
                          {' / '}
                          {card.creditLimitMinor
                            ? formatMoney(card.creditLimitMinor, card.currency, { signed: false })
                            : '未设置'}
                        </span>
                      </div>
                      {utilization !== null ? (
                        <div className="usage">
                          <div className="usage-fill" style={{ width: `${utilization * 100}%` }} />
                        </div>
                      ) : null}
                    </div>
                  ) : (
                    <div>
                      <div className="cc-label">余额</div>
                      <div className="cc-value">
                        {card.balanceMinor === undefined
                          ? '未维护'
                          : formatMoney(card.balanceMinor, card.currency, { signed: false })}
                      </div>
                    </div>
                  )}
                  <button
                    className="btn btn-ghost btn-sm"
                    style={{ color: 'rgba(230,237,243,0.65)' }}
                    onClick={() => archiveCard(card.id)}
                    title="归档这张卡"
                  >
                    归档
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      )}

      <section className="panel section-gap">
        <div className="panel-head">
          <h2 className="panel-title">账单</h2>
          <span className="dim" style={{ fontSize: 12 }}>
            共 {statements.length} 期
          </span>
        </div>
        {statements.length === 0 ? (
          <EmptyState>还没有账单。导入 CSV 账单后会自动生成一期账单。</EmptyState>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>账期</th>
                  <th>卡片</th>
                  <th>还款日</th>
                  <th style={{ textAlign: 'right' }}>应还</th>
                  <th>状态</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {statements.map((statement) => {
                  const card = cards.find((c) => c.id === statement.cardId);
                  return (
                    <tr key={statement.id}>
                      <td className="mono dim">
                        {statement.periodStart} → {statement.periodEnd}
                      </td>
                      <td>{card ? `${card.issuer} · ${card.last4}` : '已删除卡片'}</td>
                      <td className="mono dim">{statement.dueDate}</td>
                      <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                        {formatMoney(statement.totalAmountMinor, statement.currency, { signed: false })}
                      </td>
                      <td>
                        {statement.isPaid ? <Badge tone="green">已还清</Badge> : <Badge tone="amber">待还</Badge>}
                      </td>
                      <td style={{ textAlign: 'right' }}>
                        {!statement.isPaid ? (
                          <button className="btn btn-sm" onClick={() => markStatementPaid(statement.id)}>
                            标记已还
                          </button>
                        ) : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {showAdd ? <AddCardModal onClose={() => setShowAdd(false)} onSubmit={addCard} /> : null}
      {showImport ? (
        <ImportModal
          onClose={() => setShowImport(false)}
          cards={activeCards}
          onImport={(cardId, text) => importStatement(cardId, text)}
        />
      ) : null}
    </>
  );
}

function AddCardModal({
  onClose,
  onSubmit,
}: {
  onClose: () => void;
  onSubmit: ReturnType<typeof useAppStore.getState>['addCard'];
}) {
  const [kind, setKind] = useState<CardKind>('credit');
  const [issuer, setIssuer] = useState('招商银行');
  const [nickname, setNickname] = useState('');
  const [last4, setLast4] = useState('');
  const [network, setNetwork] = useState<CardNetwork>('unionpay');
  const [currency, setCurrency] = useState<Currency>('CNY');
  const [amount, setAmount] = useState('');
  const [billingDay, setBillingDay] = useState('5');
  const [dueDay, setDueDay] = useState('25');

  const submit = () => {
    const numeric = Number.parseFloat(amount);
    onSubmit({
      kind,
      issuer,
      network,
      nickname,
      last4,
      currency,
      ...(kind === 'credit' ? { creditLimit: Number.isFinite(numeric) ? numeric : undefined } : {}),
      ...(kind === 'debit' ? { balance: Number.isFinite(numeric) ? numeric : undefined } : {}),
      ...(kind === 'credit' ? { billingDay: Number(billingDay), dueDay: Number(dueDay) } : {}),
    });
    onClose();
  };

  return (
    <Modal
      open
      title="添加卡片"
      description="只需要末四位。完整卡号、密码、CVV 请存到系统钥匙串，不要填在这里。"
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose}>
            取消
          </button>
          <button className="btn btn-primary" onClick={submit} disabled={!issuer || last4.length < 4}>
            保存
          </button>
        </>
      }
    >
      <div className="form-row">
        <label className="field">
          <span className="field-label">类型</span>
          <select value={kind} onChange={(e) => setKind(e.target.value as CardKind)}>
            <option value="credit">信用卡</option>
            <option value="debit">借记卡</option>
          </select>
        </label>
        <label className="field">
          <span className="field-label">卡组织</span>
          <select value={network} onChange={(e) => setNetwork(e.target.value as CardNetwork)}>
            {NETWORKS.map((n) => (
              <option key={n.value} value={n.value}>
                {n.label}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="form-row">
        <label className="field">
          <span className="field-label">发卡行</span>
          <input value={issuer} onChange={(e) => setIssuer(e.target.value)} placeholder="招商银行" />
        </label>
        <label className="field">
          <span className="field-label">别名</span>
          <input value={nickname} onChange={(e) => setNickname(e.target.value)} placeholder="工资卡 / 白金卡" />
        </label>
      </div>
      <div className="form-row">
        <label className="field">
          <span className="field-label">卡号末四位</span>
          <input
            value={last4}
            onChange={(e) => setLast4(e.target.value.replace(/\D/g, '').slice(0, 4))}
            placeholder="1234"
            inputMode="numeric"
          />
        </label>
        <label className="field">
          <span className="field-label">币种</span>
          <select value={currency} onChange={(e) => setCurrency(e.target.value as Currency)}>
            {CURRENCIES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </label>
      </div>

      {kind === 'credit' ? (
        <>
          <div className="form-row">
            <label className="field">
              <span className="field-label">授信额度（元）</span>
              <input value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="50000" inputMode="decimal" />
            </label>
            <div className="field" />
          </div>
          <div className="form-row">
            <label className="field">
              <span className="field-label">账单日</span>
              <input value={billingDay} onChange={(e) => setBillingDay(e.target.value)} inputMode="numeric" />
            </label>
            <label className="field">
              <span className="field-label">还款日</span>
              <input value={dueDay} onChange={(e) => setDueDay(e.target.value)} inputMode="numeric" />
            </label>
          </div>
        </>
      ) : (
        <label className="field">
          <span className="field-label">当前余额（元）</span>
          <input value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="86520.00" inputMode="decimal" />
        </label>
      )}
    </Modal>
  );
}

function ImportModal({
  onClose,
  cards,
  onImport,
}: {
  onClose: () => void;
  cards: ReturnType<typeof useAppStore.getState>['cards'];
  onImport: (cardId: string, text: string) => ImportSummary;
}) {
  const [cardId, setCardId] = useState(cards[0]?.id ?? '');
  const [text, setText] = useState('');
  const [result, setResult] = useState<ImportSummary | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const handleFile = async (file: File) => {
    setFileName(file.name);
    setText(await file.text());
    setResult(null);
  };

  const run = () => {
    if (!cardId || !text.trim()) return;
    setResult(onImport(cardId, text));
  };

  return (
    <Modal
      open
      title="导入账单 CSV"
      description="支持招商 / 中信 / 工行等常见导出格式。解析失败的行会列出来，不会中断整份账单。"
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose}>
            关闭
          </button>
          <button className="btn btn-primary" onClick={run} disabled={!cardId || !text.trim()}>
            解析并导入
          </button>
        </>
      }
    >
      <label className="field">
        <span className="field-label">导入到哪张卡</span>
        <select value={cardId} onChange={(e) => setCardId(e.target.value)}>
          {cards.map((card) => (
            <option key={card.id} value={card.id}>
              {card.issuer} · {card.nickname} · {card.last4}
            </option>
          ))}
        </select>
      </label>

      <div className="field">
        <span className="field-label">选择 CSV 文件</span>
        <input
          ref={fileRef}
          type="file"
          accept=".csv,.txt,text/csv"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void handleFile(file);
          }}
        />
        {fileName ? <span className="field-hint">已选择：{fileName}</span> : null}
      </div>

      <label className="field">
        <span className="field-label">或直接粘贴内容</span>
        <textarea
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setResult(null);
          }}
          placeholder={'交易日期,交易摘要,人民币金额\n2026-10-01,星巴克,32.00'}
        />
      </label>

      {result ? (
        <div style={{ marginTop: 8 }}>
          {result.imported > 0 ? (
            <Notice tone="ok">
              成功导入 <strong>{result.imported}</strong> 条交易，已生成账单
              {result.statement ? `（应还 ${formatMoney(result.statement.totalAmountMinor, result.statement.currency, { signed: false })}，还款日 ${result.statement.dueDate}）` : ''}。
            </Notice>
          ) : (
            <Notice tone="warn">没有解析出任何交易，请检查表头是否包含日期和金额列。</Notice>
          )}
          {result.issues.length > 0 ? (
            <div style={{ marginTop: 10 }}>
              <div className="field-label">跳过 {result.issues.length} 行：</div>
              <ul style={{ margin: '6px 0 0', paddingLeft: 18, color: 'var(--text-muted)', fontSize: 12.5 }}>
                {result.issues.slice(0, 5).map((issue) => (
                  <li key={`${issue.line}-${issue.reason}`}>
                    第 {issue.line} 行：{issue.reason}
                  </li>
                ))}
                {result.issues.length > 5 ? <li>…还有 {result.issues.length - 5} 行</li> : null}
              </ul>
            </div>
          ) : null}
        </div>
      ) : null}
    </Modal>
  );
}
