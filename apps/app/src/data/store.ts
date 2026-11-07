import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import {
  createCloudAdapter,
  deriveSyncKey,
  fromStoredKdfConfig,
  newPrefixedId,
  pairDevice,
  parseStatementCsv,
  performSync,
  toMinorUnits,
  type StoredKdfConfig,
  type ImportIssue,
  type Card,
  type CardKind,
  type CardNetwork,
  type CloudAccount,
  type CloudProviderId,
  type Currency,
  type Host,
  type ISODate,
  type Statement,
  type StatementLine,
  type ImportResult,
} from '@steward/core';
import { createSeedData } from './seed';
import { deleteSecret, getSecret, setSecret } from './secrets';

export interface NewCardInput {
  kind: CardKind;
  issuer: string;
  network: CardNetwork;
  nickname: string;
  last4: string;
  currency: Currency;
  /** 以下金额单位为「元」，入库时统一转成分。 */
  creditLimit?: number;
  balance?: number;
  billingDay?: number;
  dueDay?: number;
}

export interface NewCloudAccountInput {
  provider: CloudProviderId;
  alias: string;
  accessKeyId: string;
  accessKeySecret: string;
  regions: string[];
}

export interface SyncSettings {
  serverUrl: string;
  vaultId: string;
  deviceId: string;
  /** 服务端下发的 KDF 参数（salt 是公开的，口令本身永不落盘）。 */
  kdf?: StoredKdfConfig;
  /** 是否已完成配对并验证过口令。 */
  keyReady: boolean;
  lastSyncedAt?: string;
  lastError?: string;
}

export interface SyncStats {
  pulled: number;
  pushed: number;
  overwritten: number;
}

export interface ImportSummary {
  imported: number;
  issues: ImportIssue[];
  statement: Statement | null;
  meta: ImportResult['meta'];
}

interface AppState {
  cards: Card[];
  statements: Statement[];
  cloudAccounts: CloudAccount[];
  hosts: Host[];
  settings: SyncSettings;
  /** 同步口令只驻留内存，绝不写入 localStorage / SQLite。 */
  syncPassphrase: string;
  busy: string | null;
  lastError: string | null;

  addCard: (input: NewCardInput) => Card;
  archiveCard: (id: string) => void;
  restoreCard: (id: string) => void;
  importStatement: (cardId: string, text: string) => ImportSummary;
  markStatementPaid: (id: string) => void;

  addCloudAccount: (input: NewCloudAccountInput) => Promise<void>;
  removeCloudAccount: (id: string) => Promise<void>;
  syncCloudAccount: (id: string) => Promise<void>;
  setHostPower: (hostId: string, action: 'start' | 'stop' | 'reboot') => Promise<void>;

  pairWithCode: (code: string) => Promise<void>;
  syncNow: () => Promise<SyncStats>;
  updateSyncSettings: (patch: Partial<SyncSettings>) => void;
  setSyncPassphrase: (value: string) => void;
  resetDemoData: () => void;
  clearAll: () => void;
  setError: (message: string | null) => void;
}

const now = (): string => new Date().toISOString();

function defaultSettings(): SyncSettings {
  return { serverUrl: 'http://127.0.0.1:8787', vaultId: '', deviceId: '', keyReady: false };
}

const seed = createSeedData();

