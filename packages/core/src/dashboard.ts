import { summarizeHosts } from './cloud/adapters.js';
import type {
  Card,
  Currency,
  DashboardSnapshot,
  Host,
  Statement,
} from './types.js';

/**
 * 首页聚合。所有金额都按「分」计算，跨币种不做隐式换算：
 * 快照里只统计主币种（默认 CNY）的部分，其余币种单独展示。
 */
export function buildDashboard(input: {
  cards: Card[];
  statements: Statement[];
  hosts: Host[];
  now?: number;
  primaryCurrency?: Currency;
}): DashboardSnapshot {
  const now = input.now ?? Date.now();
  const primaryCurrency = input.primaryCurrency ?? 'CNY';

  const activeCards = input.cards.filter((c) => !c.archived);

  let totalAssetsMinor = 0;
  for (const card of activeCards) {
    if (card.kind === 'debit' && card.currency === primaryCurrency && card.balanceMinor) {
      totalAssetsMinor += card.balanceMinor;
    }
  }

  let creditUsedMinor = 0;
  let creditLimitMinor = 0;
  for (const card of activeCards) {
    if (card.kind !== 'credit' || card.currency !== primaryCurrency) continue;
    creditLimitMinor += card.creditLimitMinor ?? 0;
  }

  const upcomingDue: Statement[] = [];
  for (const statement of input.statements) {
    const card = input.cards.find((c) => c.id === statement.cardId);
    if (!card || card.archived) continue;
    if (statement.currency === primaryCurrency && !statement.isPaid) {
      creditUsedMinor += statement.totalAmountMinor;
    }
    const due = Date.parse(statement.dueDate);
    if (!statement.isPaid && due >= startOfDay(now) && due <= now + 45 * 86_400_000) {
      upcomingDue.push(statement);
    }
  }
  upcomingDue.sort((a, b) => Date.parse(a.dueDate) - Date.parse(b.dueDate));

  const hostSummary = summarizeHosts(input.hosts, now);
  const monthlyCloudCostMinor = hostSummary.monthlyCostByCurrency.get(primaryCurrency) ?? 0;

  return {
    totalAssetsMinor,
    currency: primaryCurrency,
    creditUsedMinor,
    creditLimitMinor,
    hostsRunning: hostSummary.byStatus.running,
    hostsTotal: hostSummary.total,
    monthlyCloudCostMinor,
    upcomingDue,
    expiringHosts: hostSummary.expiringSoon,
  };
}

export function startOfDay(timestamp: number): number {
  const d = new Date(timestamp);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** 距还款日的自然日数，负数表示已逾期。 */
export function daysUntilDue(dueDate: string, now: number = Date.now()): number {
  const due = Date.parse(dueDate);
  if (Number.isNaN(due)) return Number.NaN;
  return Math.round((startOfDay(due) - startOfDay(now)) / 86_400_000);
}

/**
 * 信用卡使用率。分母为 0（未设置额度）时返回 null，
 * 而不是 0 或 Infinity —— UI 需要区分「没设额度」和「没欠款」。
 */
export function creditUtilization(usedMinor: number, limitMinor: number): number | null {
  if (limitMinor <= 0) return null;
  return Math.min(1, Math.max(0, usedMinor / limitMinor));
}

/** 生成下期账单日/还款日（按自然月推算，遇到月末做截断）。 */
export function nextDueDates(billingDay: number, dueDay: number, from: Date = new Date()): { billingDate: string; dueDate: string } {
  const clamp = (day: number, year: number, month: number): Date => {
    const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
    return new Date(Date.UTC(year, month, Math.min(day, lastDay)));
  };
  const year = from.getUTCFullYear();
  const month = from.getUTCMonth();
  let billing = clamp(billingDay, year, month);
  if (billing.getTime() < from.getTime()) billing = clamp(billingDay, year, month + 1);
  let due = clamp(dueDay, billing.getUTCFullYear(), billing.getUTCMonth());
  if (due.getTime() <= billing.getTime()) {
    due = clamp(dueDay, billing.getUTCFullYear(), billing.getUTCMonth() + 1);
  }
  return { billingDate: toDateString(billing), dueDate: toDateString(due) };
}

function toDateString(date: Date): string {
  return date.toISOString().slice(0, 10);
}
