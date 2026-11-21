import { useId } from 'react';
import './intake-registration.css';

export function vehicleClassLabel(value: string) {
  return value === '产权车位' ? '产权车' : value.replace(/[-－\s]/g, '');
}

export function vehicleClassCaption(value: string, spaces: string[] = []) {
  const label = vehicleClassLabel(value);
  return label === '产权车' && spaces.length ? `${label}（${spaces.join('、')}）` : label;
}

/** Display grouping never changes the configured billing rule value. */
export default function VehicleClassChoices({ options, value, disabled, readOnly, defaultValue, disabledOptions = [], spaces = [], onChange }: {
  options: string[]; spaces?: string[]; value: string; disabled?: boolean; disabledOptions?: string[]; readOnly?: boolean; defaultValue?: string; onChange: (value: string) => void;
}) {
  const name = useId();
  const choices = [...new Set([...options, ...(value ? [value] : [])])];
  const byLabel = new Map<string, string>();
  for (const option of choices) {
    const label = vehicleClassLabel(option);
    if (!byLabel.has(label) || option === value) byLabel.set(label, option);
  }
  const groups = new Map<string, string[]>(['住户车', '租户车', '亲情车', '产权车'].map(label => [label, []]));
  for (const [label, option] of byLabel) {
    const group = label.match(/^(住户车|租户车)\d*$/)?.[1] || label;
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group)!.push(option);
  }
  if (readOnly) return <div className="vehicle-class-field"><b>车辆类别</b><span>{value ? vehicleClassCaption(value, spaces) : '未设置'}</span></div>;
  return <fieldset className="vehicle-class-radios" disabled={disabled}>
    <legend>车辆类别</legend>
    <div className="vehicle-class-groups">
      {Array.from(groups, ([group, rows]) => {
        rows.sort((a,b) => vehicleClassLabel(a).localeCompare(vehicleClassLabel(b), 'zh-CN', { numeric: true }));
        return rows.length > 0 && <div className="vehicle-class-group" key={group} role="group" aria-label={group}>
          {rows.map(option => <label key={option}>
            <input type="radio" name={name} value={option} disabled={disabledOptions.includes(option)} checked={value === option} onChange={() => onChange(option)} />
            {vehicleClassCaption(option, spaces)}{option === defaultValue && !value && <small>默认</small>}
          </label>)}
        </div>;
      })}
    </div>
  </fieldset>;
}