export const useAppStore = create<AppState>()(
  persist(
    (set, get) => ({
      cards: seed.cards,
      statements: seed.statements,
      cloudAccounts: seed.cloudAccounts,
      hosts: seed.hosts,
      settings: defaultSettings(),
      syncPassphrase: '',
      busy: null,
      lastError: null,

      addCard: (input) => {
        const card: Card = {
          id: newPrefixedId('card'),
          kind: input.kind,
          issuer: input.issuer.trim(),
          network: input.network,
          nickname: input.nickname.trim() || `${input.issuer} 卡`,
          last4: input.last4.replace(/\D/g, '').slice(-4).padStart(4, '0'),
          currency: input.currency,
          updatedAt: now(),
          ...(input.kind === 'credit' && input.creditLimit !== undefined
            ? { creditLimitMinor: toMinorUnits(input.creditLimit, input.currency) }
            : {}),
          ...(input.kind === 'debit' && input.balance !== undefined
            ? { balanceMinor: toMinorUnits(input.balance, input.currency), balanceUpdatedAt: now() }
            : {}),
          ...(input.billingDay ? { billingDay: input.billingDay } : {}),
          ...(input.dueDay ? { dueDay: input.dueDay } : {}),
        };
        set((state) => ({ cards: [card, ...state.cards] }));
        return card;
      },

      archiveCard: (id) =>
        set((state) => ({
          cards: state.cards.map((c) => (c.id === id ? { ...c, archived: true, updatedAt: now() } : c)),
        })),

      restoreCard: (id) =>
        set((state) => ({
          cards: state.cards.map((c) => (c.id === id ? { ...c, archived: false, updatedAt: now() } : c)),
        })),

      importStatement: (cardId, text) => {
        const card = get().cards.find((c) => c.id === cardId);
        const result = parseStatementCsv(text, { currency: card?.currency ?? 'CNY' });
        if (result.lines.length === 0) {
          return { imported: 0, issues: result.issues, statement: null, meta: result.meta };
        }

        const lines: StatementLine[] = result.lines.map((line) => ({
          id: newPrefixedId('line'),
          postedAt: line.postedAt,
          merchant: line.merchant,
          amountMinor: line.amountMinor,
          currency: line.currency,
          direction: line.direction,
          ...(line.note ? { note: line.note } : {}),
        }));

        const dates = lines.map((l) => l.postedAt).sort();
        const periodStart = dates[0] ?? new Date().toISOString().slice(0, 10);
        const periodEnd = dates[dates.length - 1] ?? periodStart;
        const total = lines.reduce(
          (sum, l) => sum + (l.direction === 'debit' ? l.amountMinor : -l.amountMinor),
          0,
        );
        const dueDate = computeDueDate(periodEnd, card?.dueDay ?? 25);

        const statement: Statement = {
          id: newPrefixedId('stmt'),
          cardId,
          periodStart: periodStart as ISODate,
          periodEnd: periodEnd as ISODate,
          dueDate,
          currency: card?.currency ?? 'CNY',
          totalAmountMinor: Math.max(0, total),
          minimumPaymentMinor: Math.round(Math.max(0, total) * 0.1),
          isPaid: false,
          lines,
          updatedAt: now(),
        };

        set((state) => ({ statements: [statement, ...state.statements] }));
        return { imported: lines.length, issues: result.issues, statement, meta: result.meta };
      },

      markStatementPaid: (id) =>
        set((state) => ({
          statements: state.statements.map((s) =>
            s.id === id ? { ...s, isPaid: true, paidAmountMinor: s.totalAmountMinor, updatedAt: now() } : s,
          ),
        })),

      addCloudAccount: async (input) => {
        const id = newPrefixedId('cloud');
        const secretRef = `cloud:${id}`;
        await setSecret(secretRef, JSON.stringify({ accessKeyId: input.accessKeyId, accessKeySecret: input.accessKeySecret }));
        const account: CloudAccount = {
          id,
          provider: input.provider,
          alias: input.alias,
          secretRef,
          regions: input.regions,
          updatedAt: now(),
        };
        set((state) => ({ cloudAccounts: [...state.cloudAccounts, account] }));
        await get().syncCloudAccount(id);
      },

      removeCloudAccount: async (id) => {
        const account = get().cloudAccounts.find((a) => a.id === id);
        if (account) await deleteSecret(account.secretRef);
        set((state) => ({
          cloudAccounts: state.cloudAccounts.filter((a) => a.id !== id),
          hosts: state.hosts.filter((h) => h.cloudAccountId !== id),
        }));
      },

      syncCloudAccount: async (id) => {
        const account = get().cloudAccounts.find((a) => a.id === id);
        if (!account) return;
        set({ busy: `sync:${id}`, lastError: null });
        try {
          const raw = await getSecret(account.secretRef);
          const credentials = raw
            ? (JSON.parse(raw) as { accessKeyId: string; accessKeySecret: string })
            : { accessKeyId: '', accessKeySecret: '' };
          const adapter = createCloudAdapter(account.provider);
          const result = await adapter.listHosts(credentials, account.regions);
          if (!result.ok || !result.data) throw new Error(result.error ?? '云厂商返回空结果');

          const normalized = result.data.map((host) => ({
            ...host,
            // Mock 适配器用 AccessKey 生成 ID；这里统一改成账号维度，保证多账号不串
            id: `${account.id}/${host.instanceId}`,
            cloudAccountId: account.id,
            updatedAt: now(),
          }));

          set((state) => ({
            hosts: [
              ...state.hosts.filter((h) => h.cloudAccountId !== account.id),
              ...normalized,
            ],
            cloudAccounts: state.cloudAccounts.map((a) =>
              a.id === account.id ? { ...a, lastSyncedAt: now(), lastSyncError: undefined, updatedAt: now() } : a,
            ),
            busy: null,
          }));
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          set((state) => ({
            busy: null,
            lastError: message,
            cloudAccounts: state.cloudAccounts.map((a) =>
              a.id === account.id ? { ...a, lastSyncError: message, updatedAt: now() } : a,
            ),
          }));
        }
      },

      setHostPower: async (hostId, action) => {
        const host = get().hosts.find((h) => h.id === hostId);
        if (!host) return;
        const account = get().cloudAccounts.find((a) => a.id === host.cloudAccountId);
        if (!account) return;

        const optimistic = action === 'stop' ? 'stopping' : action === 'start' ? 'starting' : 'rebooting';
        set((state) => ({
          hosts: state.hosts.map((h) => (h.id === hostId ? { ...h, status: optimistic } : h)),
          busy: `power:${hostId}`,
        }));

        try {
          const raw = await getSecret(account.secretRef);
          const credentials = raw
            ? (JSON.parse(raw) as { accessKeyId: string; accessKeySecret: string })
            : { accessKeyId: '', accessKeySecret: '' };
          const adapter = createCloudAdapter(account.provider);
          const result =
            action === 'stop'
              ? await adapter.stopHost(credentials, host)
              : action === 'start'
                ? await adapter.startHost(credentials, host)
                : await adapter.rebootHost(credentials, host);
          if (!result.ok) throw new Error(result.error ?? '操作失败');

          set((state) => ({
            hosts: state.hosts.map((h) =>
              h.id === hostId ? { ...h, status: action === 'stop' ? 'stopped' : 'running', updatedAt: now() } : h,
            ),
            busy: null,
          }));
        } catch (error) {
          set((state) => ({
            hosts: state.hosts.map((h) => (h.id === hostId ? { ...h, status: host.status } : h)),
            busy: null,
            lastError: error instanceof Error ? error.message : String(error),
          }));
        }
      },

      pairWithCode: async (code) => {
        const { settings, syncPassphrase } = get();
        if (!settings.vaultId) throw new Error('请先填写 Vault ID');
        if (!syncPassphrase) throw new Error('请先设置同步口令');

        set({ busy: 'pair', lastError: null });
        try {
          const response = await pairDevice(settings.serverUrl, code, {
            vaultId: settings.vaultId,
            deviceName: deviceLabel(),
            platform: platformName(),
          });
          if (!response.kdf) throw new Error('服务器未返回 KDF 参数');

          // 立刻验证口令能否派生出密钥，避免用户带着错口令去同步
          const { salt, params } = fromStoredKdfConfig(response.kdf);
          await deriveSyncKey(syncPassphrase, salt, params);

          await setSecret('sync:deviceToken', response.deviceToken);
          set((state) => ({
            busy: null,
            settings: {
              ...state.settings,
              deviceId: response.deviceId,
              kdf: response.kdf,
              keyReady: true,
              lastError: undefined,
            },
          }));
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          set((state) => ({ busy: null, lastError: message, settings: { ...state.settings, lastError: message } }));
          throw error;
        }
      },

      syncNow: async () => {
        const state = get();
        const { settings, syncPassphrase } = state;
        if (!settings.kdf || !settings.deviceId) throw new Error('尚未配对设备');
        if (!syncPassphrase) throw new Error('请输入同步口令');

        const deviceToken = await getSecret('sync:deviceToken');
        if (!deviceToken) throw new Error('本机缺少设备令牌，请重新配对');

        set({ busy: 'sync', lastError: null });
        try {
          const { salt, params } = fromStoredKdfConfig(settings.kdf);
          const key = await deriveSyncKey(syncPassphrase, salt, params);
          const result = await performSync({
            serverUrl: settings.serverUrl,
            vaultId: settings.vaultId,
            deviceId: settings.deviceId,
            deviceToken,
            key,
            cards: state.cards,
            statements: state.statements,
            cloudAccounts: state.cloudAccounts,
          });

          const accountIds = new Set(result.cloudAccounts.map((a) => a.id));
          set((current) => ({
            cards: result.cards,
            statements: result.statements,
            cloudAccounts: result.cloudAccounts,
            hosts: current.hosts.filter((h) => accountIds.has(h.cloudAccountId)),
            busy: null,
            settings: { ...current.settings, lastSyncedAt: new Date().toISOString(), lastError: undefined },
          }));
          return result.stats;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          set((current) => ({
            busy: null,
            lastError: message,
            settings: { ...current.settings, lastError: message },
          }));
          throw error;
        }
      },

      updateSyncSettings: (patch) => set((state) => ({ settings: { ...state.settings, ...patch } })),
      setSyncPassphrase: (value) => set({ syncPassphrase: value }),

      resetDemoData: () => {
        const fresh = createSeedData();
        set({
          cards: fresh.cards,
          statements: fresh.statements,
          cloudAccounts: fresh.cloudAccounts,
          hosts: fresh.hosts,
        });
      },

      clearAll: () => set({ cards: [], statements: [], cloudAccounts: [], hosts: [] }),

      setError: (message) => set({ lastError: message }),
    }),
    {
      name: 'steward.state.v1',
      version: 1,
      partialize: (state) => ({
        cards: state.cards,
        statements: state.statements,
        cloudAccounts: state.cloudAccounts,
        hosts: state.hosts,
        settings: state.settings,
        // syncPassphrase 刻意不持久化
      }),
    },
  ),
);

