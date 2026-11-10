import { useEffect, useRef, useState } from 'react';
import { request } from '@pms/api-client';
import { toast } from '@/components/ui';
import { Section, errMsg } from './parts';

type Office = { id: number; name: string };
type RecipientOptions = { officeId: number; users: Array<{ id: number; name: string | null }>; selected: number[] | null };

export function DispatchNoticeSection({ canEdit }: { canEdit: boolean }) {
  const [offices, setOffices] = useState<Office[]>([]);
  const [officeId, setOfficeId] = useState('');
  const [data, setData] = useState<RecipientOptions | null>(null);
  const [selected, setSelected] = useState<number[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const choices = useRef<HTMLFieldSetElement>(null);

  useEffect(() => {
    request<Office[]>({ url: '/settings/dispatch-recipients/offices' }).then(setOffices)
      .catch((e) => setError(errMsg(e, '管理处加载失败')));
  }, []);

  useEffect(() => {
    if (!officeId) { setData(null); return; }
    let current = true;
    setLoading(true); setData(null); setError('');
    request<RecipientOptions>({ url: `/settings/dispatch-recipients/${officeId}` })
      .then((result) => { if (current) { setData(result); setSelected(result.selected || []); } })
      .catch((e) => { if (current) setError(errMsg(e, '通知人员加载失败')); })
      .finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [officeId]);

  const missing = selected.filter((id) => !data?.users.some((user) => user.id === id));
  const save = async () => {
    if (!selected.length || missing.length) {
      setError(missing.length ? '请先移除已失效的人员，再保存' : '请至少选择一位通知人员');
      choices.current?.focus();
      return;
    }
    setSaving(true); setError('');
    try {
      const result = await request<RecipientOptions>({ method: 'PATCH', url: '/settings/dispatch-recipients', data: { officeId: Number(officeId), userIds: selected } });
      setData(result); setSelected(result.selected || []); toast('通知人员已保存');
    } catch (e) { setError(errMsg(e, '保存失败，选择已保留')); }
    finally { setSaving(false); }
  };

  return (
    <Section title="待办公室派单通知" desc="未识别类型或未找到可接单人员时，按报修所属管理处通知指定人员。">
      <label className="dispatch-notice__label" htmlFor="dispatch-office">管理处</label>
      <select id="dispatch-office" className="in" value={officeId} disabled={saving} onChange={(e) => { setOfficeId(e.target.value); setError(''); }}>
        <option value="">请选择管理处</option>
        {offices.map((office) => <option value={office.id} key={office.id}>{office.name}</option>)}
      </select>
      {loading ? <p className="muted">正在读取通知人员…</p> : null}
      {data ? <>
        <p className="dispatch-notice__hint">{data.selected === null ? '尚未单独配置，此管理处仍按原规则通知所有有派单权限且覆盖本处的人员。' : '已启用指定人员。人员停用或失去权限后不会收到通知。'}</p>
        <fieldset ref={choices} tabIndex={-1} className={`dispatch-notice__choices ${error ? 'dispatch-notice__choices--error' : ''}`} aria-invalid={!!error} aria-describedby="dispatch-notice-error">
          <legend>通知人员 <span className="dispatch-notice__required">*</span></legend>
          {data.users.length ? data.users.map((user) => (
            <label className="dispatch-notice__choice" key={user.id}>
              <input type="checkbox" checked={selected.includes(user.id)} disabled={!canEdit || saving} onChange={(event) => {
                setSelected((previous) => event.target.checked ? [...previous, user.id] : previous.filter((id) => id !== user.id));
                setError('');
              }} />
              <span>{user.name || `员工 #${user.id}`}</span>
            </label>
          )) : <p className="muted">没有符合条件的在职派单人员，请先检查其派单权限和工作范围。</p>}
          {missing.map((id) => <label className="dispatch-notice__choice" key={id}>
            <input type="checkbox" checked disabled={!canEdit || saving} onChange={() => { setSelected((previous) => previous.filter((value) => value !== id)); setError(''); }} />
            <span>员工 #{id} 已停用或不再符合权限，请取消勾选</span>
          </label>)}
        </fieldset>
        {error ? <p id="dispatch-notice-error" className="dispatch-notice__error" role="alert">{error}</p> : null}
        {canEdit ? <button type="button" className="btn p" disabled={saving} onClick={() => void save()}>{saving ? '保存中…' : '保存通知人员'}</button> : null}
      </> : null}
      {error && !data ? <p id="dispatch-notice-error" className="dispatch-notice__error" role="alert">{error}</p> : null}
    </Section>
  );
}
