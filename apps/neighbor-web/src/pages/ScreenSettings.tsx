import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { request } from '@pms/api-client';
import { can } from '@/lib/perm';
import { useSession } from '@/lib/auth';
import { chinaToday, distributeCents, sampleManual, type ManualMetrics, type ScreenSettingsData, type ScreenTargetSetting } from '@/lib/screen-decision';
import '@/styles/screen-settings.css';

const feeNames:Record<string,string>={property:'物业费',berth:'车位费',parking:'停车费',other:'其他费'};
const metricFields:{key:keyof ManualMetrics;label:string;money?:boolean}[]=[
  {key:'overdueHouses',label:'承诺付款逾期户数'}, {key:'overdueCents',label:'逾期承诺涉及金额',money:true},
  {key:'untouchedHouses',label:'大额欠费未跟进户数'}, {key:'untouchedCents',label:'未跟进涉及金额',money:true},
  {key:'disputeCount',label:'争议待处理件数'}, {key:'disputeCents',label:'争议涉及金额',money:true},
  {key:'recoveredCents',label:'近30日跟进后回款',money:true}, {key:'duePromises',label:'近30日到期承诺笔数'},
  {key:'keptPromises',label:'其中已兑现承诺笔数'}, {key:'pendingHouses',label:'待跟进户数'},
];
const money = (v:string) => /^\d+(\.\d{1,2})?$/.test(v)&&Number(v)<=10000000000?Math.round(Number(v)*100):null;
function focusError(root:HTMLElement|null){requestAnimationFrame(()=>root?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus());}
function TargetEditor({target,communities,year,onSaved,onDirty}:{target?:ScreenTargetSetting;communities:{id:number;name:string}[];year:number;onSaved:()=>Promise<void>;onDirty:(dirty:boolean)=>void}){
  const [ids,setIds]=useState<number[]>(target?.communityIds||[]),[fee,setFee]=useState(target?.feeCode||'property');
  const [annual,setAnnual]=useState(String((target?.annualCents??100000000)/100));
  const [months,setMonths]=useState((target?.monthCents??distributeCents(100000000)).map(v=>v===null?'':String(v/100)));
  const [confirmed,setConfirmed]=useState(!!target),[errors,setErrors]=useState<Record<string,string>>({}),[busy,setBusy]=useState(false),[status,setStatus]=useState('');
  const editable=can('fees','edit'),formId=`target-${target?.id||'new'}`;
  const touch=()=>onDirty(true);
  const clear=(key:string)=>setErrors(e=>{const n={...e};delete n[key];return n;});
  const save=async(e:React.FormEvent<HTMLFormElement>)=>{
    e.preventDefault();const form=e.currentTarget,err:Record<string,string>={};
    if(!ids.length)err.ids='请至少选择一个小区';
    const a=money(annual);if(a===null||a<=0)err.annual='请输入大于0的金额，最多两位小数';
    const mm=months.map((v,i)=>{const n=money(v);if(n===null)err['m'+i]='请输入非负金额，最多两位小数';return n??0;});
    if(a!==null&&mm.reduce((s,n)=>s+n,0)!==a)err.annual='12个月计划合计必须等于年度目标';
    if(!confirmed)err.confirm='请核实预填目标和月度计划后确认';
    setErrors(err);if(Object.keys(err).length){focusError(form);return;}
    setBusy(true);setStatus('');try{await request({url:'/fees/screen-targets',method:'PUT',data:{year,communityIds:ids,feeCode:fee,annualCents:a,monthCents:mm},timeout:20000});await onSaved();onDirty(false);setStatus('目标已保存并重新读取，大屏刷新后生效');}catch(err){setStatus(err instanceof Error?err.message:'保存失败，输入已保留');}finally{setBusy(false);}
  };
  return <form id={formId} className="ss-target" onSubmit={save} noValidate><header><h3>{target?communities.filter(c=>ids.includes(c.id)).map(c=>c.name).join('、'):'新增目标指标组'}</h3>{!target&&<span className="ss-example">已预填100万元示例目标，保存前请核实</span>}</header>
    <fieldset disabled={!editable||busy}><legend>目标范围与金额</legend><div className="ss-fields">
      <div className={`ss-field ss-wide ${errors.ids?'invalid':''}`}><label htmlFor={formId+'-ids'}>考核小区 *</label><select id={formId+'-ids'} multiple value={ids.map(String)} disabled={!!target} aria-invalid={!!errors.ids} aria-describedby={errors.ids?formId+'-ids-error':undefined} onChange={e=>{setIds(Array.from(e.target.selectedOptions,o=>Number(o.value)));clear('ids');touch();}}>{communities.map(c=><option key={c.id} value={c.id}>{c.name}</option>)}</select>{errors.ids&&<small id={formId+'-ids-error'} className="ss-error">{errors.ids}</small>}<small>可多选形成一个共同目标；已保存组的范围保持不变。</small></div>
      <div className="ss-field"><label htmlFor={formId+'-fee'}>考核费项</label><select id={formId+'-fee'} value={fee} onChange={e=>{setFee(e.target.value);touch();}}>{Object.entries(feeNames).map(([k,v])=><option value={k} key={k}>{v}</option>)}</select></div>
      <div className="ss-field"><label htmlFor={formId+'-annual'}>年度目标（元） *</label><input id={formId+'-annual'} inputMode="decimal" value={annual} aria-invalid={!!errors.annual} aria-describedby={errors.annual?formId+'-annual-error':undefined} onChange={e=>{setAnnual(e.target.value);clear('annual');touch();}}/>{errors.annual&&<small id={formId+'-annual-error'} className="ss-error">{errors.annual}</small>}</div>
    </div><div className="ss-section-line"><b>月度回款计划（元）</b><button type="button" className="btn" onClick={()=>{const a=money(annual);if(a!==null){setMonths(distributeCents(a).map(v=>String(v/100)));touch();setErrors(e=>Object.fromEntries(Object.entries(e).filter(([k])=>k!=='annual'&&!/^m\d+$/.test(k))));}}}>按年度目标均分</button></div><p className="ss-help">截至今日计划按月度目标累计，当月按自然日折算；请按实际收费节奏调整，12个月合计必须等于年度目标。</p>
    <div className="ss-months">{months.map((v,i)=><div className="ss-field" key={i}><label htmlFor={formId+'-m'+i}>{i+1}月 *</label><input id={formId+'-m'+i} value={v} inputMode="decimal" aria-invalid={!!errors['m'+i]} aria-describedby={errors['m'+i]?formId+'-m'+i+'-error':undefined} onChange={e=>{setMonths(m=>m.map((n,j)=>j===i?e.target.value:n));clear('m'+i);touch();}}/>{errors['m'+i]&&<small className="ss-error" id={formId+'-m'+i+'-error'}>{errors['m'+i]}</small>}</div>)}</div>
    <div className="ss-field"><label className="ss-check"><input type="checkbox" checked={confirmed} aria-invalid={!!errors.confirm} aria-describedby={errors.confirm?formId+'-confirm-error':undefined} onChange={e=>{setConfirmed(e.target.checked);clear('confirm');touch();}}/>我已核实这组目标和月度计划，作为正式考核目标</label>{errors.confirm&&<small id={formId+'-confirm-error'} className="ss-error">{errors.confirm}</small>}</div>
    <button className="btn p" type="submit" disabled={!editable||busy}>{busy?'保存并回读中…':'保存这组目标'}</button></fieldset>{status&&<p role="status" className="ss-status">{status}</p>}
  </form>;
}
function SettingsContent(){
  const [params,setParams]=useSearchParams(),nav=useNavigate(),today=chinaToday();
  const paramYear=Number(params.get('year')),year=paramYear>=2000&&paramYear<=2100?paramYear:Number(today.slice(0,4));
  const scope=params.get('communityIds')||'';
  const [config,setConfig]=useState<ScreenSettingsData|null>(null),[loading,setLoading]=useState(true),[error,setError]=useState('');
  const [manual,setManual]=useState<ManualMetrics>(sampleManual(year));
  const [values,setValues]=useState<Record<string,string>>({}),[owners,setOwners]=useState<Record<number,string>>({});
  const [errors,setErrors]=useState<Record<string,string>>({}),[saving,setSaving]=useState(false),[status,setStatus]=useState(''),[dirty,setDirty]=useState(false);
  const [targetDirty,setTargetDirty]=useState<Record<string,boolean>>({});
  const anyDirty=dirty||Object.values(targetDirty).some(Boolean);
  const editable=can('fees','edit');
  const query={year,communityIds:scope||undefined};
  const read=()=>request<ScreenSettingsData>({url:'/fees/screen-settings',query,timeout:15000});
  useEffect(()=>{let active=true;setLoading(true);setConfig(null);setError('');void read().then(c=>{if(!active)return;setConfig(c);const m=c.manual||sampleManual(year);setManual(m);setValues(Object.fromEntries(metricFields.map(f=>[f.key,String(Number(m[f.key])/(f.money?100:1))])));setOwners(Object.fromEntries(c.owners.map(o=>[o.communityId,o.name])));setDirty(false);setTargetDirty({});setStatus('');setErrors({});}).catch(e=>{if(active)setError(e instanceof Error?e.message:'设置读取失败');}).finally(()=>{if(active)setLoading(false);});return()=>{active=false;};},[year,scope]);
  useEffect(()=>{if(!anyDirty)return;const guard=(e:BeforeUnloadEvent)=>{e.preventDefault();e.returnValue='';};window.addEventListener('beforeunload',guard);return()=>window.removeEventListener('beforeunload',guard);},[anyDirty]);
  const clear=(k:string)=>setErrors(e=>{const n={...e};delete n[k];return n;});
  const save=async(e:React.FormEvent<HTMLFormElement>)=>{
    e.preventDefault();const form=e.currentTarget;if(!config)return;const ee:Record<string,string>={},next={...manual};
    for(const f of metricFields){const v=values[f.key]||'';const parsed=f.money?money(v):/^\d+$/.test(v)&&Number(v)<=1000000?Number(v):null;if(parsed===null)ee[f.key]=f.money?'请输入非负金额，最多两位小数':'请输入0至1000000的整数';else (next as any)[f.key]=parsed;}
    if(!/^\d{4}-\d{2}-\d{2}$/.test(manual.asOf)||Number(manual.asOf.slice(0,4))!==year||!Number.isFinite(Date.parse(manual.asOf)))ee.asOf='请选择所选年度内的有效日期';
    if(!manual.sample&&manual.asOf>today)ee.asOf='正式人工数据日期不能晚于今天';
    if(next.keptPromises>next.duePromises)ee.keptPromises='已兑现笔数不能超过到期承诺笔数';
    if(manual.note.length>200)ee.note='说明最多200字';
    for(const [id,name] of Object.entries(owners))if(name.length>40)ee['owner'+id]='负责人最多40字';
    setErrors(ee);if(Object.keys(ee).length){focusError(form);return;}
    setSaving(true);setStatus('');try{const saved=await request<ScreenSettingsData>({url:'/fees/screen-settings',method:'PUT',data:{...query,revision:config.revision,manual:next,owners:config.communities.map(c=>({communityId:c.id,name:owners[c.id]||''}))},timeout:20000});setConfig(saved);setManual(saved.manual!);setDirty(false);setStatus('人工指标和负责人已保存并回读，大屏刷新后生效');}catch(e){
      if((e as {networkFailure?:boolean})?.networkFailure){
        try{const actual=await read();const same=actual.manual&&Object.keys(next).every(k=>(actual.manual as any)[k]===(next as any)[k])&&actual.owners.length===config.communities.length&&actual.owners.every(o=>o.name===(owners[o.communityId]||''));
          if(actual.revision===config.revision+1&&same){setConfig(actual);setManual(actual.manual!);setDirty(false);setStatus('已查询确认保存成功，大屏刷新后生效');return;}
        }catch{/* 只查询一次确认原操作，不重复写入。 */}
        setStatus('保存结果未确认，请重新载入核对。当前输入已保留。');
      }else setStatus(e instanceof Error?e.message:'保存失败，输入已保留');
    }finally{setSaving(false);}
  };
  const changeYear=(y:string)=>{if(anyDirty&&!window.confirm('有未保存的目标或人工指标修改，确认切换年度？'))return;setParams({year:y,...(scope?{communityIds:scope}:{})});};
  return <div className="screen-settings"><header className="ph"><div><h1>大屏设置</h1><p>目标与月度计划、项目负责人、人工台账集中维护；自动实收从业务系统读取。</p></div><div className="act"><select aria-label="设置年度" value={year} onChange={e=>changeYear(e.target.value)}>{Array.from({length:5},(_,i)=>Number(today.slice(0,4))+1-i).map(y=><option key={y} value={y}>{y}年度</option>)}</select><button className="btn" onClick={()=>{if(!anyDirty||window.confirm('目标或人工指标尚未保存，确认离开？'))nav(`/screen?year=${year}${scope?'&communityIds='+scope:''}`);}}>查看大屏</button></div></header>
    {loading&&<p role="status">正在读取设置…</p>}{error&&<div role="alert" className="ss-error">{error}<button className="btn" onClick={()=>window.location.reload()}>重新载入</button></div>}
    {config&&<><div className="ss-intro"><b>当前设置范围：{config.communities.map(c=>c.name).join('、')||'无授权小区'}</b><p>人工指标按公司、年度和当前小区范围独立保存。更换范围不会套用其他范围的人工汇总。金额均以元录入，大屏自动换算为万元。</p>{!editable&&<p>当前账号仅可查看，不能修改。</p>}</div>
    <section className="ss-section"><header><h2>目标与月度计划</h2><p>复用现有收费目标；每个小区只能属于一个指标组。新增目标已预填示例数，保存前需确认。</p></header>
      {config.targets.map(t=><TargetEditor key={`${year}-${t.id}-${t.annualCents}-${JSON.stringify(t.monthCents)}`} target={t} communities={config.communities} year={year} onDirty={changed=>setTargetDirty(v=>({...v,[t.id]:changed}))} onSaved={async()=>{const c=await read();setConfig(prev=>prev?{...prev,targets:c.targets}:c);}}/>)}
      {config.communities.some(c=>!config.targets.some(t=>t.communityIds.includes(c.id)))&&<TargetEditor key={`new-${year}-${config.targets.length}`} communities={config.communities.filter(c=>!config.targets.some(t=>t.communityIds.includes(c.id)))} year={year} onDirty={changed=>setTargetDirty(v=>({...v,new:changed}))} onSaved={async()=>{const c=await read();setConfig(prev=>prev?{...prev,targets:c.targets}:c);}}/>}
    </section>
    <form className="ss-section" onSubmit={save} noValidate><header><h2>人工台账与负责人</h2><p>仅维护暂时不能可靠自动统计的指标。近30日数据应采用同一个截止日；跟进后回款不代表回款一定由催缴导致。</p></header><fieldset disabled={!editable||saving||!config.communities.length}><legend>人工数据来源</legend>
      <label className="ss-check ss-example"><input type="checkbox" checked={manual.sample} onChange={e=>{setManual(m=>({...m,sample:e.target.checked}));setDirty(true);}}/>这些数值仍是示例／待核实，大屏保留明显标识</label>
      <div className="ss-fields"><div className="ss-field"><label htmlFor="manual-asof">人工数据截止日期 *</label><input id="manual-asof" type="date" value={manual.asOf} aria-invalid={!!errors.asOf} aria-describedby={errors.asOf?'manual-asof-error':undefined} onChange={e=>{setManual(m=>({...m,asOf:e.target.value}));clear('asOf');setDirty(true);}}/>{errors.asOf&&<small id="manual-asof-error" className="ss-error">{errors.asOf}</small>}</div><div className="ss-field ss-wide"><label htmlFor="manual-note">数据来源／说明</label><input id="manual-note" value={manual.note} maxLength={200} aria-invalid={!!errors.note} aria-describedby={errors.note?'manual-note-error':undefined} onChange={e=>{setManual(m=>({...m,note:e.target.value}));clear('note');setDirty(true);}}/>{errors.note&&<small id="manual-note-error" className="ss-error">{errors.note}</small>}</div></div>
      <div className="ss-fields">{metricFields.map(f=><div className="ss-field" key={f.key}><label htmlFor={'manual-'+f.key}>{f.label}{f.money?'（元）':''} *</label><input id={'manual-'+f.key} inputMode={f.money?'decimal':'numeric'} value={values[f.key]??''} aria-invalid={!!errors[f.key]} aria-describedby={errors[f.key]?'manual-'+f.key+'-error':undefined} onChange={e=>{setValues(v=>({...v,[f.key]:e.target.value}));clear(f.key);setDirty(true);}}/>{errors[f.key]&&<small className="ss-error" id={'manual-'+f.key+'-error'}>{errors[f.key]}</small>}</div>)}</div>
      <h3>项目负责人</h3><div className="ss-fields">{config.communities.map(c=><div className="ss-field" key={c.id}><label htmlFor={'owner-'+c.id}>{c.name}</label><input id={'owner-'+c.id} value={owners[c.id]||''} maxLength={40} aria-invalid={!!errors['owner'+c.id]} aria-describedby={errors['owner'+c.id]?'owner-error-'+c.id:undefined} onChange={e=>{setOwners(o=>({...o,[c.id]:e.target.value}));clear('owner'+c.id);setDirty(true);}}/>{errors['owner'+c.id]&&<small id={'owner-error-'+c.id} className="ss-error">{errors['owner'+c.id]}</small>}</div>)}</div>
      <div className="ss-save"><button type="submit" className="btn p" disabled={!editable||saving}>{saving?'保存并回读中…':'保存人工指标与负责人'}</button><span>{dirty?'有未保存的修改':config.updatedAt?'上次保存 '+new Date(config.updatedAt).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'}):'预填值尚未保存'}</span></div>
    </fieldset>{status&&<p className="ss-status" role="status">{status}</p>}</form></>}
  </div>;
}
export default function ScreenSettings(){const s=useSession();return <SettingsContent key={`${s.generation}|${s.actingTenant?.id}|${s.actingOffice?.id}`}/>;}
