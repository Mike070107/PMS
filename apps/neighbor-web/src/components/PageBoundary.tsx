import { Component, type ReactNode } from 'react';

/**
 * 页面级出错兜底：某个页面渲染时抛错，只把内容区换成出错提示，
 * 左侧菜单和顶栏还在，能直接点别的页面或重试 —— 不再整屏白掉、连返回都点不了。
 * 换页面（resetKey = 路径）自动复位。
 */
export default class PageBoundary extends Component<{ resetKey: string; children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  componentDidCatch(error: Error) { console.error('[page crash]', error); }
  componentDidUpdate(prev: { resetKey: string }) { if (prev.resetKey !== this.props.resetKey && this.state.error) this.setState({ error: null }); }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="card" style={{ padding: 28, maxWidth: 640 }}>
        <h2 style={{ fontSize: 18, marginBottom: 8 }}>这个页面出错了</h2>
        <p className="muted" style={{ marginBottom: 14 }}>其他页面不受影响，可以点左侧菜单继续操作。错误已记在浏览器控制台：{this.state.error.message}</p>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button className="btn p" onClick={() => this.setState({ error: null })}>重试</button>
          <button className="btn" onClick={() => window.history.back()}>返回上一页</button>
        </div>
      </div>
    );
  }
}
