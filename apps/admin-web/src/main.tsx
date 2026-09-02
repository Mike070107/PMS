import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { ConfigProvider, App as AntdApp } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import 'dayjs/locale/zh-cn';
import App from './App';
import { configureApi, request } from './lib/api';
import { auth } from './lib/auth';
import { antdTheme } from './theme';
import './styles.css';

configureApi();

// 未捕获异常集中上报；同一错误一分钟内只记一次，避免一个渲染问题刷满日志。
let lastReported = '';
let lastReportedAt = 0;
function reportClientError(message: string, stack?: string) {
  const fingerprint = `${message}\n${stack || ''}`.slice(0, 800);
  const now = Date.now();
  if (!auth.getToken() || (fingerprint === lastReported && now - lastReportedAt < 60_000)) return;
  lastReported = fingerprint;
  lastReportedAt = now;
  void request({
    method: 'POST',
    url: '/observability/client-errors',
    data: {
      source: 'admin-web',
      message: String(message || '网页发生未知异常').slice(0, 500),
      stack: String(stack || '').slice(0, 4000),
      route: window.location.pathname,
      version: import.meta.env.VITE_APP_VERSION || '',
    },
  }).catch(() => undefined);
}

window.addEventListener('error', (event) => {
  reportClientError(event.message, event.error?.stack);
});
window.addEventListener('unhandledrejection', (event) => {
  const reason = event.reason;
  reportClientError(reason?.message || String(reason || '未处理的异步异常'), reason?.stack);
});

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ConfigProvider locale={zhCN} theme={antdTheme}>
      <AntdApp>
        <BrowserRouter>
          <App />
        </BrowserRouter>
      </AntdApp>
    </ConfigProvider>
  </React.StrictMode>,
);
