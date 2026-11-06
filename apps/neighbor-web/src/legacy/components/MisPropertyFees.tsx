import {Alert,Button,Card,Col,DatePicker,Descriptions,Empty,Form,Row,Select,Space,Spin,Table,Tag,Typography} from 'antd';
import {ReloadOutlined,SearchOutlined} from '@ant-design/icons';
import dayjs from 'dayjs';
import {useEffect,useRef,useState} from 'react';
import {request} from '../lib/api';
import {compareNatural,formatFeePeriod,formatFeeMoney} from '@pms/shared-types';

interface Options {available:boolean;message:string;communities:Array<{id:number;name:string}>;feeItems:Array<{code:string;name:string}>;}
interface HouseOption {id:number;label:string;ownerName:string|null;}
interface MisRow {id:string;address:string;ownerName:string|null;communityName:string;feeName:string|null;feeCode:string;period:string;amountCents:number;status:'paid'|'unpaid'|'refunded'|'adjustment';paidAt:string|null;refundedAt:string|null;documentNo:string|null;receiptNo:string|null;paymentMethod:string|null;invoiceNo:string|null;cashier:string|null;remark:string|null;updatedAt:string|null;}
interface Result {rows:MisRow[];total:number;page:number;pageSize:number;queriedAt:string;summary:{receivableCents:number;unpaidCents:number;paidCents:number;refundedCount:number;latestUpdatedAt:string|null};}
type Filters=Record<string,string|number|undefined>;
const statusLabels={unpaid:'未收',paid:'已收',refunded:'已退款',adjustment:'负数调整'};
const money=(n:number)=>formatFeeMoney(n);
export default function MisPropertyFees(){
 const [form]=Form.useForm();
 const [options,setOptions]=useState<Options|null>(null),[initialLoading,setInitialLoading]=useState(true);
 const [error,setError]=useState(''),[loading,setLoading]=useState(false),[result,setResult]=useState<Result|null>(null);
 const [filters,setFilters]=useState<Filters|null>(null);
 const [communityId,setCommunityId]=useState<number|undefined>(),[houseTerm,setHouseTerm]=useState('');
 const [houseOptions,setHouseOptions]=useState<HouseOption[]>([]),[houseLoading,setHouseLoading]=useState(false),[houseError,setHouseError]=useState('');
 const [page,setPage]=useState(1),[pageSize,setPageSize]=useState(50),[refresh,setRefresh]=useState(0),[optionsRefresh,setOptionsRefresh]=useState(0);
 const generation=useRef(0);
 useEffect(()=>{let active=true;setInitialLoading(true);setError('');
  request<Options>({url:'/fees/mis/options',timeout:20000}).then(data=>{if(active){setOptions(data);const first=data.communities[0]?.id;setCommunityId(first);form.setFieldsValue({communityId:first,houseId:undefined});setFilters(null);setResult(null);}}).catch(e=>{if(active){setOptions(null);setError(e.message||'一通MIS连接检查失败');}}).finally(()=>{if(active)setInitialLoading(false);});return()=>{active=false;};
 },[optionsRefresh]);
 useEffect(()=>{
  if(!communityId){setHouseOptions([]);setHouseLoading(false);return;}
  let active=true;setHouseLoading(true);setHouseError('');
  const timer=setTimeout(()=>{request<{rows:HouseOption[]}>({url:'/fees/mis/houses',query:{communityId,q:houseTerm||undefined},timeout:15000}).then(data=>{if(active)setHouseOptions([...data.rows].sort((a,b)=>compareNatural(a.label,b.label)));}).catch(e=>{if(active){setHouseOptions([]);setHouseError(e.message||'房号查询失败');}}).finally(()=>{if(active)setHouseLoading(false);});},250);
  return()=>{active=false;clearTimeout(timer);};
 },[communityId,houseTerm]);
 useEffect(()=>{
  if(!options?.available||!filters?.houseId){setLoading(false);return;}
  const current=++generation.current;setLoading(true);setError('');
  request<Result>({url:'/fees/mis/bills',query:{...filters,page,pageSize},timeout:25000}).then(data=>{if(current===generation.current)setResult(data);}).catch(e=>{if(current===generation.current){setError(e.message||'查询未完成，请重试');setResult(null);}}).finally(()=>{if(current===generation.current)setLoading(false);});
  return()=>{generation.current++;};
 },[options,filters,page,pageSize,refresh]);
 const search=(values:any)=>{
  const period=values.period,paid=values.paid;
  setPage(1);setFilters({communityId:values.communityId,houseId:values.houseId,feeCode:values.feeCode,status:values.status,periodFrom:period?.[0]?.format('YYYYMM'),periodTo:period?.[1]?.format('YYYYMM'),paidFrom:paid?.[0]?.format('YYYY-MM-DD'),paidTo:paid?.[1]?.format('YYYY-MM-DD')});
 };
 if(initialLoading)return <Spin tip="正在检查一通MIS查询连接"><div style={{minHeight:160}} /></Spin>;
 if(!options?.available)return <Alert type={error?'error':'info'} showIcon message={error||options?.message||'一通MIS查询尚未就绪'} action={<Button onClick={()=>setOptionsRefresh(x=>x+1)}>重新检查</Button>} />;
 return <Space className="mis-property-fees" direction="vertical" size={16} style={{width:'100%'}}>
  <div><Typography.Title level={4} style={{margin:'0 0 6px'}}>物业费查询</Typography.Title><Typography.Text type="secondary">先选小区和房号，查看该户分项账单与欠费。数据来源：一通MIS · 仅查询</Typography.Text></div>
  <Card size="small">
   <Form form={form} layout="vertical" onFinish={search} onValuesChange={()=>{setResult(null);setFilters(null);setError('');}} initialValues={{period:[dayjs().startOf('year'),dayjs().endOf('year')]}}>
    <Row gutter={16}>
     <Col xs={24} sm={8}><Form.Item name="communityId" label="小区" rules={[{required:true,message:'请选择小区'}]}><Select placeholder="请选择小区" options={options.communities.map(c=>({value:c.id,label:c.name}))} onChange={value=>{setCommunityId(value);setHouseTerm('');setHouseOptions([]);form.setFieldValue('houseId',undefined);}} /></Form.Item></Col>
     <Col xs={24} sm={16}><Form.Item name="houseId" label="房号 / 住户" rules={[{required:true,message:'请选择需要查询的房号'}]} help={houseError||'输入楼栋房号（如2号101）、住户姓名或电话查找；每次显示前50项。'} validateStatus={houseError?'error':undefined}><Select showSearch filterOption={false} disabled={!communityId} loading={houseLoading} onSearch={value=>setHouseTerm(value.slice(0,60))} placeholder="搜索并选择房号" options={houseOptions.map(h=>({value:h.id,label:h.label}))} notFoundContent={houseLoading?<Spin size="small" />:houseError?'房号查询失败，请重新输入重试':'未找到房号，试试更完整的门牌或姓名'} /></Form.Item></Col>
     <Col xs={24} sm={12} lg={6}><Form.Item name="feeCode" label="费用项目"><Select allowClear showSearch optionFilterProp="label" placeholder="全部费用项目" options={options.feeItems.map(f=>({value:f.code,label:f.name}))} /></Form.Item></Col>
     <Col xs={24} sm={12} lg={6}><Form.Item name="status" label="账单状态"><Select allowClear placeholder="全部状态" options={Object.entries(statusLabels).map(([value,label])=>({value,label}))} /></Form.Item></Col>
     <Col xs={24} sm={12} lg={6}><Form.Item name="period" label="账期" rules={[{validator:(_,v)=>v?.[0]&&v?.[1]&&v[0].isAfter(v[1])?Promise.reject(new Error('开始账期不能晚于结束账期')):Promise.resolve()}]}><DatePicker.RangePicker picker="month" style={{width:'100%'}} /></Form.Item></Col>
     <Col xs={24} sm={12} lg={6}><Form.Item name="paid" label="实际收款日期" rules={[{validator:(_,v)=>v?.[0]&&v?.[1]&&v[0].isAfter(v[1])?Promise.reject(new Error('开始日期不能晚于结束日期')):Promise.resolve()}]}><DatePicker.RangePicker style={{width:'100%'}} /></Form.Item></Col>
     <Col span={24}><Form.Item><Space wrap><Button type="primary" htmlType="submit" icon={<SearchOutlined />} loading={loading}>查询该户</Button><Button icon={<ReloadOutlined />} disabled={loading||!filters?.houseId} onClick={()=>setRefresh(x=>x+1)}>刷新结果</Button><Button disabled={loading} onClick={()=>{form.setFieldValue('period',null);setResult(null);setFilters(null);}}>不限账期</Button></Space></Form.Item></Col>
    </Row>
   </Form>
   <Typography.Text type="secondary">账期表示费用所属月份，实际收款日期表示收到款项的日期；预缴下一年的费用会出现在未来账期。</Typography.Text>
  </Card>
  {error&&<Alert type="error" showIcon message={error} action={<Button onClick={()=>setRefresh(x=>x+1)} disabled={loading}>重试查询</Button>} />}
  {result&&<>
   <Descriptions size="small" column={{xs:1,sm:2,lg:4}} items={[
    {key:'receivable',label:'有效应缴',children:money(result.summary.receivableCents)},
    {key:'paid',label:'已缴（未退款）',children:money(result.summary.paidCents)},
    {key:'unpaid',label:'未缴金额',children:money(result.summary.unpaidCents)},
    {key:'total',label:'符合条件明细',children:`${result.total.toLocaleString()} 笔`},
   ]} />
   <Typography.Text type="secondary">以上为全部筛选结果汇总，非当前页合计。核对欠费时请将结束账期设为本月，未来账期未缴不代表逾期。有效应缴不含退款和负数调整；退款记录 {result.summary.refundedCount} 笔保留在明细中，金额汇总不作为财务净收入报表。查询时间：{dayjs(result.queriedAt).format('YYYY-MM-DD HH:mm:ss')}；明细最近更新：{result.summary.latestUpdatedAt||'未提供'}。</Typography.Text>
  </>}
  <Table<MisRow> size="small" rowKey="id" loading={loading} dataSource={result?.rows||[]} scroll={{x:1550}} locale={{emptyText:<Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={error?'查询失败，修正后重试':!filters?.houseId?'先选择小区和房号，再查询该户账单':'当前筛选条件下没有账单'} />}}
   columns={[
    {title:'小区 / 房号',key:'address',width:270,fixed:'left',render:(_,r)=><><div>{r.communityName}</div><Typography.Text>{r.address}</Typography.Text></>},
    {title:'住户',dataIndex:'ownerName',width:100},
    {title:'费用项目',key:'fee',width:110,render:(_,r)=>r.feeName||r.feeCode},
    {title:'账期',dataIndex:'period',width:90,render:v=>formatFeePeriod(v)},
    {title:'金额',dataIndex:'amountCents',width:120,align:'right',render:money},
    {title:'状态',dataIndex:'status',width:110,render:(v:MisRow['status'])=><Tag color={{paid:'green',unpaid:'orange',refunded:'red',adjustment:'default'}[v]}>{statusLabels[v]}</Tag>},
    {title:'收款日期',dataIndex:'paidAt',width:110},
    {title:'退款日期',dataIndex:'refundedAt',width:110},
    {title:'收款方式',dataIndex:'paymentMethod',width:110},
    {title:'单据号',dataIndex:'documentNo',width:140},
    {title:'收款凭证号',dataIndex:'receiptNo',width:140},
   ]}
   expandable={{expandedRowRender:r=><Descriptions size="small" column={{xs:1,sm:2}} items={[{key:'cashier',label:'收费员',children:r.cashier||'未提供'},{key:'invoice',label:'发票号',children:r.invoiceNo||'未提供'},{key:'remark',label:'备注',children:r.remark||'无'},{key:'updated',label:'最近更新',children:r.updatedAt||'未提供'}]} />}}
   pagination={{current:page,pageSize,total:result?.total||0,showSizeChanger:true,pageSizeOptions:[20,50,100],showTotal:total=>`共 ${total} 笔`,onChange:(p,size)=>{setPage(size===pageSize?p:1);setPageSize(size);}}}
  />
 </Space>;
}
