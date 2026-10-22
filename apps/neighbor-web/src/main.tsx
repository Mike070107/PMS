import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import { configureApi } from './lib/api';
import { IconSprite } from './components/Icon';
import './styles/design.css';
import './styles/app.css';
import './styles/large.css';

configureApi();

/** 子路径部署（/beta/）：路由 basename 跟着 vite base 走 */
const basename = import.meta.env.BASE_URL.replace(/\/$/, '') || '/';

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <IconSprite />
    <BrowserRouter basename={basename}>
      <App />
    </BrowserRouter>
  </React.StrictMode>,
);
