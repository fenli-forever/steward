import { create } from 'zustand';

/**
 * 自动更新。
 *
 * 桌面端（macOS / Windows / Linux）走 Tauri 的 updater 插件：
 *   检查 latest.json → 下载新包 → 校验签名 → 安装 → 重启。
 * 移动端不做：iOS / Android 的更新必须经过 App Store / Play，客户端自更新会被拒审。
 *
 * 所有 Tauri API 都是动态 import：浏览器预览模式下这些模块不可用，
 * 静态 import 会让 Web 构建在启动时就炸掉。
 */

export type UpdateStatus =
  | 'idle'
  | 'unsupported'
  | 'checking'
  | 'available'
  | 'up-to-date'
  | 'downloading'
  | 'ready'
  | 'error';

interface UpdateInfo {
  version: string;
  notes?: string;
  date?: string;
}

interface UpdaterState {
  status: UpdateStatus;
  currentVersion: string;
  available: UpdateInfo | null;
  progress: number | null;
  error: string | null;
  /** 启动时的静默检查不弹错误，避免每次开 App 都报「更新源没配好」 */
  silentFailure: boolean;
  check: (options?: { silent?: boolean }) => Promise<void>;
  install: () => Promise<void>;
  restart: () => Promise<void>;
  dismiss: () => void;
}

const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

/** 移动端不参与自动更新 */
function isDesktopTauri(): boolean {
  if (!isTauri) return false;
  const ua = navigator.userAgent.toLowerCase();
  if (ua.includes('iphone') || ua.includes('ipad') || ua.includes('android')) return false;
  return true;
}

type TauriUpdate = {
  version: string;
  body?: string;
  date?: string;
  downloadAndInstall: (cb: (event: unknown) => void) => Promise<void>;
};

let pendingUpdate: TauriUpdate | null = null;

async function loadUpdater(): Promise<{
  check: () => Promise<TauriUpdate | null>;
  relaunch: () => Promise<void>;
  getVersion: () => Promise<string>;
}> {
  const [{ check }, { relaunch }, { getVersion }] = await Promise.all([
    import('@tauri-apps/plugin-updater'),
    import('@tauri-apps/plugin-process'),
    import('@tauri-apps/api/app'),
  ]);
  return { check: check as unknown as () => Promise<TauriUpdate | null>, relaunch, getVersion };
}

export const useUpdater = create<UpdaterState>()((set, get) => ({
  status: isDesktopTauri() ? 'idle' : 'unsupported',
  currentVersion: '0.1.0',
  available: null,
  progress: null,
  error: null,
  silentFailure: false,

  check: async (options = {}) => {
    if (!isDesktopTauri()) {
      set({ status: 'unsupported' });
      return;
    }
    if (get().status === 'checking' || get().status === 'downloading') return;

    set({ status: 'checking', error: null, silentFailure: options.silent ?? false });
    try {
      const { check, getVersion } = await loadUpdater();
      const currentVersion = await getVersion().catch(() => get().currentVersion);
      const update = await check();

      if (!update) {
        set({ status: 'up-to-date', currentVersion, available: null });
        return;
      }
      pendingUpdate = update;
      set({
        status: 'available',
        currentVersion,
        available: {
          version: update.version,
          ...(update.body ? { notes: update.body } : {}),
          ...(update.date ? { date: update.date } : {}),
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      set({
        status: 'error',
        error: options.silent ? '暂时无法检查更新（更新源未配置或网络不可用）' : message,
      });
    }
  },

  install: async () => {
    if (!pendingUpdate) {
      set({ status: 'error', error: '没有待安装的更新' });
      return;
    }
    set({ status: 'downloading', progress: 0, error: null });

    let contentLength = 0;
    let received = 0;

    try {
      await pendingUpdate.downloadAndInstall((event: unknown) => {
        const payload = event as { event?: string; data?: { contentLength?: number; chunkLength?: number } };
        if (payload.event === 'Started') {
          contentLength = payload.data?.contentLength ?? 0;
          received = 0;
          set({ progress: contentLength > 0 ? 0 : null });
        } else if (payload.event === 'Progress') {
          received += payload.data?.chunkLength ?? 0;
          set({ progress: contentLength > 0 ? Math.min(1, received / contentLength) : null });
        } else if (payload.event === 'Finished') {
          set({ progress: 1 });
        }
      });
      set({ status: 'ready', progress: 1 });
    } catch (error) {
      set({
        status: 'error',
        error: error instanceof Error ? error.message : String(error),
        progress: null,
      });
    }
  },

  restart: async () => {
    if (!isDesktopTauri()) return;
    const { relaunch } = await loadUpdater();
    await relaunch();
  },

  dismiss: () => set({ available: null, status: 'idle' }),
}));

/** 供 App 启动时调用：静默检查一次，失败不打扰用户。 */
export function autoCheckForUpdates(): void {
  if (!isDesktopTauri()) return;
  void useUpdater.getState().check({ silent: true });
}
