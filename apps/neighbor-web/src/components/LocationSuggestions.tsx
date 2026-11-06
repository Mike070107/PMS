import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { normalizeLocation, visibleLocationCount, type LocationOption } from '@/lib/repair-location-options';

/** Width-measured single row. Extra choices remain keyboard-accessible in 'more'. */
export default function LocationSuggestions({ options, value, onSelect, disabled = false }: {
  options: LocationOption[]; value: string; onSelect: (value: string) => void; disabled?: boolean;
}) {
  const root = useRef<HTMLDivElement>(null);
  const measure = useRef<HTMLDivElement>(null);
  const details = useRef<HTMLDetailsElement>(null);
  const [visible, setVisible] = useState(0);
  useLayoutEffect(() => {
    const update = () => {
      if (!root.current || !measure.current) return;
      const sizes = [...measure.current.querySelectorAll<HTMLElement>('[data-location-measure]')].map(e => e.getBoundingClientRect().width);
      const moreWidth = measure.current.querySelector<HTMLElement>('[data-more-measure]')?.getBoundingClientRect().width ?? 64;
      setVisible(visibleLocationCount(root.current.getBoundingClientRect().width, sizes, moreWidth));
    };
    update();
    const observer = new ResizeObserver(update);
    if (root.current) observer.observe(root.current);
    if (measure.current) observer.observe(measure.current);
    document.fonts?.ready.then(update).catch(() => {});
    return () => observer.disconnect();
  }, [options]);
  useEffect(() => {
    const close = (event: MouseEvent) => { if (!details.current?.contains(event.target as Node) && details.current) details.current.open = false; };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);
  const button = ({ text }: LocationOption) => <button type="button" key={text} className={`chip ${normalizeLocation(value) === text ? 'on' : ''}`} aria-pressed={normalizeLocation(value) === text} disabled={disabled} onClick={() => { onSelect(text); if (details.current) details.current.open = false; }}>{text}</button>;
  return <div ref={root} className="new-order-spots" role="group" aria-label="常用位置">
    {options.slice(0, visible).map(button)}
    {visible < options.length ? <details ref={details} className="new-order-spots-more" onKeyDown={e => { if (e.key === 'Escape') { e.preventDefault(); e.currentTarget.open = false; e.currentTarget.querySelector('summary')?.focus(); } }}>
      <summary className="chip" aria-label="更多常用位置">更多 ▾</summary>
      <div className="new-order-spots-menu" aria-label="更多常用位置选项">{options.slice(visible).map(button)}</div>
    </details> : null}
    <div ref={measure} className="new-order-spots-measure" aria-hidden="true">
      {options.map(({ text }) => <span className="chip" data-location-measure key={text}>{text}</span>)}
      <span className="chip" data-more-measure>更多 ▾</span>
    </div>
  </div>;
}
