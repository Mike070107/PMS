import { useEffect, useMemo, useState } from 'react';
import { App, Alert, Breadcrumb, Button, Form, Input, InputNumber, Modal, Select, Space, Table, Tabs, Tag } from 'antd';
import { request } from '@pms/api-client';
import MigratedSurface from '@/components/MigratedSurface';
import { useSession } from '@/lib/auth';
import { can } from '@/lib/perm';
import ToneIcon from '@/components/ToneIcon';

type Level = 'offices' | 'communities' | 'buildings' | 'houses' | 'owners';
type Row = { id: number; name?: string; officeId?: number | null; parentId?: number | null; isGroup?: boolean;
  communityType?: string; communityId?: number; buildingType?: string; buildingNo?: string; lane?: string;
  roomNo?: string; areaSqm?: number | string | null; owners?: Array<{ name: string }>; phone?: string; contactNote?: string;
  status?: string; archivedAt?: string | null; enabled?: boolean; address?: string; remark?: string;
  contactPhones?: string[]; properties?: Array<{ community_name: string; building_no: string; room_no?: string }>;
  phoneActivity?: Array<{ phone: string; status: string; last_contacted_at?: string; last_used_at?: string; last_attempted_at?: string }> };
const labels: Record<Level, string> = { offices: '管理处', communities: '小区 / 公寓', buildings: '楼栋 / 商铺', houses: '房号', owners: '业主' };
const urls: Record<Level, string> = { offices: '/offices', communities: '/communities', buildings: '/buildings', houses: '/houses', owners: '/owners-mgmt' };

export default function PropertyArchive() {
  return <MigratedSurface pageKey="properties"><ArchiveWorkspace /></MigratedSurface>;
}

