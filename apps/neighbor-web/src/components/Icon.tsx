import type { CSSProperties } from 'react';

/**
 * 图标集：24 网格、1.6 描边、圆头端点，颜色跟文字走（currentColor）。
 * 一个词对应一枚图标，不做同义多图。尺寸由 CSS 控制，默认 20px（大字版）。
 */
export const ICON_NAMES = [
  'today', 'kanban', 'file', 'book', 'cash', 'receipt', 'scale', 'car',
  'cpu', 'flow', 'box', 'clipboard', 'layers', 'home', 'users', 'shield',
  'building', 'chart', 'gear', 'qr', 'globe', 'log', 'search', 'bell', 'plus', 'chev',
] as const;

export type IconName = typeof ICON_NAMES[number];

const SPRITE: Array<[IconName, string]> = [
  ['today', '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>'],
  ['kanban', '<rect x="3" y="4" width="5" height="16" rx="1.5"/><rect x="10" y="4" width="5" height="10" rx="1.5"/><rect x="17" y="4" width="4" height="13" rx="1.5"/>'],
  ['file', '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h4"/>'],
  ['book', '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20V4a1 1 0 0 0-1-1H6.5A2.5 2.5 0 0 0 4 5.5z"/><path d="M8 7h8M8 11h6"/>'],
  ['cash', '<rect x="2.5" y="6" width="19" height="12" rx="2"/><circle cx="12" cy="12" r="2.5"/><path d="M6 10v4M18 10v4"/>'],
  ['receipt', '<path d="M6 3h12v18l-3-1.8-3 1.8-3-1.8L6 21z"/><path d="M9.5 8h5M9.5 12h5"/>'],
  ['scale', '<path d="M12 4v16M5 8h14"/><path d="M5 8l-2.5 5a3 3 0 0 0 5 0zM19 8l-2.5 5a3 3 0 0 0 5 0z"/>'],
  ['car', '<path d="M5 16h14M6 16l1.2-5.2A2 2 0 0 1 9.1 9h5.8a2 2 0 0 1 1.9 1.8L18 16v3H6z"/><circle cx="8" cy="19" r="1.4"/><circle cx="16" cy="19" r="1.4"/><path d="M10 12h4"/>'],
  ['cpu', '<rect x="7" y="7" width="10" height="10" rx="2"/><path d="M10 3v3M14 3v3M10 18v3M14 18v3M3 10h3M3 14h3M18 10h3M18 14h3"/>'],
  ['flow', '<circle cx="5" cy="6" r="2"/><circle cx="19" cy="12" r="2"/><circle cx="5" cy="18" r="2"/><path d="M7 6h7a3 3 0 0 1 3 3v1M7 18h7a3 3 0 0 0 3-3v-1"/>'],
  ['box', '<path d="M3 8l9-5 9 5v8l-9 5-9-5z"/><path d="M3 8l9 5 9-5M12 13v8"/>'],
  ['clipboard', '<rect x="5" y="4" width="14" height="17" rx="2"/><path d="M9 4h6v3H9z"/><path d="M8.5 12h7M8.5 16h4"/>'],
  ['layers', '<path d="M12 3l9 5-9 5-9-5z"/><path d="M3 13l9 5 9-5"/>'],
  ['home', '<path d="M4 10.5L12 4l8 6.5V20a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1z"/><path d="M10 21v-6h4v6"/>'],
  ['users', '<circle cx="9" cy="9" r="3"/><path d="M3.5 20a5.5 5.5 0 0 1 11 0"/><path d="M16 8.5a3 3 0 0 1 0 5.5M17 20a5 5 0 0 0-2-4"/>'],
  ['shield', '<path d="M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6z"/><path d="M9.5 12l2 2 3.5-4"/>'],
  ['building', '<rect x="4" y="4" width="10" height="17" rx="1"/><path d="M14 10h6v11h-6"/><path d="M7.5 8h1M11 8h1M7.5 12h1M11 12h1M7.5 16h1M11 16h1"/>'],
  ['chart', '<path d="M4 20V4"/><path d="M4 20h16"/><rect x="7" y="12" width="3" height="5"/><rect x="12" y="8" width="3" height="9"/><rect x="17" y="5" width="3" height="12"/>'],
  ['gear', '<circle cx="12" cy="12" r="3"/><path d="M12 3v2.5M12 18.5V21M3 12h2.5M18.5 12H21M5.6 5.6l1.8 1.8M16.6 16.6l1.8 1.8M5.6 18.4l1.8-1.8M16.6 7.4l1.8-1.8"/>'],
  ['qr', '<rect x="3.5" y="3.5" width="6" height="6" rx="1"/><rect x="14.5" y="3.5" width="6" height="6" rx="1"/><rect x="3.5" y="14.5" width="6" height="6" rx="1"/><path d="M14.5 14.5h3v3h-3zM20.5 14.5v6h-6"/>'],
  ['globe', '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3.5 3 14 0 18-3-4-3-14.5 0-18z"/>'],
  ['log', '<path d="M4 6h16M4 12h16M4 18h10"/><circle cx="19.5" cy="18" r="1.2"/>'],
  ['search', '<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4 4"/>'],
  ['bell', '<path d="M6 9a6 6 0 0 1 12 0c0 4 1.5 5.5 1.5 5.5H4.5S6 13 6 9z"/><path d="M10 18a2 2 0 0 0 4 0"/>'],
  ['plus', '<path d="M12 5v14M5 12h14"/>'],
  ['chev', '<path d="M8 10l4 4 4-4"/>'],
];

/** 全局 sprite，挂一次；<use> 用 #pms-i-xxx 引用 */
export function IconSprite() {
  return (
    <svg width="0" height="0" style={{ position: 'absolute' }} aria-hidden="true">
      {SPRITE.map(([name, body]) => (
        <symbol key={name} id={`pms-i-${name}`} viewBox="0 0 24 24" dangerouslySetInnerHTML={{ __html: body }} />
      ))}
    </svg>
  );
}

export default function Icon({
  name, size, style, className,
}: {
  name: IconName;
  size?: number;
  style?: CSSProperties;
  className?: string;
}) {
  return (
    <svg
      className={`icon ${className || ''}`.trim()}
      style={size ? { width: size, height: size, ...style } : style}
      aria-hidden="true"
    >
      <use href={`#pms-i-${name}`} />
    </svg>
  );
}
