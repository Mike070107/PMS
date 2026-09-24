import {
  BankOutlined, CloudSyncOutlined, FileAddOutlined, FileDoneOutlined, FolderAddOutlined,
  InboxOutlined, PlusOutlined, ReloadOutlined, SafetyCertificateOutlined, SettingOutlined,
  SwapOutlined, WalletOutlined,
} from '@ant-design/icons';
import { Alert, Button, Card, Checkbox, DatePicker, Empty, Form, Input, InputNumber, Modal, Radio, Select, Space, Spin, Statistic, Table, Tabs, Tag, Upload, message } from 'antd';
import dayjs from 'dayjs';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ApiError, request } from '../lib/api';
import { auth } from '../lib/auth';
import './FinancePage.css';

type Project = { id:number; parentId:number|null; name:string; description?:string; status:string };
type Entry = { id:number; entryNo:string; businessDate:string; owner:string; reason:string; amount:string; flowType:'income'|'expense'; paymentMethod:string; projectId:number|null; subProjectId:number|null; reimbursementStatus:string };
type Invoice = { id:number; originalName:string; source:string; amount:string|null; invoiceDate:string|null; status:string; entryId:number|null; createdAt:string; discardReason?:string };
type Reimbursement = { id:number; applicationNo:string; claimantName:string; applicationDate:string; amount:string; status:string; entryIds:number[] };
type Attachment = { name:string; objectKey:string; contentType?:string; size?:number };
type Dashboard = { month:{income:string;expense:string;balance:string}; pendingReimbursement:number; invoiceInbox:number; projects:number };

const ownerLabels: Record<string,string> = { osiris:'公司 OsirisList', pruis:'公司普睿斯', personal:'个人' };
const paymentLabels: Record<string,string> = { wechat:'微信', alipay:'支付宝', bank:'对公转账', cash:'现金' };
const reimbursementLabels: Record<string,[string,string]> = { not_required:['无需报销','default'], pending:['待报销','orange'], reimbursed:['已报销','green'] };
const invoiceLabels: Record<string,[string,string]> = { inbox:['待匹配','blue'], matched:['已匹配','green'], duplicate:['重复','orange'], discarded:['已丢弃','default'], error:['处理失败','red'] };

function money(value: string | number | null | undefined) { return Number(value || 0).toLocaleString('zh-CN', { minimumFractionDigits:2, maximumFractionDigits:2 }); }
function errorText(error: unknown) { return error instanceof ApiError || error instanceof Error ? error.message : '操作失败，请稍后重试'; }