/** 根据账单月 + 还款日推算还款日；跨月时顺延。 */
function computeDueDate(periodEnd: string, dueDay: number): ISODate {
  const end = new Date(`${periodEnd}T00:00:00Z`);
  if (Number.isNaN(end.getTime())) return new Date().toISOString().slice(0, 10);

  const sameMonth = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), Math.min(dueDay, 28)));
  if (sameMonth.getTime() > end.getTime()) {
    return sameMonth.toISOString().slice(0, 10);
  }
  const next = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() + 1, Math.min(dueDay, 28)));
  return next.toISOString().slice(0, 10);
}

function platformName(): string {
  if (typeof navigator === 'undefined') return 'unknown';
  const ua = navigator.userAgent.toLowerCase();
  if (ua.includes('iphone') || ua.includes('ipad')) return 'ios';
  if (ua.includes('android')) return 'android';
  if (ua.includes('mac')) return 'macos';
  if (ua.includes('win')) return 'windows';
  if (ua.includes('linux')) return 'linux';
  return 'web';
}

function deviceLabel(): string {
  if (typeof navigator === 'undefined') return '未知设备';
  const platform = platformName();
  const names: Record<string, string> = {
    macos: 'Mac',
    windows: 'Windows PC',
    linux: 'Linux',
    ios: 'iPhone / iPad',
    android: 'Android 设备',
    web: '浏览器',
  };
  return names[platform] ?? '设备';
}
