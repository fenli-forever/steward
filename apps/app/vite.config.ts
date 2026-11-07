import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Tauri 在开发时通过固定端口访问前端，因此不要让它自动换端口。
const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
    ...(host ? { host, hmr: { protocol: 'ws', host, port: 5183 } } : {}),
  },
  envPrefix: ['VITE_', 'TAURI_'],
  build: {
    target: process.env.TAURI_ENV_PLATFORM === 'windows' ? 'chrome105' : 'safari15',
    minify: process.env.TAURI_ENV_DEBUG ? false : 'esbuild',
    sourcemap: Boolean(process.env.TAURI_ENV_DEBUG),
  },
});
