/** 大屏线性图标：与已确认稿保持一致，直接绘制SVG，不依赖字体或远程资源。 */
export type ScreenActionKind = 'promise' | 'arrears' | 'dispute';
export default function ScreenActionIcon({ kind }: { kind: ScreenActionKind }) {
  return <svg className="dec-action-icon" viewBox="0 0 32 32" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
    {kind === 'promise' ? <><path d="M18 27H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h19a2 2 0 0 1 2 2v8M4 12h23M10 3v6M21 3v6M9 17h4M9 22h4"/><circle cx="23" cy="23" r="6"/><path d="M23 19v4l3 2"/></>
      : kind === 'arrears' ? <><ellipse cx="13" cy="9" rx="9" ry="4"/><path d="M4 9v6c0 2 4 4 9 4h2M4 15v6c0 2 4 4 9 4h2M4 21v5c0 2 4 4 9 4h2M22 9v5"/><circle cx="23" cy="22" r="7"/><path d="M23 18v5M23 26h.01"/></>
        : <><path d="M17 28H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h14l6 6v7M19 3v7h7M9 10h5M9 15h8M9 20h5"/><circle cx="23" cy="23" r="5"/><path d="m27 27 4 4"/></>}
  </svg>;
}