export default function FinancePage() {
  const [loading,setLoading]=useState(true); const [allowed,setAllowed]=useState<boolean|null>(null);
  const [dashboard,setDashboard]=useState<Dashboard|null>(null); const [projects,setProjects]=useState<Project[]>([]);
  const [entries,setEntries]=useState<Entry[]>([]); const [invoices,setInvoices]=useState<Invoice[]>([]); const [reimbursements,setReimbursements]=useState<Reimbursement[]>([]);
  const [entryOpen,setEntryOpen]=useState(false); const [projectOpen,setProjectOpen]=useState(false); const [mailOpen,setMailOpen]=useState(false); const [reimburseOpen,setReimburseOpen]=useState(false);
  const [matching,setMatching]=useState<Invoice|null>(null); const [candidates,setCandidates]=useState<Entry[]>([]); const [mailStatus,setMailStatus]=useState<any>(null);
  const [projectAttachments,setProjectAttachments]=useState<Attachment[]>([]); const [voucherAttachments,setVoucherAttachments]=useState<Attachment[]>([]);
  const [entryForm]=Form.useForm(); const [projectForm]=Form.useForm(); const [mailForm]=Form.useForm(); const [reimburseForm]=Form.useForm();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const access:any=await request({url:'/finance/access'}); setAllowed(!!access.allowed);
      if (!access.allowed) return;
      const [d,p,e,i,r,m]=await Promise.all([
        request({url:'/finance/dashboard'}),request({url:'/finance/projects'}),request({url:'/finance/entries'}),
        request({url:'/finance/invoices'}),request({url:'/finance/reimbursements'}),request({url:'/finance/mail-connection'}),
      ]);
      setDashboard(d as Dashboard); setProjects(p as Project[]); setEntries(e as Entry[]); setInvoices(i as Invoice[]); setReimbursements(r as Reimbursement[]); setMailStatus(m);
    } catch(error){ message.error(errorText(error)); }
    finally{ setLoading(false); }
  },[]);
  useEffect(()=>{ void load(); },[load]);

  const roots=useMemo(()=>projects.filter(p=>!p.parentId),[projects]);
  const projectName=(id:number|null)=>projects.find(p=>p.id===id)?.name||'未归属项目';
  const uploadObject=async(file:File,endpoint='/finance/attachments')=>{const form=new FormData();form.append('file',file,file.name||`截图-${Date.now()}.png`);const res=await fetch(`${import.meta.env.VITE_API_BASE_URL||'/api/v1'}${endpoint}`,{method:'POST',headers:{Authorization:`Bearer ${auth.getToken()||''}`},body:form});const raw=await res.json().catch(()=>({}));if(!res.ok)throw new Error(Array.isArray(raw.message)?raw.message.join('；'):raw.message||'上传失败');return raw?.code===0?raw.data:raw;};
  const addAttachment=async(file:File,target:'project'|'voucher')=>{try{const saved=await uploadObject(file);if(target==='project')setProjectAttachments(list=>[...list,saved]);else setVoucherAttachments(list=>[...list,saved]);message.success(`${file.name||'截图'}已上传`);}catch(e){message.error(errorText(e));throw e;}};
  const pasteAttachment=(target:'project'|'voucher')=>(event:React.ClipboardEvent<HTMLDivElement>)=>{const file=[...event.clipboardData.items].find(item=>item.kind==='file')?.getAsFile();if(file){event.preventDefault();void addAttachment(file,target);}};
  const saveEntry=async(values:any)=>{ try{ await request({method:'POST',url:'/finance/entries',data:{...values,businessDate:values.businessDate?.format('YYYY-MM-DD'),voucherAttachments}}); message.success('流水已保存'); setEntryOpen(false); entryForm.resetFields(); setVoucherAttachments([]); await load(); }catch(e){message.error(errorText(e));} };
  const saveProject=async(values:any)=>{ try{await request({method:'POST',url:'/finance/projects',data:{...values,attachments:projectAttachments}});message.success(values.parentId?'子项目已创建':'项目已创建');setProjectOpen(false);projectForm.resetFields();setProjectAttachments([]);await load();}catch(e){message.error(errorText(e));} };
  const saveMail=async(values:any)=>{try{await request({method:'PUT',url:'/finance/mail-connection',data:values});message.success('邮箱连接已安全保存');setMailOpen(false);mailForm.resetFields();await load();}catch(e){message.error(errorText(e));}};
  const testMail=async()=>{try{const values=await mailForm.validateFields();const r:any=await request({method:'POST',url:'/finance/mail-connection/test',data:values});message.success(r.message);}catch(e){message.error(errorText(e));}};
  const syncMail=async()=>{try{const r:any=await request({method:'POST',url:'/finance/mail-connection/sync'});message.success(`同步完成，新导入 ${r.imported} 张发票`);await load();}catch(e){message.error(errorText(e));}};
  const openMatch=async(invoice:Invoice)=>{try{setMatching(invoice);setCandidates(await request({url:`/finance/invoices/${invoice.id}/candidates`}) as Entry[]);}catch(e){message.error(errorText(e));}};
  const match=async(entryId:number)=>{if(!matching)return;try{await request({method:'POST',url:`/finance/invoices/${matching.id}/match`,data:{entryId}});message.success('发票已匹配到流水');setMatching(null);await load();}catch(e){message.error(errorText(e));}};
  const discard=async(invoice:Invoice)=>{Modal.confirm({title:'丢弃这张发票？',content:'发票会进入“已丢弃”，之后仍可恢复，不会删除原邮件。',okText:'确认丢弃',cancelText:'取消',onOk:async()=>{await request({method:'POST',url:`/finance/invoices/${invoice.id}/discard`,data:{reason:'人工确认无需入账'}});await load();}})};
  const saveReimbursement=async(values:any)=>{try{await request({method:'POST',url:'/finance/reimbursements',data:{...values,applicationDate:values.applicationDate?.format('YYYY-MM-DD')}});message.success('报销申请已创建');setReimburseOpen(false);reimburseForm.resetFields();await load();}catch(e){message.error(errorText(e));}};

  if(loading&&allowed===null)return <div className="finance-loading"><Spin size="large"/><span>正在加载财务数据…</span></div>;
  if(allowed===false)return <Alert showIcon type="warning" message="无权访问财务记账" description="财务数据仅管理员和指定财务人员可见。如需使用，请联系管理员。"/>;

  const entryColumns=[
    {title:'日期',dataIndex:'businessDate',width:112},{title:'收支',dataIndex:'flowType',width:86,render:(v:string)=><Tag color={v==='income'?'green':'volcano'}>{v==='income'?'收入':'支出'}</Tag>},
    {title:'事由',dataIndex:'reason',minWidth:220},{title:'项目',dataIndex:'projectId',render:(v:number|null)=>projectName(v)},
    {title:'归属',dataIndex:'owner',render:(v:string)=>ownerLabels[v]},{title:'支付方式',dataIndex:'paymentMethod',render:(v:string)=>paymentLabels[v]},
    {title:'报销',dataIndex:'reimbursementStatus',render:(v:string)=>{const x=reimbursementLabels[v]||[v,'default'];return <Tag color={x[1]}>{x[0]}</Tag>}},
    {title:'金额',dataIndex:'amount',align:'right' as const,render:(v:string,r:Entry)=><strong className={r.flowType==='income'?'money-income':'money-expense'}>{r.flowType==='income'?'+':'-'}¥{money(v)}</strong>},
  ];
  const invoiceColumns=[
    {title:'收到时间',dataIndex:'createdAt',render:(v:string)=>dayjs(v).format('YYYY-MM-DD HH:mm')},{title:'发票文件',dataIndex:'originalName',minWidth:220},
    {title:'金额',dataIndex:'amount',render:(v:string|null)=>v?`¥${money(v)}`:'待识别'},{title:'来源',dataIndex:'source',render:(v:string)=>v==='email'?'QQ 邮箱':'手工上传'},
    {title:'状态',dataIndex:'status',render:(v:string)=>{const x=invoiceLabels[v]||[v,'default'];return <Tag color={x[1]}>{x[0]}</Tag>}},
    {title:'操作',key:'actions',render:(_:unknown,r:Invoice)=><Space>{r.status==='inbox'&&<><Button type="primary" size="small" onClick={()=>openMatch(r)}>匹配流水</Button><Button size="small" onClick={()=>discard(r)}>丢弃</Button></>}{r.status==='discarded'&&<Button size="small" onClick={async()=>{await request({method:'POST',url:`/finance/invoices/${r.id}/restore`});await load();}}>恢复</Button>}</Space>},
  ];

  return <div className="finance-page">
    <section className="finance-hero">
      <div><div className="finance-eyebrow"><SafetyCertificateOutlined/> 独立财务账套</div><h1>财务记账</h1><p>把项目、流水、发票和报销放在一条清晰的工作流里。</p></div>
      <Space wrap><Button icon={<SettingOutlined/>} onClick={()=>{mailForm.setFieldsValue({email:'',enabled:true});setMailOpen(true)}}>邮箱设置</Button><Button type="primary" icon={<PlusOutlined/>} onClick={()=>{entryForm.setFieldsValue({businessDate:dayjs(),flowType:'expense',owner:'pruis',paymentMethod:'wechat',reimbursementRequired:true});setEntryOpen(true)}}>记一笔</Button></Space>
    </section>
    <div className="finance-stats">
      <Card><Statistic title="本月收入" value={dashboard?.month.income||0} precision={2} prefix="¥" valueStyle={{color:'#17845f'}}/></Card>
      <Card><Statistic title="本月支出" value={dashboard?.month.expense||0} precision={2} prefix="¥" valueStyle={{color:'#c55443'}}/></Card>
      <Card className="balance-card"><Statistic title="本月结余" value={dashboard?.month.balance||0} precision={2} prefix="¥"/></Card>
      <Card><div className="attention-title"><InboxOutlined/> 待处理</div><div className="attention-grid"><span><b>{dashboard?.invoiceInbox||0}</b> 张发票</span><span><b>{dashboard?.pendingReimbursement||0}</b> 笔待报销</span></div></Card>
    </div>
    <Tabs className="finance-tabs" items={[
      {key:'entries',label:<span><SwapOutlined/> 流水账</span>,children:<Card className="finance-panel" title="记账流水" extra={<Button type="primary" icon={<PlusOutlined/>} onClick={()=>{entryForm.setFieldsValue({businessDate:dayjs(),flowType:'expense',owner:'pruis',paymentMethod:'wechat',reimbursementRequired:true});setEntryOpen(true)}}>新增流水</Button>}><Table rowKey="id" columns={entryColumns} dataSource={entries} scroll={{x:1080}} pagination={{pageSize:20}} locale={{emptyText:<Empty description="还没有流水，先记第一笔"/>}}/></Card>},
      {key:'projects',label:<span><FolderAddOutlined/> 项目</span>,children:<Card className="finance-panel" title="项目与子项目" extra={<Button type="primary" icon={<FolderAddOutlined/>} onClick={()=>setProjectOpen(true)}>新建项目</Button>}><div className="project-grid">{roots.map(root=><Card key={root.id} size="small" title={root.name} extra={<Button type="link" onClick={()=>{projectForm.setFieldValue('parentId',root.id);setProjectOpen(true)}}>+ 子项目</Button>}><p>{root.description||'暂无项目说明'}</p><div className="subproject-list">{projects.filter(p=>p.parentId===root.id).map(p=><Tag key={p.id} icon={<FileDoneOutlined/>}>{p.name}</Tag>)}</div></Card>)}{!roots.length&&<Empty description="新建项目后，可继续添加子项目和附件"/>}</div></Card>},
      {key:'invoices',label:<span><InboxOutlined/> 发票收件箱 <Tag color="blue">{dashboard?.invoiceInbox||0}</Tag></span>,children:<Card className="finance-panel" title="发票收件箱" extra={<Space><Upload accept=".pdf,.ofd,.xml,.jpg,.jpeg,.png,.webp,.zip" showUploadList={false} customRequest={async({file,onSuccess,onError})=>{try{await uploadObject(file as File,'/finance/invoices/upload');onSuccess?.({});message.success('发票已导入');await load();}catch(e){onError?.(e as Error);message.error(errorText(e));}}}><Button icon={<FileAddOutlined/>}>上传发票</Button></Upload><Button icon={<CloudSyncOutlined/>} disabled={!mailStatus} onClick={syncMail}>同步 QQ 邮箱</Button></Space>}>
        <Alert className="mail-status" showIcon type={mailStatus?.lastError?'warning':'info'} message={mailStatus?`已连接 ${mailStatus.emailMasked}，首次同步最近 7 天`:'尚未连接 QQ 邮箱'} description={mailStatus?.lastError?`上次同步失败：${mailStatus.lastError}`:mailStatus?.lastSuccessAt?`上次成功：${dayjs(mailStatus.lastSuccessAt).format('YYYY-MM-DD HH:mm')}`:'连接后仅自动收取 PDF 发票附件；不会标记已读、移动或删除邮件。'} action={<Button size="small" onClick={()=>setMailOpen(true)}>{mailStatus?'修改':'立即连接'}</Button>}/>
        <Table rowKey="id" columns={invoiceColumns} dataSource={invoices} scroll={{x:900}} pagination={{pageSize:20}} locale={{emptyText:<Empty description="暂未收到发票"/>}}/>
      </Card>},
      {key:'reimburse',label:<span><WalletOutlined/> 报销管理</span>,children:<Card className="finance-panel" title="报销申请" extra={<Button type="primary" icon={<BankOutlined/>} disabled={!entries.some(e=>e.reimbursementStatus==='pending')} onClick={()=>{reimburseForm.setFieldsValue({applicationDate:dayjs()});setReimburseOpen(true)}}>发起报销</Button>}><Table rowKey="id" dataSource={reimbursements} columns={[{title:'申请单号',dataIndex:'applicationNo'},{title:'申请人',dataIndex:'claimantName'},{title:'申请日期',dataIndex:'applicationDate'},{title:'金额',dataIndex:'amount',render:(v:string)=><strong>¥{money(v)}</strong>},{title:'状态',dataIndex:'status',render:(v:string)=><Tag color={v==='paid'?'green':'blue'}>{v==='paid'?'已报销':'待付款'}</Tag>},{title:'操作',render:(_:unknown,r:Reimbursement)=>r.status==='submitted'?<Button size="small" type="primary" onClick={async()=>{await request({method:'POST',url:`/finance/reimbursements/${r.id}/paid`});await load();}}>标记已报销</Button>:null}]} locale={{emptyText:<Empty description="暂无报销申请"/>}}/></Card>},
    ]}/>

    <Modal title="新增记账流水" open={entryOpen} onCancel={()=>setEntryOpen(false)} footer={null} width={760} destroyOnClose><Form form={entryForm} layout="vertical" onFinish={saveEntry} preserve><div className="form-grid"><Form.Item label="日期" name="businessDate" rules={[{required:true,message:'请选择日期'}]}><DatePicker/></Form.Item><Form.Item label="收入 / 支出" name="flowType" rules={[{required:true,message:'请选择方向'}]}><Radio.Group buttonStyle="solid"><Radio.Button value="expense">支出</Radio.Button><Radio.Button value="income">收入</Radio.Button></Radio.Group></Form.Item><Form.Item label="金额" name="amount" rules={[{required:true,message:'请填写金额'}]}><InputNumber min={0.01} precision={2} prefix="¥" className="full-width"/></Form.Item><Form.Item label="归属" name="owner" rules={[{required:true,message:'请选择归属'}]}><Radio.Group><Radio value="osiris">OsirisList</Radio><Radio value="pruis">普睿斯</Radio><Radio value="personal">个人</Radio></Radio.Group></Form.Item><Form.Item className="span-2" label="事由" name="reason" rules={[{required:true,message:'请填写事由'}]}><Input.TextArea rows={3} maxLength={500} showCount placeholder="例如：购买项目现场用的照明材料"/></Form.Item><Form.Item label="项目（可后补）" name="projectId"><Select allowClear options={roots.map(p=>({value:p.id,label:p.name}))}/></Form.Item><Form.Item label="子项目（可后补）" name="subProjectId"><Select allowClear options={projects.filter(p=>p.parentId).map(p=>({value:p.id,label:`${projectName(p.parentId)} / ${p.name}`}))}/></Form.Item><Form.Item label="支付方式" name="paymentMethod"><Radio.Group><Radio value="wechat">微信</Radio><Radio value="alipay">支付宝</Radio><Radio value="bank">对公转账</Radio><Radio value="cash">现金</Radio></Radio.Group></Form.Item><Form.Item label="需要报销" name="reimbursementRequired" valuePropName="checked"><Checkbox>保存后进入待报销清单</Checkbox></Form.Item><Form.Item className="span-2" label="凭证"><div onPaste={pasteAttachment('voucher')}><Upload.Dragger multiple showUploadList={false} customRequest={async({file,onSuccess,onError})=>{try{await addAttachment(file as File,'voucher');onSuccess?.({});}catch(e){onError?.(e as Error);}}}><p className="ant-upload-drag-icon"><InboxOutlined/></p><p>拖拽上传凭证，或在此处粘贴截图</p><p className="upload-hint">已上传 {voucherAttachments.length} 个文件，单个不超过 30MB</p></Upload.Dragger></div>{voucherAttachments.map((file,index)=><Tag closable key={file.objectKey} onClose={()=>setVoucherAttachments(list=>list.filter((_,i)=>i!==index))}>{file.name}</Tag>)}</Form.Item></div><div className="modal-actions"><Button onClick={()=>setEntryOpen(false)}>取消</Button><Button type="primary" htmlType="submit">保存流水</Button></div></Form></Modal>
    <Modal title="新建项目" open={projectOpen} onCancel={()=>setProjectOpen(false)} footer={null} destroyOnClose><Form form={projectForm} layout="vertical" onFinish={saveProject}><Form.Item label="上级项目" name="parentId"><Select allowClear placeholder="不选则创建一级项目" options={roots.map(p=>({value:p.id,label:p.name}))}/></Form.Item><Form.Item label="项目名称" name="name" rules={[{required:true,message:'请填写项目名称'}]}><Input maxLength={120}/></Form.Item><Form.Item label="项目说明" name="description"><Input.TextArea rows={4} maxLength={1000}/></Form.Item><Form.Item label="项目附件"><div onPaste={pasteAttachment('project')}><Upload.Dragger multiple showUploadList={false} customRequest={async({file,onSuccess,onError})=>{try{await addAttachment(file as File,'project');onSuccess?.({});}catch(e){onError?.(e as Error);}}}><p className="ant-upload-drag-icon"><InboxOutlined/></p><p>拖拽各种文档到这里，或直接粘贴截图</p><p className="upload-hint">已上传 {projectAttachments.length} 个文件，单个不超过 30MB</p></Upload.Dragger></div>{projectAttachments.map((file,index)=><Tag closable key={file.objectKey} onClose={()=>setProjectAttachments(list=>list.filter((_,i)=>i!==index))}>{file.name}</Tag>)}</Form.Item><div className="modal-actions"><Button onClick={()=>setProjectOpen(false)}>取消</Button><Button type="primary" htmlType="submit">创建项目</Button></div></Form></Modal>
    <Modal title="连接 QQ 邮箱" open={mailOpen} onCancel={()=>setMailOpen(false)} footer={null} destroyOnClose><Alert showIcon type="info" message="使用 IMAP 授权码，不是 QQ 密码" description="系统只读同步收件箱中的 PDF 发票附件，不会标记已读、移动或删除邮件。首次同步最近 7 天，之后只拉取新邮件。"/><Form form={mailForm} layout="vertical" onFinish={saveMail} initialValues={{enabled:true}}><Form.Item label="QQ 邮箱" name="email" rules={[{required:!mailStatus,message:'请填写 QQ 邮箱'}]}><Input placeholder={mailStatus?.emailMasked||'例如：123456@qq.com'} autoComplete="off"/></Form.Item><Form.Item label={mailStatus?'新授权码（留空保持不变）':'IMAP 授权码'} name="authorizationCode" rules={[{required:!mailStatus,message:'请填写 IMAP 授权码'}]}><Input.Password autoComplete="new-password"/></Form.Item><Form.Item name="enabled" valuePropName="checked"><Checkbox>启用自动同步</Checkbox></Form.Item><div className="modal-actions"><Button onClick={testMail}>测试连接</Button><Button type="primary" htmlType="submit">安全保存</Button></div></Form></Modal>
    <Modal title="选择要匹配的流水" open={!!matching} onCancel={()=>setMatching(null)} footer={null} width={820}><Alert showIcon type="info" message={matching?`发票：${matching.originalName}${matching.amount?`，金额 ¥${money(matching.amount)}`:''}`:''} description="系统只提供候选项，需由你确认后才会建立关联。"/><Table rowKey="id" dataSource={candidates} scroll={{x:700}} columns={[{title:'匹配度',dataIndex:'score',render:(v:number)=><Tag color={v>=50?'blue':'default'}>{v} 分</Tag>},{title:'日期',dataIndex:'businessDate'},{title:'事由',dataIndex:'reason'},{title:'项目',dataIndex:'projectId',render:(v:number|null)=>projectName(v)},{title:'金额',dataIndex:'amount',render:(v:string)=>`¥${money(v)}`},{title:'',render:(_:unknown,r:Entry)=><Button type="primary" size="small" onClick={()=>match(r.id)}>确认匹配</Button>}]} pagination={{pageSize:8}}/></Modal>
    <Modal title="发起报销" open={reimburseOpen} onCancel={()=>setReimburseOpen(false)} footer={null} width={720} destroyOnClose><Form form={reimburseForm} layout="vertical" onFinish={saveReimbursement}><div className="form-grid"><Form.Item label="报销人姓名" name="claimantName" rules={[{required:true,message:'请填写报销人姓名'}]}><Input/></Form.Item><Form.Item label="电话" name="phone" rules={[{required:true,message:'请填写电话'}]}><Input/></Form.Item><Form.Item label="申请时间" name="applicationDate" rules={[{required:true,message:'请选择申请时间'}]}><DatePicker/></Form.Item><Form.Item label="开户行" name="bankName" rules={[{required:true,message:'请填写开户行'}]}><Input/></Form.Item><Form.Item className="span-2" label="银行账号" name="bankAccount" rules={[{required:true,message:'请填写银行账号'}]}><Input/></Form.Item><Form.Item className="span-2" label="报销事由" name="reason" rules={[{required:true,message:'请填写报销事由'}]}><Input.TextArea rows={3}/></Form.Item><Form.Item className="span-2" label="选择待报销流水" name="entryIds" rules={[{required:true,message:'请至少选择一笔流水'}]}><Checkbox.Group className="entry-checklist">{entries.filter(e=>e.reimbursementStatus==='pending').map(e=><Checkbox key={e.id} value={e.id}><span>{e.businessDate} · {e.reason}</span><strong>¥{money(e.amount)}</strong></Checkbox>)}</Checkbox.Group></Form.Item></div><div className="modal-actions"><Button onClick={()=>setReimburseOpen(false)}>取消</Button><Button type="primary" htmlType="submit">提交报销</Button></div></Form></Modal>
  </div>;
}