function ArchiveWorkspace() {
  const { message, modal } = App.useApp();
  const session = useSession();
  const scope = JSON.stringify([session.user?.id, session.actingTenant?.id, session.actingOffice?.id, session.access]);
  const [level, setLevel] = useState<Level>('offices');
  const [offices, setOffices] = useState<Row[]>([]);
  const [communities, setCommunities] = useState<Row[]>([]);
  const [buildings, setBuildings] = useState<Row[]>([]);
  const [officeId, setOfficeId] = useState<number>();
  const [communityId, setCommunityId] = useState<number>();
  const [buildingId, setBuildingId] = useState<number>();
  const [house, setHouse] = useState<Row>();
  const [rows, setRows] = useState<Row[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [version, setVersion] = useState(0);
  const [editor, setEditor] = useState<{ kind: Level; row?: Row }>();
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [archived, setArchived] = useState(false);
  const [form] = Form.useForm();
  const [linkOpen, setLinkOpen] = useState(false);
  const [ownerOptions, setOwnerOptions] = useState<Row[]>([]);
  const [ownerSearch, setOwnerSearch] = useState('');
  const [selectedOwnerId, setSelectedOwnerId] = useState<number>();
  const [linkLoading, setLinkLoading] = useState(false);
  const [phoneBusy, setPhoneBusy] = useState(false);
  const building = buildings.find(r => r.id === buildingId);
  const shop = building?.buildingType === 'shop';
  const permission = level === 'offices' ? 'offices' : 'properties';
  const canEdit = can(permission, 'edit');
  const canDelete = can(permission, 'delete');
  const officeOf = (c: Row): number | null | undefined => c.officeId ?? communities.find(p => p.id === c.parentId)?.officeId;
  const visibleCommunities = useMemo(() => communities.filter(c => !officeId || officeOf(c) === officeId), [communities, officeId]);

  useEffect(() => {
    let current = true;
    const officeUrl = can('offices', 'view') ? '/offices' : '/communities/offices';
    Promise.all([request<Row[] | { offices: Row[] }>({ url: officeUrl }), request<Row[]>({ url: '/communities', query: { includeGroups: true } })])
      .then(([o, c]) => { if (current) { setOffices(Array.isArray(o) ? o : o.offices); setCommunities(c); } })
      .catch(e => { if (current) setError(e.message || '档案目录加载失败'); });
    return () => { current = false; };
  }, [scope, version]);
  useEffect(() => { setOfficeId(undefined); setCommunityId(undefined); setBuildingId(undefined); setHouse(undefined); }, [scope]);
  useEffect(() => {
    let current = true;
    setBuildings([]);
    if (communityId) request<Row[]>({ url: '/buildings', query: { communityId } }).then(r => { if (current) setBuildings(r); }).catch(e => { if (current) setError(e.message); });
    return () => { current = false; };
  }, [communityId, scope, version]);

  // Changes to a parent reset its children; ordinary refresh retains selection.
  const selectOffice = (id?: number) => { setOfficeId(id); setCommunityId(undefined); setBuildingId(undefined); setHouse(undefined); setPage(1); };
  const selectCommunity = (id?: number) => { setCommunityId(id); setBuildingId(undefined); setHouse(undefined); setPage(1); };
  const selectBuilding = (id?: number) => { setBuildingId(id); setHouse(undefined); setPage(1); };
  const eligible = level === 'offices' || level === 'communities' || level === 'buildings' && !!communityId || level === 'houses' && !!buildingId && !shop || level === 'owners' && (!!house || shop);
  useEffect(() => {
    let current = true;
    setError(''); setRows([]); setTotal(0);
    if (!eligible) return;
    if (level === 'offices') { setRows(offices); setTotal(offices.length); return; }
    if (level === 'communities') { setRows(visibleCommunities); setTotal(visibleCommunities.length); return; }
    if (level === 'buildings') { setRows(buildings); setTotal(buildings.length); return; }
    setLoading(true);
    const query = level === 'houses' ? { buildingId, page, pageSize: 30, archived: archived ? '1' : undefined }
      : { houseId: house?.id, buildingId: shop ? buildingId : undefined, status: archived ? 'disabled' : 'active' };
    request<Row[] | { rows: Row[]; total: number }>({ url: urls[level], query })
      .then(r => { if (current) { setRows(Array.isArray(r) ? r : r.rows); setTotal(Array.isArray(r) ? r.length : r.total); } })
      .catch(e => { if (current) setError(e.message || '加载档案失败'); })
      .finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [level, offices, visibleCommunities, buildings, buildingId, house?.id, eligible, archived, page, scope, version]);

  const refresh = () => setVersion(v => v + 1);
  const enter = (row: Row) => {
    setArchived(false); setPage(1);
    if (level === 'offices') { selectOffice(row.id); setLevel('communities'); }
    if (level === 'communities') { selectCommunity(row.id); setLevel('buildings'); }
    if (level === 'buildings') { selectBuilding(row.id); setLevel(row.buildingType === 'shop' ? 'owners' : 'houses'); }
    if (level === 'houses') { setHouse(row); setLevel('owners'); }
  };
  const edit = (row?: Row) => {
    setSaveError(''); setEditor({ kind: level, row });
    form.resetFields();
    form.setFieldsValue({ communityType: 'community', buildingType: 'residential', officeId, ...row, contactPhones: (row?.contactPhones || []).filter(p => p !== row?.phone) });
  };
  const save = async () => {
    if (!editor) return;
    let values;
    try { values = await form.validateFields(); }
    catch (e: any) { const name = e.errorFields?.[0]?.name; if (name) { form.scrollToField(name); document.getElementById(`archive_${name.join('_')}`)?.focus(); } return; }
    setSaving(true); setSaveError('');
    const kind = editor.kind;
    const data = kind === 'communities' ? { ...values, officeId: values.officeId ?? null }
      : kind === 'buildings' ? { ...values, communityId }
      : kind === 'houses' ? { ...values, buildingId, ...(editor.row ? {} : { propertyType: '住宅' }), areaSqm: values.areaSqm == null ? null : String(values.areaSqm) }
      : kind === 'owners' ? { ...values, ...(editor.row ? {} : { houseId: shop ? undefined : house?.id, ownerBuildingId: shop ? buildingId : undefined }) }
      : values;
    try {
      await request({ url: `${urls[kind]}${editor.row ? '/' + editor.row.id : ''}`, method: editor.row ? 'PATCH' : 'POST', data });
      message.success('档案已保存'); setEditor(undefined); refresh();
    } catch (e: any) { setSaveError(e.message || '保存失败，已保留填写内容'); }
    finally { setSaving(false); }
  };
  const remove = (row: Row) => modal.confirm({
    title: `${level === 'owners' ? '解除当前房产与业主的关联' : level === 'houses' ? '归档' : '删除'}${row.name || row.buildingNo || row.roomNo}？`,
    content: level === 'owners' ? '只解除当前房号或商铺的关联，保留业主档案、联系电话及其他房产关联。' : level === 'houses' ? '保留历史记录，可在已归档列表恢复。' : '有关联子档案时系统会阻止删除，请先核对关联。',
    okText: '确认', cancelText: '取消', okButtonProps: { danger: true },
    onOk: async () => { try { await request({ url: `${urls[level]}/${row.id}${level === 'owners' ? '/properties' : ''}`, method: 'DELETE', query: level === 'owners' ? { houseId: house?.id, ownerBuildingId: shop ? buildingId : undefined } : undefined }); refresh(); message.success('操作成功'); } catch (e: any) { message.error(e.message); throw e; } },
  });
  const restore = async (row: Row) => {
    try { await request({ url: `${urls[level]}/${row.id}${level === 'houses' ? '/restore' : ''}`, method: level === 'houses' ? 'POST' : 'PATCH', data: level === 'owners' ? { status: 'active' } : {} }); refresh(); message.success('已恢复'); }
    catch (e: any) { message.error(e.message); }
  };
  const searchOwners = async () => {
    setLinkLoading(true); setSaveError('');
    try { setOwnerOptions(await request<Row[]>({ url: '/owners-mgmt', query: { q: ownerSearch.trim() || undefined, status: 'active' } })); }
    catch (e: any) { setSaveError(e.message); }
    finally { setLinkLoading(false); }
  };
  const linkOwner = async () => {
    if (!selectedOwnerId) { setSaveError('请选择要关联的已有业主'); return; }
    setLinkLoading(true); setSaveError('');
    try { await request({ url: `/owners-mgmt/${selectedOwnerId}/properties`, method: 'POST', data: { houseId: shop ? undefined : house?.id, ownerBuildingId: shop ? buildingId : undefined } }); setLinkOpen(false); refresh(); message.success('已关联，原有房产关联保留'); }
    catch (e: any) { setSaveError(e.message); }
    finally { setLinkLoading(false); }
  };
  const recordContact = async (row: Row, phone: string, result: string) => {
    setPhoneBusy(true);
    try { await request({ url: `/owners-mgmt/${row.id}/contact-events`, method: 'POST', data: { phone, result } }); refresh(); message.success('联系结果已记录'); }
    catch (e: any) { message.error(e.message || '记录失败'); }
    finally { setPhoneBusy(false); }
  };
  const phoneStatus: Record<string, string> = { connected: '已联系成功', no_answer: '未接通', invalid: '空号 / 无效', inactive: '停用', unknown: '未验证' };
  const time = (value?: string) => value ? new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) : '暂无记录';
  const columns: any[] = [
    { title: labels[level], key: 'name', width: 180, ellipsis: true, render: (_: unknown, r: Row) => level === 'owners' ? r.name : <Button type="link" title={r.name || r.buildingNo || r.roomNo} style={{ maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis' }} onClick={() => enter(r)}>{r.name || `${r.lane ? r.lane + '弄' : ''}${r.buildingNo || r.roomNo}`}</Button> },
    ...(level === 'communities' ? [{ title: '分类', render: (_: unknown, r: Row) => <Tag>{r.communityType === 'apartment' ? '公寓' : '小区'}{r.isGroup ? ' · 分组' : ''}</Tag> }, { title: '管理处', render: (_: unknown, r: Row) => offices.find(o => o.id === officeOf(r))?.name || '未划分' }] : []),
    ...(level === 'buildings' ? [{ title: '分类', render: (_: unknown, r: Row) => <Tag>{r.buildingType === 'shop' ? '商铺' : '住宅楼'}</Tag> }] : []),
    ...(level === 'houses' ? [{ title: '面积（㎡）', dataIndex: 'areaSqm' }, { title: '业主', render: (_: unknown, r: Row) => (r.owners || []).map(o => o.name).join('、') || '未登记' }] : []),
    ...(level === 'owners' ? [{ title: '关联房产', width: 240, render: (_: unknown, r: Row) => <Space direction="vertical">{(r.properties || []).map((p, i) => <span key={i}>{p.community_name} · {p.building_no}{p.room_no ? '/' + p.room_no : '（商铺）'}</span>)}</Space> }, { title: '联系电话与最近联系', width: 400, render: (_: unknown, r: Row) => <Space direction="vertical" style={{ width: '100%' }}>{Array.from(new Set([r.phone, ...(r.contactPhones || [])].filter((p): p is string => !!p))).map(p => {
      const a = r.phoneActivity?.find(a => a.phone === p);
      return <div key={p} style={{ whiteSpace: 'normal', lineHeight: 1.7 }}><b>{p}</b> <Tag>{phoneStatus[a?.status || 'unknown']}</Tag>
        <div>最后联系成功：{time(a?.last_contacted_at)}</div><div style={{ color: 'var(--ink2)' }}>最近业务使用：{time(a?.last_used_at)}</div>
        {canEdit && <Select<string | null> aria-label={`记录${p}联系结果`} value={null} placeholder="记录联系结果" disabled={phoneBusy} style={{ minWidth: 160 }} onChange={result => { if (result) void recordContact(r, p, result); }} options={Object.entries(phoneStatus).filter(([v]) => v !== 'unknown').map(([value, label]) => ({ value, label }))} />}
      </div>;
    })}</Space> }, { title: '其他联系方式 / 备注', dataIndex: 'contactNote' }] : []),
    { title: '操作', width: 210, render: (_: unknown, r: Row) => <Space wrap>
      {level !== 'owners' && <Button onClick={() => enter(r)}>{level === 'buildings' && r.buildingType === 'shop' || level === 'houses' ? '管理业主' : '查看下级'}</Button>}
      {canEdit && <Button onClick={() => edit(r)}>编辑</Button>}
      {archived && canEdit ? <Button onClick={() => void restore(r)}>恢复</Button> : canDelete && <Button danger onClick={() => remove(r)}>{level === 'owners' ? '解除关联' : level === 'houses' ? '归档' : '删除'}</Button>}
    </Space> },
  ];
  const required = (label: string) => [{ required: true, whitespace: true, message: `请填写${label}` }];
  return <>
    <div className="ph"><div><div className="h1row"><ToneIcon kind="houses" /><h1>房产档案</h1></div><p>管理处 → 小区 / 公寓 → 住宅楼 → 房号 → 业主；商铺直接管理业主</p></div></div>
    <Tabs activeKey={level} onChange={k => { setLevel(k as Level); setPage(1); setArchived(false); }} items={(Object.keys(labels) as Level[]).map(k => ({ key: k, label: labels[k] }))} />
    <Space wrap style={{ marginBottom: 16 }}>
      <Select aria-label="管理处筛选" placeholder="全部管理处" allowClear value={officeId} onChange={selectOffice} style={{ minWidth: 180 }} options={offices.map(r => ({ label: r.name, value: r.id }))} />
      <Select aria-label="小区筛选" placeholder="选择小区 / 公寓" allowClear value={communityId} onChange={selectCommunity} style={{ minWidth: 200 }} options={visibleCommunities.map(r => ({ label: r.name, value: r.id }))} />
      <Select aria-label="楼栋筛选" placeholder="选择楼栋 / 商铺" allowClear value={buildingId} onChange={id => { selectBuilding(id); if (buildings.find(r => r.id === id)?.buildingType === 'shop') setLevel('owners'); }} style={{ minWidth: 180 }} options={buildings.map(r => ({ label: `${r.lane ? r.lane + '弄' : ''}${r.buildingNo}${r.buildingType === 'shop' ? ' · 商铺' : ''}`, value: r.id }))} />
      <Button onClick={refresh}>刷新</Button>
      {canEdit && eligible && <Button type="primary" onClick={() => edit()}>新增{labels[level]}</Button>}
      {level === 'owners' && eligible && canEdit && <Button onClick={() => { setLinkOpen(true); setOwnerOptions([]); setSelectedOwnerId(undefined); setOwnerSearch(''); setSaveError(''); }}>关联已有业主</Button>}
    </Space>
    <Breadcrumb style={{ marginBottom: 16 }} items={[{ title: offices.find(o => o.id === officeId)?.name || '全部管理处' }, ...(communityId ? [{ title: communities.find(c => c.id === communityId)?.name }] : []), ...(buildingId ? [{ title: building?.buildingNo }] : []), ...(house ? [{ title: house.roomNo }] : [])]} />
    {error && <Alert type="error" showIcon message={error} action={<Button onClick={refresh}>重试</Button>} style={{ marginBottom: 16 }} />}
    {(level === 'houses' || level === 'owners') && <Tabs activeKey={archived ? 'archived' : 'active'} onChange={k => { setArchived(k === 'archived'); setPage(1); }} items={[{ key: 'active', label: '在册' }, { key: 'archived', label: '已归档' }]} />}
    {level === 'owners' && <Alert type="info" showIcon style={{ marginBottom: 16 }} message="一个业主可关联多处房产，多处共用同一份资料。电话的业务使用不代表已接通，请按实际结果登记；较久未联系的号码建议先核实。" />}
    {!eligible ? <Alert type="info" showIcon message={level === 'buildings' ? '请先选择小区或公寓，再管理下属楼栋。' : level === 'houses' && shop ? '商铺不设房号，请在业主页签管理该商铺业主。' : level === 'houses' ? '请先选择住宅楼，再管理房号。' : '请先从房号列表点击“管理业主”，或选择商铺。'} /> :
      <Table rowKey="id" columns={columns.map(column => ({ ...column, onCell: () => ({ style: { verticalAlign: 'top' } }) }))} dataSource={rows} loading={loading} scroll={{ x: level === 'owners' ? 1250 : 760 }} locale={{ emptyText: error ? '加载未成功，请重试' : '暂无档案' }} pagination={level === 'houses' ? { current: page, pageSize: 30, total, showSizeChanger: false, onChange: setPage } : { pageSize: 30, showSizeChanger: false }} />}
    <Modal open={!!editor} title={`${editor?.row ? '编辑' : '新增'}${editor ? labels[editor.kind] : ''}`} onCancel={() => { if (!saving) setEditor(undefined); }} onOk={() => void save()} confirmLoading={saving} cancelButtonProps={{ disabled: saving }} okText="保存" cancelText="取消" destroyOnClose>
      <Form form={form} name="archive" layout="vertical" preserve={false}>
        {(editor?.kind === 'offices' || editor?.kind === 'communities' || editor?.kind === 'owners') && <Form.Item name="name" label="名称" rules={required('名称')}><Input maxLength={editor?.kind === 'owners' ? 60 : 120} /></Form.Item>}
        {editor?.kind === 'offices' && <Form.Item name="remark" label="备注"><Input.TextArea maxLength={255} /></Form.Item>}
        {editor?.kind === 'communities' && <>
          <Form.Item name="communityType" label="分类" rules={[{ required: true, message: '请选择小区或公寓' }]}><Select options={[{ value: 'community', label: '小区' }, { value: 'apartment', label: '公寓' }]} /></Form.Item>
          <Form.Item name="officeId" label="所属管理处"><Select allowClear options={offices.map(o => ({ value: o.id, label: o.name }))} /></Form.Item>
          <Form.Item name="address" label="地址"><Input maxLength={255} /></Form.Item>
        </>}
        {editor?.kind === 'buildings' && <>
          <Form.Item name="buildingNo" label="楼栋 / 商铺名称" rules={required('楼栋或商铺名称')}><Input maxLength={30} /></Form.Item>
          <Form.Item name="buildingType" label="分类" rules={[{ required: true, message: '请选择住宅楼或商铺' }]}><Select options={[{ value: 'residential', label: '住宅楼' }, { value: 'shop', label: '商铺' }]} /></Form.Item>
          <Form.Item name="lane" label="弄号"><Input maxLength={30} /></Form.Item>
        </>}
        {editor?.kind === 'houses' && <>
          <Form.Item name="roomNo" label="房号" rules={required('房号')}><Input maxLength={30} /></Form.Item>
          <Form.Item name="areaSqm" label="面积（㎡）"><InputNumber min={0} max={99999.99} precision={2} style={{ width: '100%' }} /></Form.Item>
        </>}
        {editor?.kind === 'owners' && <>
          <Form.Item name="phone" label="主要联系电话" rules={[...required('主要联系电话'), { pattern: /^[+\d][\d\s()+-]{4,29}$/, message: '请输入有效手机号或固定电话' }]}><Input maxLength={30} /></Form.Item>
          <Form.List name="contactPhones">{(fields, { add, remove }) => <>
            {fields.map(({ key, name, ...rest }) => <Space key={key} align="baseline"><Form.Item {...rest} name={name} label={`其他电话 ${name + 1}`} rules={[...required('联系电话'), { pattern: /^[+\d][\d\s()+-]{4,29}$/, message: '电话格式不正确' }]}><Input maxLength={30} /></Form.Item><Button danger onClick={() => remove(name)}>删除此电话</Button></Space>)}
            {fields.length < 9 && <Button onClick={() => add()}>添加联系电话</Button>}
          </>}</Form.List>
          <Form.Item name="contactNote" label="其他联系方式 / 备注"><Input.TextArea maxLength={255} /></Form.Item>
        </>}
      </Form>
      {saveError && <Alert type="error" showIcon message={saveError} />}
    </Modal>
    <Modal open={linkOpen} title="关联已有业主" onCancel={() => { if (!linkLoading) setLinkOpen(false); }} onOk={() => void linkOwner()} confirmLoading={linkLoading} okText="关联" cancelText="取消">
      <p>搜索已有业主并关联当前房产，无需重复建立业主档案。</p>
      <Input.Search aria-label="搜索已有业主" placeholder="输入姓名或任一电话" value={ownerSearch} onChange={e => setOwnerSearch(e.target.value)} onSearch={() => void searchOwners()} loading={linkLoading} enterButton="搜索" />
      <Select aria-label="选择已有业主" placeholder="选择搜索结果" value={selectedOwnerId} onChange={setSelectedOwnerId} style={{ width: '100%', marginTop: 16 }} options={ownerOptions.map(r => ({ value: r.id, label: `${r.name || '未命名'} · ${r.phone || '未登记电话'}` }))} />
      {saveError && <Alert type="error" message={saveError} style={{ marginTop: 16 }} />}
    </Modal>
  </>;
}
