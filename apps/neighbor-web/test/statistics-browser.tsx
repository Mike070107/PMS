import { createRoot } from 'react-dom/client';
import Statistics from '../src/pages/Statistics';
import { IconSprite } from '../src/components/Icon';
import { Toaster } from '../src/components/ui';
import '../src/styles/design.css';
import '../src/styles/app.css';
import '../src/styles/large.css';
import '../src/styles/guards.css';
import '../src/styles/statistics.css';

/**
 * 统计汇总回归夹具：真实 Statistics 组件 + 合成统计接口（test/statistics-browser-api.ts）。
 * 合成数据、不连接任何真实服务器；SQL 口径以 docs/statistics-reports-spec.md 验收基准为准。
 */
// ?options-unavailable：模拟 MIS 镜像未就绪，验证页面优先显示后端 message 而不是「暂无数据」。
if (typeof location !== 'undefined' && location.search.includes('options-unavailable')) {
  (window as any).__optionsUnavailable = true;
}

function Fixture() {
  return (
    // 用 padding-left 模拟真实后台左侧导航宽度，保证悬浮筛选面板与内容区的相对位置和线上一致。
    <div className="stats-fixture">
      <style>{`
        .stats-fixture { padding: 24px 28px 60px 280px; background: var(--bg); min-height: 100vh; }
        @media (max-width: 900px) { .stats-fixture { padding: 18px 16px 60px; } }
      `}</style>
      <IconSprite />
      <Statistics />
      <Toaster />
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<Fixture />);
