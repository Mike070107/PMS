import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import {ConfigProvider,DatePicker,Modal} from 'antd';
import zhCN from 'antd/es/locale/zh_CN';
import dayjs from 'dayjs';
import 'dayjs/locale/zh-cn';
import DateInput from '@/components/DateInput';
import '@/styles/design.css';
import '@/styles/guards.css';
const before=new URLSearchParams(location.search).has('before');
if(!before)await import('@/styles/calendar.css');
dayjs.locale('zh-cn');
function Fixture(){
 const [date,setDate]=useState('2026-11-05'),[month,setMonth]=useState('2026-11'),[time,setTime]=useState('2026-11-05T13:20'),[modal,setModal]=useState(false);
 const Input=before?'input':DateInput;
 return <ConfigProvider locale={zhCN} theme={{token:{colorPrimary:'#3976d7',fontSize:16,controlHeight:44,borderRadius:8},...(!before?{components:{DatePicker:{cellWidth:38,cellHeight:36,textHeight:36,borderRadiusLG:12,zIndexPopup:2200}}}:{})}}>
 <main style={{maxWidth:1000,margin:'0 auto',padding:16}}>
 <h1 style={{fontSize:24,marginBottom:8}}>日期选择控件 · {before?'原版':'统一版'}</h1><p>隔离交互验收：仅演示日期字段，不连接业务接口、不写正式数据。</p>
 <section className="card" style={{padding:20,display:'grid',gap:20,marginTop:18}}>
 <label>日期（有最早/最晚限制）<div><Input aria-label="示例日期" className="in" type="date" min="2026-11-03" max="2026-11-25" value={date} onChange={e=>setDate(e.target.value)} /></div></label>
 <output data-testid="date-value">{date||'已清空'}</output>
 <label>月份<div><Input aria-label="示例月份" className="in" type="month" value={month} onChange={e=>setMonth(e.target.value)} /></div></label>
 <output data-testid="month-value">{month}</output>
 <label>日期与时间<div><Input aria-label="示例日期时间" className="in" type="datetime-local" value={time} onChange={e=>setTime(e.target.value)} /></div></label>
 <output data-testid="time-value">{time}</output>
 <label>已有日期范围控件<div><DatePicker.RangePicker aria-label="日期范围" onChange={v=>{document.documentElement.dataset.range=v?.map(d=>d?.format('YYYY-MM-DD')).join('/')||''}} defaultValue={[dayjs('2026-11-05'),dayjs('2026-11-20')]} /></div></label>
 <label>已有月份范围控件<div><DatePicker.RangePicker picker="month" aria-label="月份范围" defaultValue={[dayjs('2026-01-01'),dayjs('2026-11-01')]} /></div></label>
 <button className="btn" onClick={()=>setModal(true)}>弹窗内选择日期</button>
 </section>
 <Modal title="弹窗日期选择" open={modal} onCancel={()=>setModal(false)} footer={null}>
 <Input aria-label="弹窗日期" type="date" value={date} onChange={e=>setDate(e.target.value)} />
 </Modal>
 </main></ConfigProvider>;
}
createRoot(document.getElementById('root')!).render(<Fixture/>);
