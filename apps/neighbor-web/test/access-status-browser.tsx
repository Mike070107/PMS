import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import AccessCards from '../src/pages/AccessCards';
import AccessDevices from '../src/pages/AccessDevices';
import { IconSprite } from '../src/components/Icon';
import '../src/styles/design.css';
import '../src/styles/app.css';
import '../src/styles/large.css';
import '../src/styles/guards.css';
import '../src/styles/access-door.css';

// ?recent-stall：模拟助手一直不回传，验证自动重试耗尽后页面露出「重试」入口。
if (typeof location !== 'undefined' && location.search.includes('recent-stall')) {
  (window as any).__recentMode = 'stall';
}

/**
 * 门禁发卡 / 设备管理回归夹具：真实页面组件 + 合成接口（test/access-status-browser-api.ts）。
 * 合成账号、合成小区、不连接任何真实服务器或设备。
 */
function Fixture() {
  const [revision, setRevision] = useState(0);
  const [view, setView] = useState<'cards' | 'devices'>('cards');
  return (
    <>
      <button
        id="scenario-nodoor"
        type="button"
        onClick={() => {
          (window as any).__scenario = 'nodoor';
          setRevision((value) => value + 1);
        }}
      >
        合成：切换到没有二期联网门禁小区
      </button>
      <button id="show-devices" type="button" onClick={() => setView('devices')}>设备管理</button>
      <button id="show-cards" type="button" onClick={() => setView('cards')}>门禁发卡</button>
      <IconSprite />
      {view === 'cards' ? <AccessCards key={revision} /> : <AccessDevices key={revision} />}
    </>
  );
}

createRoot(document.getElementById('root')!).render(<Fixture />);
