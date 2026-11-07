/**
 * @steward/core —— 与平台无关的领域层。
 *
 * 这里刻意不依赖 React、DOM、Node 专有 API，也不依赖任何云厂商 SDK：
 * 同一份代码要能跑在 Tauri 的 WebView、Node 同步服务和测试里。
 */

export * from './types.js';
export * from './money.js';
export * from './id.js';
export * from './dashboard.js';

export * from './crypto/encoding.js';
export * from './crypto/keys.js';
export * from './crypto/vault.js';

export * from './sync/records.js';
export * from './sync/client.js';

export * from './bills/csv.js';

export * from './cloud/adapters.js';
