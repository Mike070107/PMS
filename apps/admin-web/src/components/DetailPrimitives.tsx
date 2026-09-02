import type { ReactNode } from 'react';

export function DetailHero({
  eyebrow,
  title,
  description,
  tags,
  meta,
  visual,
  actions,
}: {
  eyebrow?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  tags?: ReactNode;
  meta?: ReactNode;
  visual?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <section className="pms-detail-hero">
      <div className="pms-detail-hero-main">
        {eyebrow && <div className="pms-detail-eyebrow">{eyebrow}</div>}
        <div className="pms-detail-title-row">
          <h2>{title}</h2>
          {tags && <div className="pms-detail-tags">{tags}</div>}
        </div>
        {description && <div className="pms-detail-description">{description}</div>}
        {meta && <div className="pms-detail-meta">{meta}</div>}
      </div>
      {visual && <div className="pms-detail-visual">{visual}</div>}
      {actions && <div className="pms-detail-actions">{actions}</div>}
    </section>
  );
}

export function DetailMetrics({
  items,
}: {
  items: Array<{ label: ReactNode; value: ReactNode; tone?: 'normal' | 'warning' | 'danger' | 'success' }>;
}) {
  return (
    <div className="pms-detail-metrics">
      {items.map((item, index) => (
        <div className={`pms-detail-metric is-${item.tone || 'normal'}`} key={index}>
          <span>{item.label}</span>
          <strong>{item.value}</strong>
        </div>
      ))}
    </div>
  );
}

export function DetailSection({
  title,
  description,
  extra,
  children,
}: {
  title: ReactNode;
  description?: ReactNode;
  extra?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="pms-detail-section">
      <div className="pms-detail-section-heading">
        <div><strong>{title}</strong>{description && <span>{description}</span>}</div>
        {extra}
      </div>
      {children}
    </section>
  );
}
