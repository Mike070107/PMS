import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env || {};
const now = new Date();
const pad = (v: number) => String(v).padStart(2, '0');
const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;

/**
 * 这套前端部署在生产同域的子路径 /beta/ 下（测试环境）。
 * 需要单独把产物指到别的路径时用 VITE_BASE 覆盖，例如本地 preview 用 /。
 */
export default defineConfig(({ command }) => ({
  base: env.VITE_BASE || (command === 'serve' ? '/' : '/beta/'),
  plugins: [react()],
  define: {
    'import.meta.env.VITE_APP_VERSION': JSON.stringify(env.VITE_APP_VERSION || `beta.${stamp}`),
    'import.meta.env.VITE_BUILD_COMMIT': JSON.stringify(env.VITE_BUILD_COMMIT || ''),
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
      'jszip': path.resolve(__dirname, '../api/node_modules/jszip'),
      '@pms/api-client': path.resolve(__dirname, '../../packages/api-client/src'),
      '@pms/shared-types': path.resolve(__dirname, '../../packages/shared-types/src'),
      // 养护单套打表单、手写体、打印：直接复用旧后台已调好的源码（含 14MB 字体），不复制一份
      '@legacy': path.resolve(__dirname, '../admin-web/src'),
    },
  },
  server: {
    port: 4173,
    host: '127.0.0.1',
    proxy: {
      '/api/v1': {
        target: env.PMS_DEV_API_TARGET || 'https://prsznh.cn',
        changeOrigin: true,
      },
    },
  },
  preview: { port: 4174, host: true },
}));
