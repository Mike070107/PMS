import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env || {};
const now = new Date();
const pad = (value: number) => String(value).padStart(2, '0');
const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;

export default defineConfig({
  plugins: [react()],
  define: {
    'import.meta.env.VITE_APP_VERSION': JSON.stringify(env.VITE_APP_VERSION || `2.0.${stamp}`),
    'import.meta.env.VITE_BUILD_DATE': JSON.stringify(env.VITE_BUILD_DATE || date),
    'import.meta.env.VITE_BUILD_COMMIT': JSON.stringify(env.VITE_BUILD_COMMIT || ''),
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
  server: {
    port: 5173,
    host: true,
    proxy: {
      '/api/v1': {
        target: env.PMS_DEV_API_TARGET || 'https://prsznh.cn',
        changeOrigin: true,
      },
    },
  },
  preview: {
    port: 4173,
    host: true,
  },
});
