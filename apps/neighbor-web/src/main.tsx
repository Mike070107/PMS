import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import UiPreferencesProvider from './components/UiPreferencesProvider';
import { configureApi } from './lib/api';
import { IconSprite } from './components/Icon';
import './styles/design.css';
import './styles/app.css';
import './styles/large.css';
import './styles/guards.css';
import { startLayoutGuard } from './lib/layoutGuard';

/**
 * 发布新版后，已经打开的页面再懒加载旧版的页面文件会失败（文件名带哈希，旧的已不在）→ 白屏。
 * 碰到这种加载失败就自动刷新一次拿新版；10 秒内不重复刷，避免网络真断时死循环。
 */
window.addEventListener('vite:preloadError', (event) => {
  const last = Number(sessionStorage.getItem('pms.chunkReload') || 0);
  if (Date.now() - last < 10_000) return;
  event.preventDefault();
  sessionStorage.setItem('pms.chunkReload', String(Date.now()));
  window.location.reload();
});

configureApi();
document.documentElement.dataset.appVersion = import.meta.env.VITE_APP_VERSION || '';
document.documentElement.dataset.buildCommit = import.meta.env.VITE_BUILD_COMMIT || '';

/** 子路径部署（/beta/）：路由 basename 跟着 vite base 走 */
const basename = import.meta.env.BASE_URL.replace(/\/$/, '') || '/';

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <IconSprite />
    <BrowserRouter basename={basename}>
      <UiPreferencesProvider><App /></UiPreferencesProvider>
    </BrowserRouter>
  </React.StrictMode>,
);

startLayoutGuard();
