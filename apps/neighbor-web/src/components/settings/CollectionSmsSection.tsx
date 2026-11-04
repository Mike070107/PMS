import { useEffect, useRef, useState } from 'react';
import { request } from '@pms/api-client';
import { Section, Row, Toggle } from './parts';
import { ErrorNote, Loading, toast } from '@/components/ui';
type Config={enabled:boolean;provider:string;signName:string;templateCode:string;templateContent:string;approved:boolean;startHour:number;endHour:number;cooldownHours:number;dailyLimit:number;hasAccessKeyId:boolean;hasAccessKeySecret:boolean;accessKeyIdMasked:string;readiness:{canSend:boolean;reason:string}};
const initial={enabled:false,provider:'aliyun',signName:'',templateCode:'',templateContent:'',approved:false,startHour:9,endHour:18,cooldownHours:168,dailyLimit:1,hasAccessKeyId:false,hasAccessKeySecret:false,accessKeyIdMasked:'',readiness:{canSend:false,reason:''}};
export default function CollectionSmsSection({canEdit}:{canEdit:boolean}){
 const [data,setData]=useState<Config|null>(null),[id,setId]=useState(''),[secret,setSecret]=useState(''),[error,setError]=useState(''),[fields,setFields]=useState<Record<string,string>>({}),[busy,setBusy]=useState(false);
 const form=useRef<HTMLFormElement>(null);
 const load=()=>{setError('');request<Config>({url:'/settings/collection-sms'}).then(setData).catch(e=>setError(e instanceof Error?e.message:'催缴短信设置读取失败'))};useEffect(load,[]);
 const change=<K extends keyof Config>(k:K,v:Config[K])=>{setData(prev=>prev?{...prev,[k]:v,...(['signName','templateCode','templateContent'].includes(k)?{approved:false,enabled:false}:{})}:prev);setFields(p=>({...p,[k]:''}))};
 async function save(){if(!data)return;const errors:Record<string,string>={};
  if(data.templateCode&&!/^SMS_\d+$/.test(data.templateCode))errors.templateCode='格式应为SMS_加数字';
  if(data.startHour>=data.endHour)errors.endHour='结束时间必须晚于开始时间';
  if(!data.templateContent.includes('${address}')||!data.templateContent.includes('${amount}'))errors.templateContent='模板必须有address和amount变量';
  if(data.enabled){if(!data.signName.trim())errors.signName='请填写审核通过的签名';if(!data.templateCode)errors.templateCode='请填写审核通过的模板CODE';if(!data.approved)errors.approved='请先确认模板与签名已通过阿里云审核';if(!data.hasAccessKeyId&&!id)errors.accessKeyId='请填写AccessKey ID';if(!data.hasAccessKeySecret&&!secret)errors.accessKeySecret='请填写AccessKey Secret'}
  setFields(errors);if(Object.keys(errors).length){form.current?.querySelector<HTMLElement>('[name="'+Object.keys(errors)[0]+'"]')?.focus();return}
  setBusy(true);setError('');try{const {enabled,signName,templateCode,templateContent,approved,startHour,endHour,cooldownHours,dailyLimit}=data;setData(await request<Config>({method:'PATCH',url:'/settings/collection-sms',data:{enabled,signName,templateCode,templateContent,approved,startHour,endHour,cooldownHours,dailyLimit,accessKeyId:id||undefined,accessKeySecret:secret||undefined}}));setId('');setSecret('');toast('催缴短信配置已保存；没有发送短信')}catch(e){setError(e instanceof Error?e.message:'保存失败，已保留输入')}finally{setBusy(false)}}
 if(!data)return <Section title="催缴短信 · 阿里云">{error?<ErrorNote>{error} <button className="btn" onClick={load}>重试</button></ErrorNote>:<Loading/>}</Section>;
 const field=(key:string,label:string,control:React.ReactNode,hint?:string)=><Row label={label} hint={hint}>{control}{fields[key]&&<p id={'sms-error-'+key} style={{color:'var(--dang)',margin:'6px 0',fontSize:14}}>{fields[key]}</p>}</Row>;
 const attrs=(name:string)=>({name,'aria-label':name==='accessKeyId'?'AccessKey ID':name==='accessKeySecret'?'AccessKey Secret':name,'aria-invalid':!!fields[name],'aria-describedby':fields[name]?'sms-error-'+name:undefined,style:{borderColor:fields[name]?'var(--dang)':undefined}});
 return <Section title="催缴短信 · 阿里云" desc="住宅物业费用通知的配置统一放在这里；账单页负责核对、预览及生成批次。保存配置不会发送短信。">
  <form ref={form} onSubmit={e=>{e.preventDefault();void save()}}>
   <Row label="短信总开关" hint="默认关闭；开启仍须完成真实发送与回执验收，不会自动群发。"><Toggle on={data.enabled} onChange={v=>change('enabled',v)} disabled={!canEdit||busy} label={['已开启','已关闭']}/></Row>
   {field('accessKeyId','AccessKey ID',<input {...attrs('accessKeyId')} className="in" type="password" autoComplete="new-password" value={id} onChange={e=>{setId(e.target.value);setFields(p=>({...p,accessKeyId:''}))}} disabled={!canEdit||busy} placeholder={data.hasAccessKeyId?'已配置 '+data.accessKeyIdMasked+'，留空保持':'建议使用仅具短信权限的RAM子账号'}/>,data.hasAccessKeyId?'已加密保存；不回显完整ID':'不要使用阿里云主账号密钥')}
   {field('accessKeySecret','AccessKey Secret',<input {...attrs('accessKeySecret')} className="in" type="password" autoComplete="new-password" value={secret} onChange={e=>{setSecret(e.target.value);setFields(p=>({...p,accessKeySecret:''}))}} disabled={!canEdit||busy} placeholder={data.hasAccessKeySecret?'已加密保存，留空保持原密钥':'输入后仅加密保存，不明文回显'}/>)}
   {field('signName','短信签名',<input {...attrs('signName')} className="in" value={data.signName} maxLength={64} disabled={!canEdit||busy} onChange={e=>change('signName',e.target.value)}/>, '填写阿里云审核通过的签名名称，不加【】')}
   {field('templateCode','模板CODE',<input {...attrs('templateCode')} className="in" value={data.templateCode} maxLength={40} disabled={!canEdit||busy} onChange={e=>change('templateCode',e.target.value)} placeholder="SMS_…"/>)}
   {field('templateContent','已提交审核的模板正文',<textarea {...attrs('templateContent')} className="in" value={data.templateContent} maxLength={500} rows={5} disabled={!canEdit||busy} onChange={e=>change('templateContent',e.target.value)} style={{height:'auto',minHeight:140,borderColor:fields.templateContent?'var(--dang)':undefined}}/>, '变量固定支持 ${date}、${address}、${period}、${amount}，每个只能出现一次。必须与阿里云审核正文完全一致；修改签名或模板会清除审核确认并关闭开关。')}
   {field('approved','审核确认',<label style={{display:'flex',gap:10,alignItems:'flex-start'}}><input {...attrs('approved')} type="checkbox" checked={data.approved} disabled={!canEdit||busy} onChange={e=>change('approved',e.target.checked)}/>我已在阿里云确认该签名及模板审核通过，物业费用通知场景可发送</label>,'先保存签名和模板，再确认审核状态；人工勾选不代替服务商验证。')}
   <Row label="允许发送时段" hint="中国标准时间；这是防误发策略，不是法定统一时段。"><div style={{display:'flex',gap:12,alignItems:'center',flexWrap:'wrap'}}><select aria-label="发送开始时间" className="in" value={data.startHour} disabled={!canEdit||busy} onChange={e=>change('startHour',Number(e.target.value))} style={{width:130}}>{Array.from({length:13},(_,i)=>i+8).map(h=><option key={h} value={h}>{h}:00</option>)}</select><span>至</span><select {...attrs('endHour')} className="in" value={data.endHour} disabled={!canEdit||busy} onChange={e=>change('endHour',Number(e.target.value))} style={{width:130,borderColor:fields.endHour?'var(--dang)':undefined}}>{Array.from({length:13},(_,i)=>i+9).map(h=><option key={h} value={h}>{h}:00</option>)}</select></div>{fields.endHour&&<p id="sms-error-endHour" style={{color:'var(--dang)'}}>{fields.endHour}</p>}</Row>
   <Row label="同一对象冷却期" hint="24—2160小时；默认一周，避免重复催缴。"><input aria-label="同一对象冷却小时" className="in" type="number" min={24} max={2160} value={data.cooldownHours} disabled={!canEdit||busy} onChange={e=>change('cooldownHours',Number(e.target.value))} style={{maxWidth:180}}/> 小时</Row>
   <Row label="每号码单日上限" hint="1—3次，最终仍受阿里云及运营商限制。"><input aria-label="每号码单日上限" className="in" type="number" min={1} max={3} value={data.dailyLimit} disabled={!canEdit||busy} onChange={e=>change('dailyLimit',Number(e.target.value))} style={{maxWidth:180}}/> 次</Row>
   <div className="note" style={{margin:'18px 0'}}>{data.readiness.reason}。当前没有测试发送按钮，避免保存配置时误发给住户。</div>
   {error&&<ErrorNote>{error}</ErrorNote>}<button className="btn p" type="submit" disabled={!canEdit||busy}>{busy?'保存中…':'保存催缴短信配置'}</button>
  </form>
 </Section>;
}
