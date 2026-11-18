import './intake-registration.css';

/** Display grouping never changes the configured billing rule value. */
export default function VehicleClassChoices({ options, value, disabled, defaultValue, onChange }: {
  options: string[]; value: string; disabled?: boolean; defaultValue?: string; onChange: (value: string) => void;
}) {
  const compact = (s: string) => s.replace(/[-－\s]/g, '');
  const groups = [
    { label: '住户车', match: (s: string) => /^住户车\d*$/.test(compact(s)) },
    { label: '租户车', match: (s: string) => /^租户车\d*$/.test(compact(s)) },
    { label: '亲情车', match: (s: string) => compact(s) === '亲情车' },
    { label: '其他类别', match: (s: string) => !/^(住户车\d*|租户车\d*|亲情车)$/.test(compact(s)) },
  ];
  return <fieldset className="vehicle-class-choices" disabled={disabled}>
    <legend>车辆类别</legend>
    {groups.map(g => {
      const rows = [...new Set(options)].filter(g.match).sort((a, b) => compact(a).localeCompare(compact(b), 'zh-CN', { numeric: true }));
      return rows.length ? <div className="vehicle-class-row" key={g.label} role="group" aria-label={g.label}>
        <span className="vehicle-class-group">{g.label}</span><div className="vehicle-class-options">
          {rows.map(option => <button type="button" key={option} className={`chip ${value === option ? 'on' : ''}`} aria-pressed={value === option} onClick={() => onChange(option)}>{compact(option)}{option === defaultValue ? <small>默认</small> : null}</button>)}
        </div>
      </div> : null;
    })}
  </fieldset>;
}
