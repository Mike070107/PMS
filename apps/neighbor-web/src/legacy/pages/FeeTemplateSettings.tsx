import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, App, Button, Checkbox, DatePicker, Empty, Form, Input, InputNumber, List, Modal, Popconfirm, Select, Space, Spin, Table, Tabs, Tag, Typography } from 'antd';
import { CopyOutlined, EditOutlined, PlusOutlined, ReloadOutlined, TeamOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import { FEE_ITEMS, formatFeeMoney } from '@pms/shared-types';
import { request } from '../lib/api';
import { usePagePerm } from '../lib/auth';
import './FeeTemplateSettings.css';

type Kind='apartment'|'residential';
type Item={feeCode:string;unitPriceCents:number;unit:string;calculation:'fixed'|'quantity'|'area';cycle:'month'|'once';originalStandardCents?:number|null};
type Version={id:number;version:number;effective_from:string;items:Item[]};
type Template={id:number;name:string;enabled:boolean;revision:number;assigned_count:number;versions:Version[]};
type Community={id:number;name:string;kind:Kind};
type Building={id:number;building_no:string;lane:string|null};
type House={id:number;room_no:string;building_no:string;lane:string|null;owner_name:string|null;template_id:number|null;template_name:string|null;overrides:Record<string,number>|null;effective_from:string|null;has_legacy_standard:boolean};
type LegacyPreview={fingerprint:string;houses:number;groups:Array<{items:Item[];houseIds:number[]}>};
const labels=Object.fromEntries(FEE_ITEMS.map(item=>[item.code,item.name]));
const calculations={fixed:'固定金额',quantity:'按用量',area:'按建筑面积'};
const today=()=>dayjs().format('YYYY-MM-DD');
const beforeToday=(date:dayjs.Dayjs)=>date.isBefore(dayjs().startOf('day'));
const owns=(object:Record<string,number>,key:string)=>Object.prototype.hasOwnProperty.call(object,key);
const activeVersion=(template:Template,date:string)=>template.versions.filter(v=>v.effective_from<=date).sort((a,b)=>b.effective_from.localeCompare(a.effective_from)||b.version-a.version)[0];

export default function FeeTemplateSettings() {
  const {message}=App.useApp();
  const {canEdit}=usePagePerm('settings');
  const [kind,setKind]=useState<Kind>('apartment');
  const [communities,setCommunities]=useState<Community[]>([]);
  const [communityId,setCommunityId]=useState<number>();
  const [templates,setTemplates]=useState<Template[]>([]);
  const [buildings,setBuildings]=useState<Building[]>([]);
  const [selectedTemplate,setSelectedTemplate]=useState<number>();
  const [versionNumber,setVersionNumber]=useState<number>();
  const [rows,setRows]=useState<House[]>([]);
  const [total,setTotal]=useState(0);
  const [page,setPage]=useState(1);
  const [q,setQ]=useState('');
  const [buildingId,setBuildingId]=useState<number>();
  const [filter,setFilter]=useState('all');
  const [selectedHouses,setSelectedHouses]=useState<React.Key[]>([]);
  const [loading,setLoading]=useState(false);
  const [error,setError]=useState<string|null>(null);
  const [refresh,setRefresh]=useState(0);
  const sequence=useRef(0);
  const [form]=Form.useForm();
  const [editor,setEditor]=useState<{id?:number}|null>(null);
  const [saving,setSaving]=useState(false);
  const [assignment,setAssignment]=useState<{all:boolean;ids:number[];count:number}|null>(null);
  const [assignmentDate,setAssignmentDate]=useState(dayjs());
  const [preserve,setPreserve]=useState(true);
  const [exception,setException]=useState<House|null>(null);
  const [exceptionDate,setExceptionDate]=useState(dayjs());
  const [overrides,setOverrides]=useState<Record<string,number>>({});
  const [legacy,setLegacy]=useState<LegacyPreview|null>(null);
  const [legacyDate,setLegacyDate]=useState(dayjs());
  const template=templates.find(t=>t.id===selectedTemplate);
  const version=template?.versions.find(v=>v.version===versionNumber)??template?.versions[0];
  const scope=useMemo(()=>({communityId,kind}),[communityId,kind]);
  const reload=()=>setRefresh(value=>value+1);

  useEffect(()=>{
    let alive=true;
    request<Community[]>({url:'/fees/templates/communities'}).then(data=>{if(alive){setCommunities(data);if(!communityId)setError(null);}}).catch(e=>{if(alive)setError(e.message||'门店列表读取失败');});
    return ()=>{alive=false;};
  },[refresh]);
  useEffect(()=>{
    const run=++sequence.current;
    setSelectedHouses([]);
    if(!communityId) {setTemplates([]);setRows([]);setBuildings([]);setTotal(0);setLoading(false);return;}
    setLoading(true);setError(null);setRows([]);
    Promise.all([
      request<{templates:Template[];buildings:Building[]}>({url:'/fees/templates',query:scope}),
      request<{rows:House[];total:number}>({url:'/fees/templates/houses',query:{...scope,page,q,buildingId,filter}}),
    ]).then(([catalog,houses])=>{
      if(run!==sequence.current)return;
      setTemplates(catalog.templates);setBuildings(catalog.buildings);setRows(houses.rows);setTotal(houses.total);
      setSelectedTemplate(current=>catalog.templates.some(t=>t.id===current)?current:catalog.templates[0]?.id);
    }).catch(e=>{if(run===sequence.current){setError(e.message||'收费模板读取失败');setTemplates([]);setRows([]);setTotal(0);}})
      .finally(()=>{if(run===sequence.current)setLoading(false);});
    return ()=>{sequence.current++;};
  },[scope,communityId,page,q,buildingId,filter,refresh]);
  useEffect(()=>setVersionNumber(undefined),[selectedTemplate,communityId]);

  const changeScope=(value:number|undefined,nextKind=kind)=>{
    sequence.current++;setCommunityId(value);setKind(nextKind);setPage(1);setQ('');setBuildingId(undefined);setFilter('all');setTemplates([]);setRows([]);setSelectedTemplate(undefined);setSelectedHouses([]);setEditor(null);setAssignment(null);setException(null);setLegacy(null);
  };
  const openEditor=(edit:boolean,copy=false)=>{
    form.resetFields();
    const source=edit?template?.versions[0]:copy?version:undefined;
    form.setFieldsValue({name:edit?template?.name:copy?`${template?.name} 副本`:'',effectiveFrom:dayjs(source?.effective_from && source.effective_from>today()?source.effective_from:today()),items:source?.items.map(item=>({...item,priceYuan:item.unitPriceCents/100}))??[{feeCode:kind==='apartment'?'rent':'management',priceYuan:0,unit:'月',calculation:'fixed',cycle:'month'}]});
    setEditor(edit?{id:template?.id}:{});
  };
  const saveTemplate=async()=>{
    let values;
    try {values=await form.validateFields();} catch {return;}
    setSaving(true);
    try {
      await request({method:editor?.id?'PATCH':'POST',url:editor?.id?`/fees/templates/${editor.id}`:'/fees/templates',data:{...scope,name:values.name,effectiveFrom:values.effectiveFrom.format('YYYY-MM-DD'),expectedRevision:editor?.id?template?.revision:undefined,
        items:values.items.map((item:Item&{priceYuan:number})=>({feeCode:item.feeCode,unitPriceCents:Math.round(item.priceYuan*100),unit:item.unit,calculation:item.calculation,cycle:item.cycle,...(item.originalStandardCents!==undefined?{originalStandardCents:item.originalStandardCents}:{})}))}});
      message.success('模板已保存，按生效日期供套用户使用；历史账单不变');setEditor(null);reload();
    } catch(e:any) {message.error(e.message||'模板没有保存，输入已保留');} finally {setSaving(false);}
  };
  const openAssignment=async(all:boolean)=>{
    if(!template?.enabled){message.warning('请先选择生效模板');return;}
    setAssignmentDate(dayjs());setPreserve(true);
    if(all) {
      const run=sequence.current;
      setLoading(true);
      try {const result=await request<{total:number}>({url:'/fees/templates/houses',query:{...scope,buildingId,page:1,filter:'all'}});if(run===sequence.current)setAssignment({all:true,ids:[],count:result.total});}
      catch(e:any){message.error(e.message);}finally{setLoading(false);}
    } else setAssignment({all:false,ids:selectedHouses.map(Number),count:selectedHouses.length});
  };
  const assign=async()=>{
    if(!assignment||!template)return;
    setSaving(true);
    try {
      const result=await request<{changed:number}>({method:'POST',url:'/fees/templates/assign',data:{...scope,templateId:template.id,expectedRevision:template.revision,expectedCount:assignment.count,all:assignment.all,houseIds:assignment.all?undefined:assignment.ids,buildingId:assignment.all?buildingId:undefined,effectiveFrom:assignmentDate.format('YYYY-MM-DD'),preserveOverrides:preserve}});
      message.success(`已保存 ${result.changed} 户的套用配置`);setAssignment(null);setSelectedHouses([]);reload();
    } catch(e:any){message.error(e.message||'套用失败，未修改');}finally{setSaving(false);}
  };
  const openException=(row:House)=>{setException(row);setOverrides({...row.overrides});setExceptionDate(dayjs());};
  const exceptionTemplate=templates.find(t=>t.id===exception?.template_id);
  const exceptionItems=exceptionTemplate?activeVersion(exceptionTemplate,exceptionDate.format('YYYY-MM-DD'))?.items??[]:[];
  const saveException=async()=>{
    if(!exception||!exceptionTemplate)return;
    setSaving(true);
    try {await request({method:'POST',url:'/fees/templates/assign',data:{...scope,templateId:exceptionTemplate.id,expectedRevision:exceptionTemplate.revision,expectedCount:1,houseIds:[exception.id],effectiveFrom:exceptionDate.format('YYYY-MM-DD'),overrides}});message.success('个别调整已保存，其余项目继续跟随模板');setException(null);reload();}
    catch(e:any){message.error(e.message||'没有保存，输入已保留');}finally{setSaving(false);}
  };
  const previewLegacy=async()=>{
    const run=sequence.current;
    setLoading(true);
    try {const data=await request<LegacyPreview>({url:'/fees/templates/legacy-preview',query:scope});if(run===sequence.current){setLegacyDate(dayjs());setLegacy(data);}}
    catch(e:any){message.error(e.message||'原标准预览失败');}finally{setLoading(false);}
  };
  const migrate=async()=>{
    if(!legacy)return;
    setSaving(true);
    try {const result=await request<{houses:number;templates:number}>({method:'POST',url:'/fees/templates/legacy-import',data:{...scope,fingerprint:legacy.fingerprint,effectiveFrom:legacyDate.format('YYYY-MM-DD')}});message.success(`已归并 ${result.templates} 个模板并套用 ${result.houses} 户，原标准历史保留`);setLegacy(null);reload();}
    catch(e:any){message.error(e.message||'归并失败，请重新预览');}finally{setSaving(false);}
  };

  return <div className="fee-template-settings">
    <Tabs activeKey={kind} onChange={key=>changeScope(undefined,key as Kind)} items={[{key:'apartment',label:'公寓收费标准'},{key:'residential',label:'小区收费标准'}]} />
    <div className="fee-template-toolbar">
      <label>{kind==='apartment'?'门店':'小区'}<Select aria-label={kind==='apartment'?'选择公寓门店':'选择小区'} placeholder="请先选择" value={communityId} onChange={value=>changeScope(value)} options={communities.filter(c=>c.kind===kind).map(c=>({value:c.id,label:c.name}))} style={{minWidth:220}} /></label>
      <Button icon={<ReloadOutlined />} disabled={!communityId} onClick={reload}>刷新</Button>
      <Button icon={<CopyOutlined />} disabled={!communityId||!canEdit} onClick={previewLegacy}>归并原逐户标准</Button>
      <Button type="primary" icon={<PlusOutlined />} disabled={!communityId||!canEdit} onClick={()=>openEditor(false)}>新建模板</Button>
    </div>
    {error&&<Alert type="error" showIcon message={error} action={<Button onClick={reload}>重试</Button>} />}
    {!communityId?<Empty description={`请选择${kind==='apartment'?'公寓门店':'小区'}，不会混入其他房产`} />:<Spin spinning={loading}>
      <div className="fee-template-columns">
        <section className="fee-template-list"><h3>收费模板 <Tag>{templates.length}</Tag></h3>
          {templates.length?<List dataSource={templates} renderItem={item=><List.Item><button className={`fee-template-choice ${item.id===selectedTemplate?'is-selected':''}`} onClick={()=>setSelectedTemplate(item.id)}><strong>{item.name}</strong><span>{item.assigned_count} 户套用 · V{item.revision}{!item.enabled?' · 已停用':''}</span></button></List.Item>}/>:<Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无模板，可新建或归并原标准"/>}
        </section>
        <section className="fee-template-detail">
          {template&&version?<><div className="fee-template-title"><h3>{template.name}</h3><Select aria-label="查看模板版本" value={version.version} onChange={setVersionNumber} options={template.versions.map(v=>({value:v.version,label:`V${v.version} · ${v.effective_from} 生效`}))}/><Tag>{version.effective_from>today()?'待生效':'版本快照'}</Tag></div>
            <Table<Item> rowKey="feeCode" size="small" pagination={false} dataSource={version.items} columns={[{title:'收费项目',dataIndex:'feeCode',render:code=>labels[code]??code},{title:'单价',dataIndex:'unitPriceCents',render:value=>formatFeeMoney(value)},{title:'单位',dataIndex:'unit'},{title:'计费方式',dataIndex:'calculation',render:value=>calculations[value as keyof typeof calculations]},{title:'周期',dataIndex:'cycle',render:value=>value==='month'?'每月':'按次 / 用量'}]} scroll={{x:560}}/>
            <p className="fee-template-note">住户关联模板，不复制标准。新版本按生效日用于计费；历史账单与收款记录保持原价。</p>
            <Space wrap><Button icon={<EditOutlined/>} disabled={!canEdit||!template.enabled} onClick={()=>openEditor(true)}>修改模板 · 影响 {template.assigned_count} 户</Button><Button disabled={!canEdit} onClick={()=>openEditor(false,true)}>复制为新模板</Button><Popconfirm title="停用后不能继续分配；仍有住户使用时需先更换模板" onConfirm={async()=>{try{await request({method:'POST',url:`/fees/templates/${template.id}/disable`,data:scope});message.success('模板已停用');reload();}catch(e:any){message.error(e.message);}}}><Button danger disabled={!canEdit||!template.enabled}>停用</Button></Popconfirm></Space>
          </>:<Empty description="选择左侧模板查看收费项目"/>}
        </section>
      </div>
      <section className="fee-template-house-list"><div className="fee-template-title"><h3><TeamOutlined/> 住户套用清单</h3><span>筛选结果 {total} 户</span></div>
        <div className="fee-template-toolbar">
          <Select aria-label="筛选楼栋" allowClear placeholder="全部楼栋" value={buildingId} onChange={value=>{setBuildingId(value);setPage(1);}} options={buildings.map(b=>({value:b.id,label:`${b.lane?b.lane+'弄':''}${b.building_no}号`}))} style={{width:180}}/>
          <Input aria-label="搜索房号或住户" placeholder="房号 / 住户姓名" value={q} onChange={e=>{setQ(e.target.value);setPage(1);}} style={{width:200}}/>
          <Select aria-label="套用状态" value={filter} onChange={value=>{setFilter(value);setPage(1);}} options={[{value:'all',label:'全部住户'},{value:'unassigned',label:'未套用模板'},{value:'override',label:'有个别调整'}]} style={{width:150}}/>
          <Button disabled={!canEdit||!selectedHouses.length||!template?.enabled} onClick={()=>openAssignment(false)}>套用选中 {selectedHouses.length} 户</Button>
          <Button disabled={!canEdit||!template?.enabled} onClick={()=>openAssignment(true)}>{buildingId?'套用整栋':'套用整个门店 / 小区'}</Button>
        </div>
        <Table<House> rowKey="id" size="small" dataSource={rows} rowSelection={canEdit?{selectedRowKeys:selectedHouses,onChange:setSelectedHouses}:undefined} pagination={{current:page,pageSize:50,total,showSizeChanger:false,onChange:setPage}} scroll={{x:780}} columns={[
          {title:'楼栋',dataIndex:'building_no',width:120,render:(_,row)=>`${row.lane?row.lane+'弄':''}${row.building_no}号`},{title:'房号',dataIndex:'room_no',width:90},{title:'住户姓名',dataIndex:'owner_name',render:value=>value||'—'},
          {title:'当前 / 已安排模板',dataIndex:'template_name',render:(_,row)=>row.template_name?<><strong>{row.template_name}</strong>{row.effective_from&&row.effective_from>today()&&<Tag>待生效</Tag>}</>:<Tag>{row.has_legacy_standard?'未套用 · 使用原标准':'未配置标准'}</Tag>},
          {title:'个别调整',key:'overrides',render:(_,row)=>Object.keys(row.overrides??{}).length?Object.entries(row.overrides??{}).map(([code,price])=>`${labels[code]??code} ${formatFeeMoney(price)}`).join('；'):'全部跟随模板'},
          {title:'生效日期',dataIndex:'effective_from',render:value=>value||'—'},
          {title:'操作',key:'actions',render:(_,row)=><Button type="link" disabled={!canEdit||!row.template_id} onClick={()=>openException(row)}>个别调整</Button>},
        ]}/>
      </section>
    </Spin>}

    <Modal title={editor?.id?`修改模板 · ${template?.assigned_count??0} 户跟随`:'新建收费模板'} open={!!editor} onCancel={()=>!saving&&setEditor(null)} onOk={saveTemplate} confirmLoading={saving} width={900} destroyOnHidden maskClosable={!saving}>
      <Alert type="info" showIcon message="保存为新版本，不修改已生成账单；个别调整继续优先于模板"/>
      <Form form={form} layout="vertical" disabled={saving}>
        <div className="fee-template-form-header"><Form.Item name="name" label="模板名称" rules={[{required:true,message:'请输入模板名称'}]}><Input maxLength={80}/></Form.Item><Form.Item name="effectiveFrom" label="生效日期" rules={[{required:true,message:'请选择日期'}]}><DatePicker disabledDate={beforeToday}/></Form.Item></div>
        <Form.List name="items" rules={[{validator:async(_,items)=>{if(!items?.length)throw new Error('至少添加一个项目');}}]}>{(fields,{add,remove},{errors})=><>
          <div className="fee-template-item-header">收费项目 / 单价（元） / 单位 / 计费方式 / 周期</div>
          {fields.map(field=><div className="fee-template-item" key={field.key}>
            <Form.Item name={[field.name,'originalStandardCents']} hidden><InputNumber/></Form.Item>
            <Form.Item name={[field.name,'feeCode']} label="收费项目" rules={[{required:true}]}><Select options={FEE_ITEMS.map(item=>({value:item.code,label:item.name}))}/></Form.Item>
            <Form.Item name={[field.name,'priceYuan']} label="单价（元）" rules={[{required:true,message:'填写单价，可为0'}]}><InputNumber min={0} max={1000000} precision={2}/></Form.Item>
            <Form.Item name={[field.name,'unit']} label="单位" rules={[{required:true}]}><Input maxLength={12}/></Form.Item>
            <Form.Item name={[field.name,'calculation']} label="计费方式" rules={[{required:true}]}><Select options={Object.entries(calculations).map(([value,label])=>({value,label}))}/></Form.Item>
            <Form.Item name={[field.name,'cycle']} label="周期" rules={[{required:true}]}><Select options={[{value:'month',label:'每月'},{value:'once',label:'按次 / 用量'}]}/></Form.Item>
            <Button danger onClick={()=>remove(field.name)}>移除</Button>
          </div>)}
          <Form.ErrorList errors={errors}/><Button onClick={()=>add({priceYuan:0,unit:'月',calculation:'fixed',cycle:'month'})} icon={<PlusOutlined/>} disabled={fields.length>=20}>添加收费项目</Button>
        </>}</Form.List>
      </Form>
    </Modal>
    <Modal title="批量套用模板" open={!!assignment} confirmLoading={saving} onCancel={()=>!saving&&setAssignment(null)} onOk={assign} maskClosable={!saving}>
      <p><strong>{assignment?.count} 户</strong>将套用“{template?.name}”。{assignment?.all?'作用于所选整栋或整个门店，不受搜索条件和当前分页限制。':''}</p>
      <label className="fee-template-modal-field">生效日期<DatePicker value={assignmentDate} allowClear={false} disabled={saving} disabledDate={beforeToday} onChange={value=>value&&setAssignmentDate(value)}/></label>
      <Checkbox disabled={saving} checked={preserve} onChange={e=>setPreserve(e.target.checked)}>保留住户已有的个别单价调整</Checkbox>
      {!preserve&&<Alert type="warning" showIcon message="本次将清除选中住户的个别调整，全部使用模板价格"/>}
    </Modal>
    <Modal title={`个别调整 · ${exception?.building_no}号${exception?.room_no}室`} open={!!exception} confirmLoading={saving} onCancel={()=>!saving&&setException(null)} onOk={saveException} maskClosable={!saving}>
      <p>仅勾选需要例外设置的项目，未勾选的项目继续跟随模板。</p>
      <label className="fee-template-modal-field">生效日期<DatePicker allowClear={false} value={exceptionDate} disabledDate={beforeToday} onChange={value=>value&&setExceptionDate(value)}/></label>
      {!exceptionItems.length&&<Alert type="warning" message="该模板在所选日期尚未生效，请调整日期"/>}
      {exceptionItems.map(item=><div className="fee-template-exception-row" key={item.feeCode}><Checkbox checked={owns(overrides,item.feeCode)} onChange={e=>setOverrides(old=>{const next={...old};if(e.target.checked)next[item.feeCode]=item.unitPriceCents;else delete next[item.feeCode];return next;})}>{labels[item.feeCode]}（模板 {formatFeeMoney(item.unitPriceCents)}/{item.unit}）</Checkbox><InputNumber aria-label={`${labels[item.feeCode]}个别单价`} min={0} max={1000000} precision={2} disabled={saving||!owns(overrides,item.feeCode)} value={owns(overrides,item.feeCode)?overrides[item.feeCode]/100:undefined} onChange={value=>value!==null&&setOverrides(old=>({...old,[item.feeCode]:Math.round(Number(value)*100)}))}/></div>)}
      <Button onClick={()=>setOverrides({})} disabled={saving}>全部恢复跟随模板</Button>
    </Modal>
    <Modal title="原逐户标准归并预览" open={!!legacy} width={800} confirmLoading={saving} onCancel={()=>!saving&&setLegacy(null)} onOk={migrate} okButtonProps={{disabled:!legacy?.houses}} maskClosable={!saving}>
      <Alert type="info" showIcon message={`${legacy?.houses??0} 户可归并为 ${legacy?.groups.length??0} 个模板`} description="只处理尚未套用模板的住户。按全部收费项目、金额及原始签报标准精确分组；已有模板不覆盖，原标准与账单历史不删除。"/>
      <label className="fee-template-modal-field">生效日期<DatePicker allowClear={false} value={legacyDate} disabledDate={beforeToday} onChange={value=>value&&setLegacyDate(value)}/></label>
      <Table rowKey={(_,index)=>String(index)} size="small" pagination={{pageSize:10}} dataSource={legacy?.groups??[]} scroll={{x:560}} columns={[{title:'分组',render:(_,__,index)=>`原标准模板 ${index+1}`},{title:'户数',render:(_,group)=>group.houseIds.length},{title:'收费项目与单价',render:(_,group)=>group.items.map(item=>`${labels[item.feeCode]} ${formatFeeMoney(item.unitPriceCents)}/${item.unit}`).join('；')}]}/>
    </Modal>
  </div>;
}
