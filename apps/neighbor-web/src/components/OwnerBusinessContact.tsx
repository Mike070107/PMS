import { useEffect, useId, useRef, useState } from 'react';
import { request } from '@pms/api-client';
import { can } from '@/lib/perm';
import { useSession } from '@/lib/auth';
import './owner-business-contact.css';

export type BusinessOwner = { id: number; name: string | null; phone: string | null; contactPhones?: string[];
  phoneActivity?: Array<{ phone: string; last_confirmed_at?: string | null; confirmation_source?: string | null }> };
type Props = { source: 'cashier' | 'parking'; houseId?: number; buildingId?: number; preferredOwnerId?: number; onSaved?: (owner: BusinessOwner) => void; disabled?: boolean };
const allPhones = (r: BusinessOwner) => [...new Set([r.phone,...(r.contactPhones || [])].filter((p): p is string => !!p))];
const confirmationTime = (s?: string | null) => !s || Number.isNaN(new Date(s).getTime()) ? '尚未确认' : new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}).format(new Date(s));

/** Only a deliberate per-number checkbox records confirmation; opening or saving alone never does. */
export default function OwnerBusinessContact({ source, houseId, buildingId, preferredOwnerId, onSaved, disabled }: Props) {
  const session = useSession();
  const context = JSON.stringify([houseId,buildingId,source,session.user?.id,session.actingTenant?.id,session.actingOffice?.id,session.access]);
  const prefix = useId(), formRef = useRef<HTMLFormElement>(null), generation = useRef(0);
  const [open,setOpen] = useState(false), [loading,setLoading] = useState(false), [busy,setBusy] = useState(false);
  const [owners,setOwners] = useState<BusinessOwner[]>([]), [ownerId,setOwnerId] = useState<number>();
  const [name,setName] = useState(''), [phone,setPhone] = useState(''), [others,setOthers] = useState<string[]>([]), [confirmed,setConfirmed] = useState<string[]>([]);
  const [error,setError] = useState(''), [success,setSuccess] = useState(''), [retry,setRetry] = useState(0);
  const [fieldError,setFieldError] = useState('');
  const pageKeys = source === 'parking' ? ['business'] : ['business','fees','apartment-cashier','app:apartment-cashier'];
  const editable = pageKeys.some(p => can(p,'edit')) && !disabled;
  const viewable = pageKeys.some(p => can(p,'view'));
  const owner = owners.find(o => o.id === ownerId);
  const draftPhones = [...new Set([phone,...others].map(p=>p.trim()).filter(Boolean))];
  const loadDraft = (r?: BusinessOwner) => { if(formRef.current)delete formRef.current.dataset.dirty;setOwnerId(r?.id);setName(r?.name || '');setPhone(r?.phone || '');setOthers(r ? allPhones(r).filter(p=>p!==r.phone) : []);setConfirmed([]);setError('');setSuccess('');setFieldError(''); };
  useEffect(() => { generation.current++;setOwners([]);loadDraft();setOpen(false);setBusy(false);setLoading(false); },[context]);
  useEffect(() => {
    const current = ++generation.current;
    if (!open || !viewable || (!houseId && !buildingId)) return;
    setLoading(true);setError('');setSuccess('');
    request<BusinessOwner[]>({url:'/owners-mgmt/business-contacts',query:{houseId,buildingId}}).then(rows=>{
      if (generation.current!==current) return;
      setOwners(rows);loadDraft(rows.find(r=>r.id===preferredOwnerId) || rows[0]);
    }).catch(e=>{if(generation.current===current)setError(e.message || '联系人读取失败，请重试');}).finally(()=>{if(generation.current===current)setLoading(false);});
    return ()=>{generation.current++;};
  },[open,context,retry,viewable,preferredOwnerId]);
  const updateOthers = (index: number,value: string) => { setOthers(v=>v.map((p,i)=>i===index?value:p));setConfirmed([]);setSuccess(''); };
  const save = async (event: React.FormEvent) => {
    event.preventDefault();if (!owner || busy || !editable) return;
    setError('');setSuccess('');setFieldError('');
    const bad = !name.trim() ? 'name' : !phone.trim() || !/^[+\d][\d\s()+-]{4,29}$/.test(phone.trim()) ? 'phone' : others.some(p=>!p.trim() || !/^[+\d][\d\s()+-]{4,29}$/.test(p.trim())) ? 'others' : '';
    if (bad) { setFieldError(bad);setError(bad==='name'?'请填写业主姓名': '请输入有效手机号或固定电话，不要留下空白号码');formRef.current?.querySelector<HTMLInputElement>(`[data-field="${bad}"]`)?.focus();return; }
    const current = generation.current;setBusy(true);
    try {
      const saved = await request<BusinessOwner>({url:`/owners-mgmt/${owner.id}/business-contact`,method:'PATCH',data:{name:name.trim(),phone:phone.trim(),contactPhones:draftPhones,confirmedPhones:confirmed.filter(p=>draftPhones.includes(p)),source}});
      if (generation.current!==current) return;
      setOwners(rows=>rows.map(r=>r.id===saved.id?saved:r));loadDraft(saved);setSuccess('联系人已保存，只有本次勾选的号码记录为已确认');onSaved?.(saved);
    } catch(e:any) { if(generation.current===current)setError(e.message || '保存失败，输入与勾选已保留，请重试'); }
    finally { if(generation.current===current)setBusy(false); }
  };
  if (!viewable || (!houseId && !buildingId)) return null;
  return <section className="owner-business-contact" aria-label="业务联系人">
    <button type="button" className="obc-toggle" aria-expanded={open} aria-controls={`${prefix}-body`} disabled={busy} onClick={()=>{if(open && formRef.current?.dataset.dirty && !window.confirm('收起将放弃未保存修改，是否继续？'))return;setOpen(v=>!v);}}>业务联系人 · {open?'收起':'查看 / 编辑 / 逐号确认'}<span aria-hidden="true">{open?'−':'＋'}</span></button>
    {open && <div id={`${prefix}-body`} className="obc-body" aria-busy={loading||busy}>
      <p>姓名与电话由所有关联房产共用。查看、业务使用或电话接通均不代表确认；请逐号核实后勾选。</p>
      {loading ? <p role="status">正在读取全部绑定业主…</p> : <>
        {owners.length>1 && <label htmlFor={`${prefix}-owner`}>选择业主（共 {owners.length} 位）<select id={`${prefix}-owner`} disabled={busy} value={ownerId} onChange={e=>{ if(!formRef.current || !formRef.current.dataset.dirty || window.confirm('切换业主将放弃未保存修改，是否继续？'))loadDraft(owners.find(r=>r.id===Number(e.target.value))); }} >{owners.map(r=><option key={r.id} value={r.id}>{r.name || '未登记姓名'} · {r.phone || '无主电话'}</option>)}</select></label>}
        {owner ? <form ref={formRef} onSubmit={save} noValidate onChange={()=>{if(formRef.current)formRef.current.dataset.dirty='1';setSuccess('');}}>
          <div className="obc-fields"><label htmlFor={`${prefix}-name`}>业主姓名<input id={`${prefix}-name`} data-field="name" aria-invalid={fieldError==='name'} aria-describedby={error?`${prefix}-error`:undefined} disabled={!editable||busy} value={name} maxLength={60} onChange={e=>setName(e.target.value)}/></label>
          <label htmlFor={`${prefix}-phone`}>主要联系电话<input id={`${prefix}-phone`} data-field="phone" type="tel" aria-invalid={fieldError==='phone'} aria-describedby={error?`${prefix}-error`:undefined} disabled={!editable||busy} value={phone} maxLength={30} onChange={e=>{setPhone(e.target.value);setConfirmed([]);}}/></label></div>
          {others.map((p,i)=><div className="obc-extra" key={i}><label htmlFor={`${prefix}-phone-${i}`}>其他联系电话 {i+1}<input id={`${prefix}-phone-${i}`} data-field="others" type="tel" aria-invalid={fieldError==='others'} aria-describedby={error?`${prefix}-error`:undefined} disabled={!editable||busy} maxLength={30} value={p} onChange={e=>updateOthers(i,e.target.value)}/></label>{editable && <button type="button" disabled={busy} onClick={()=>{if(formRef.current)formRef.current.dataset.dirty='1';setOthers(v=>v.filter((_,j)=>j!==i));setConfirmed([]);}}>删除此号码</button>}</div>)}
          {editable && others.length<9 && <button type="button" disabled={busy} onClick={()=>{if(formRef.current)formRef.current.dataset.dirty='1';setOthers(v=>[...v,'']);}}>添加联系电话</button>}
          <fieldset disabled={!editable||busy}><legend>逐号码明确确认（可不勾选，仅保存资料）</legend>{draftPhones.map(p=>{ const activity=owner.phoneActivity?.find(a=>a.phone===p);return <div className="obc-confirm" key={p}><label><input type="checkbox" checked={confirmed.includes(p)} onChange={e=>setConfirmed(v=>e.target.checked?[...v,p]:v.filter(x=>x!==p))}/>本次已核实 {p}</label><small>上次确认：{confirmationTime(activity?.last_confirmed_at)}{activity?.confirmation_source ? ` · ${activity.confirmation_source==='parking'?'停车业务':'收银业务'}`:''}</small></div>;})}</fieldset>
          {editable && <button className="obc-save" type="submit" disabled={busy}>{busy?'保存中…':'保存联系人与本次确认'}</button>}
        </form> : !error && <p>当前房产暂无绑定业主。请先在房产档案关联业主；不按姓名或旧库电话自动创建、合并。</p>}
      </>}
      {error && <div className="obc-error" id={`${prefix}-error`} role="alert">{error}{!owner && <button type="button" disabled={loading} onClick={()=>setRetry(v=>v+1)}>重试</button>}</div>}
      {success && <p className="obc-success" role="status">{success}</p>}
    </div>}
  </section>;
}
