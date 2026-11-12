import { useEffect, useRef, useState } from 'react';
import { App, Alert, Button, Form, Input, InputNumber, Modal, Select, Space, Table, Tag } from 'antd';
import { useSearchParams } from 'react-router-dom';
import { request } from '@pms/api-client';
import MigratedSurface from '@/components/MigratedSurface';
import { useSession } from '@/lib/auth';
import { can } from '@/lib/perm';
import ToneIcon from '@/components/ToneIcon';
import './property-archive.css';

type Level = 'offices' | 'communities' | 'buildings' | 'houses' | 'owners';
type Link = { house_id?: number; building_id?: number; community_name: string; building_no: string; room_no?: string; move_in_date?: string; billing_start_date?: string };
type Row = { id: number; name?: string; officeId?: number | null; parentId?: number | null; isGroup?: boolean;
  communityType?: string; communityId?: number; buildingId?: number; buildingType?: string; buildingNo?: string; lane?: string;
  roomNo?: string; areaSqm?: number | string | null; floor?: string; propertyNature?: string; roomLayout?: string;
  owners?: Array<{ id: number; name: string }>; phone?: string; contactNote?: string; status?: string; archivedAt?: string | null;
  enabled?: boolean; address?: string; remark?: string; contactPhones?: string[]; properties?: Link[]; houseCount?: number; ownerCount?: number };
const labels: Record<Level, string> = { offices: '管理处', communities: '小区 / 公寓', buildings: '楼栋 / 商铺', houses: '房号', owners: '业主' };
const urls: Record<Level, string> = { offices: '/offices', communities: '/communities', buildings: '/buildings', houses: '/houses', owners: '/owners-mgmt' };
const buildingLabel = (r?: Row) => !r ? '' : r.buildingType === 'shop' ? r.buildingNo : `${(r.buildingNo || '').replace(/(?:号楼|号|栋)$/, '')}号`;
const roomLabel = (r?: Row) => r?.roomNo?.replace(/室$/, '') || '';
const required = (label: string) => [{ required: true, whitespace: true, message: `请填写${label}` }];
const phonesOf = (r: Row) => [...new Set([r.phone, ...(r.contactPhones || [])].filter((p): p is string => !!p))];
const dateOnly = (s?: string) => s?.slice(0, 10) || '';
const filterStorageKey = (scope: string) => `pms:property-archive:filters:${scope}`;
const readNavigationFilters = (scope: string): Map<string, Record<string, string>> => {
  try {
    const saved: unknown = JSON.parse(sessionStorage.getItem(filterStorageKey(scope)) || '[]');
    if (!Array.isArray(saved)) return new Map();
    return new Map(saved.slice(-40).filter(entry => Array.isArray(entry) && typeof entry[0] === 'string' && /^(offices|communities|buildings|houses|owners)\/(\d*)\/(\d*)\/(\d*)\/(\d*)$/.test(entry[0]) && entry[1] && typeof entry[1] === 'object')
      .map(([key, value]) => [key, Object.fromEntries(['q','type','page','archived'].filter(k => typeof value[k] === 'string').map(k => [k, value[k].slice(0,60)]))]));
  } catch { return new Map(); }
};

export default function PropertyArchive() {
  return <MigratedSurface pageKey="properties"><ArchiveWorkspace /></MigratedSurface>;
}

function ArchiveWorkspace() {
  const { message, modal } = App.useApp();
  const session = useSession();
  const scope = JSON.stringify([session.user?.id, session.actingTenant?.id, session.actingOffice?.id, session.access]);
  const [params, setParams] = useSearchParams();
  const level: Level = Object.prototype.hasOwnProperty.call(labels, params.get('level') || '') ? params.get('level') as Level : 'offices';
  const idOf = (key: string) => { const n = Number(params.get(key)); return Number.isSafeInteger(n) && n > 0 ? n : undefined; };
  const officeId = idOf('office'), communityId = idOf('community'), buildingId = idOf('building'), houseId = idOf('house');
  const q = params.get('q') || '', type = params.get('type') || '', page = idOf('page') || 1, archived = params.get('archived') === '1';
  const houseArchived = params.get('houseArchived') === '1';
  const [initialFilters] = useState(() => readNavigationFilters(scope));
  const filters = useRef(initialFilters);
  const locationKey = (p: URLSearchParams) => ['level','office','community','building','house'].map(k => p.get(k) || '').join('/');
  const go = (next: Record<string, string | number | undefined>) => {
    filters.current.set(locationKey(params), Object.fromEntries(['q','type','page','archived'].map(k => [k, params.get(k) || ''])));
    try { sessionStorage.setItem(filterStorageKey(scope), JSON.stringify([...filters.current].slice(-40))); } catch { /* Navigation still works when browser storage is unavailable. */ }
    const p = new URLSearchParams();
    Object.entries(next).forEach(([k,v]) => { if (v !== undefined) p.set(k, String(v)); });
    Object.entries(filters.current.get(locationKey(p)) || {}).forEach(([k,v]) => { if (v) p.set(k,v); });
    setParams(p);
  };
  const filter = (values: Record<string, string | number | undefined>) => {
    const p = new URLSearchParams(params); p.delete('page');
    Object.entries(values).forEach(([k,v]) => v ? p.set(k,String(v)) : p.delete(k)); setParams(p, { replace: true });
  };
  const [offices, setOffices] = useState<Row[]>([]), [communities, setCommunities] = useState<Row[]>([]), [buildings, setBuildings] = useState<Row[]>([]);
  const [house, setHouse] = useState<Row>(), [rows, setRows] = useState<Row[]>([]), [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true), [directoryLoading, setDirectoryLoading] = useState(true);
  const [error, setError] = useState(''), [directoryError, setDirectoryError] = useState(''), [version, setVersion] = useState(0);
  const [editor, setEditor] = useState<{ kind: Level; row?: Row }>(), [detail, setDetail] = useState<Row>();
  const [saving, setSaving] = useState(false), [saveError, setSaveError] = useState('');
  const [form] = Form.useForm();
  const [linkOpen, setLinkOpen] = useState(false), [ownerOptions, setOwnerOptions] = useState<Row[]>([]);
  const [ownerSearch, setOwnerSearch] = useState(''), [selectedOwnerId, setSelectedOwnerId] = useState<number>(), [linkLoading, setLinkLoading] = useState(false);
  const [targetBuildings, setTargetBuildings] = useState<Row[]>([]), [targetHouses, setTargetHouses] = useState<Row[]>([]);
  const [targetBuildingsLoading, setTargetBuildingsLoading] = useState(false), [targetHousesLoading, setTargetHousesLoading] = useState(false);
  const [targetBuildingsError, setTargetBuildingsError] = useState(''), [targetHousesError, setTargetHousesError] = useState('');
  const targetLoading = targetBuildingsLoading || targetHousesLoading, targetError = targetBuildingsError || targetHousesError;
  const [targetVersion, setTargetVersion] = useState(0);
  const targetCommunityId = Form.useWatch('targetCommunityId', form), targetBuildingId = Form.useWatch('targetBuildingId', form);
  const building = buildings.find(r => r.id === buildingId && r.communityId === communityId), community = communities.find(r => r.id === communityId && !r.isGroup);
  const shop = building?.buildingType === 'shop';
  const currentLink = (r?: Row) => r?.properties?.find(p => shop ? p.building_id === buildingId : p.house_id === houseId);
  const ownerDates = (r: Row) => { const p = currentLink(r); return <div>入住：{dateOnly(p?.move_in_date) || '未登记'}<br />起费：{dateOnly(p?.billing_start_date) || '未登记'}</div>; };
  const propertyLinks = (r: Row) => <details className="pa-properties"><summary>{r.properties?.length || 0} 处关联房产</summary>{r.properties?.map((p,i) => <p key={i}>{p.community_name} · {p.room_no ? buildingLabel({id:0,buildingNo:p.building_no}) : p.building_no}{p.room_no ? ` · ${roomLabel({id:0,roomNo:p.room_no})}` : ''}</p>)}</details>;
  const canEdit = can(level === 'offices' ? 'offices' : 'properties', 'edit');
  const canDelete = can(level === 'offices' ? 'offices' : 'properties', 'delete');
  const officeOf = (c: Row): number | null | undefined => c.officeId ?? communities.find(p => p.id === c.parentId)?.officeId;
  const leafCommunities = communities.filter(c => !c.isGroup);
  const visibleCommunities = leafCommunities.filter(c => !officeId || officeOf(c) === officeId);
  const unassigned = leafCommunities.filter(c => !officeOf(c));
  const eligible = level === 'offices' || level === 'communities' || level === 'buildings' && !!community || level === 'houses' && !!building && !shop || level === 'owners' && (!!house && house.id === houseId && house.buildingId === buildingId && !!building || shop);
  const refresh = () => setVersion(v => v + 1);
  const scopeRef = useRef(scope);
  useEffect(() => {
    if (scopeRef.current !== scope) { scopeRef.current = scope; filters.current = readNavigationFilters(scope); setParams({}, { replace: true }); setEditor(undefined); setDetail(undefined); setLinkOpen(false); setHouse(undefined); setOffices([]); setCommunities([]); setBuildings([]); setRows([]); setTotal(0); }
  }, [scope, setParams]);
  useEffect(() => {
    let current = true; setDirectoryLoading(true); setDirectoryError('');
    Promise.all([request<Row[] | { offices: Row[] }>({ url: can('offices','view') ? '/offices' : '/communities/offices' }), request<Row[]>({ url: '/communities', query: { includeGroups: true } })])
      .then(([o,c]) => { if (current) { setOffices(Array.isArray(o) ? o : o.offices); setCommunities(c); } })
      .catch(e => { if (current) { setOffices([]); setCommunities([]); setDirectoryError(e.message || '档案目录加载失败'); } })
      .finally(() => { if (current) setDirectoryLoading(false); });
    return () => { current = false; };
  }, [scope, version]);
  useEffect(() => {
    let current = true; setBuildings([]); setError('');
    if (communityId) request<Row[]>({ url: '/buildings', query: { communityId, archiveDetails: '1' } }).then(r => { if (current) setBuildings(r); }).catch(e => { if (current) setError(e.message || '楼栋加载失败'); });
    return () => { current = false; };
  }, [communityId, scope, version]);
  useEffect(() => {
    let current = true; setHouse(undefined);
    if (houseId && building?.id && building.communityId === communityId) request<Row[]>({ url: '/houses', query: { id: houseId, buildingId, archived: houseArchived ? '1' : undefined } })
      .then(r => { if (current) setHouse(r.find(h => h.id === houseId)); }).catch(e => { if (current) setError(e.message || '房产详情加载失败'); });
    return () => { current = false; };
  }, [houseId, buildingId, building?.id, communityId, houseArchived, scope, version]);
  useEffect(() => {
    let current = true; setRows([]); setTotal(0); setLoading(false);
    if (!eligible || directoryLoading) return;
    const match = (r: Row) => !q || [r.name,r.buildingNo,r.roomNo].some(v => v?.toLowerCase().includes(q.toLowerCase()));
    const local = level === 'offices' ? offices : level === 'communities' ? visibleCommunities : level === 'buildings' ? buildings : null;
    if (local) { const result = local.filter(match).filter(r => !type || (level === 'buildings' ? r.buildingType : r.communityType) === type); setRows(result); setTotal(result.length); return; }
    setLoading(true); setError('');
    const query = level === 'houses' ? { buildingId, q: q || undefined, propertyNature: type || undefined, page, pageSize: 10, archived: archived ? '1' : undefined }
      : { houseId: shop ? undefined : houseId, buildingId: shop ? buildingId : undefined, q: q || undefined, status: archived ? 'disabled' : 'active' };
    request<Row[] | { rows: Row[]; total: number }>({ url: urls[level], query })
      .then(r => { if (current) { setRows(Array.isArray(r) ? r : r.rows); setTotal(Array.isArray(r) ? r.length : r.total); } })
      .catch(e => { if (current) setError(e.message || '档案加载失败'); }).finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [level, offices, communities, buildings, officeId, buildingId, houseId, eligible, archived, page, q, type, directoryLoading, scope, version]);
  useEffect(() => {
    let current = true; setTargetBuildings([]); setTargetBuildingsError(''); setTargetBuildingsLoading(false);
    if (editor?.kind === 'owners' && editor.row && targetCommunityId) {
      setTargetBuildingsLoading(true); request<Row[]>({ url: '/buildings', query: { communityId: targetCommunityId } })
        .then(r => { if (current) setTargetBuildings(r); }).catch(e => { if (current) setTargetBuildingsError(e.message || '目标楼栋加载失败'); }).finally(() => { if (current) setTargetBuildingsLoading(false); });
    }
    return () => { current = false; };
  }, [editor, targetCommunityId, scope, targetVersion]);
  useEffect(() => {
    let current = true; setTargetHouses([]); setTargetHousesError(''); setTargetHousesLoading(false);
    const target = targetBuildings.find(b => b.id === targetBuildingId && b.communityId === targetCommunityId);
    if (editor?.kind === 'owners' && editor.row && !targetBuildingsLoading && target && target.buildingType !== 'shop') {
      setTargetHousesLoading(true); request<Row[]>({ url: '/houses', query: { buildingId: target.id } })
        .then(r => { if (current) setTargetHouses(r); }).catch(e => { if (current) setTargetHousesError(e.message || '目标房号加载失败'); }).finally(() => { if (current) setTargetHousesLoading(false); });
    }
    return () => { current = false; };
  }, [editor, targetBuildingId, targetCommunityId, targetBuildings, targetBuildingsLoading, scope, targetVersion]);

  const enterCommunity = (r: Row) => go({ level: 'buildings', office: officeOf(r) || undefined, community: r.id });
  const enter = (r: Row) => {
    if (level === 'offices') go({ level: 'communities', office: r.id });
    if (level === 'communities') enterCommunity(r);
    if (level === 'buildings') go({ level: r.buildingType === 'shop' ? 'owners' : 'houses', office: officeId, community: communityId, building: r.id });
    if (level === 'houses') go({ level: 'owners', office: officeId, community: communityId, building: buildingId, house: r.id, houseArchived: r.archivedAt ? '1' : undefined });
  };
  const edit = (row?: Row, kind = level) => {
    setSaveError(''); setEditor({ kind, row }); form.resetFields();
    const link = currentLink(row);
    form.setFieldsValue({ communityType: 'community', buildingType: 'residential', officeId, ...row,
      communityIds: kind === 'offices' ? communities.filter(c => !c.parentId && officeOf(c) === row?.id).map(c => c.id) : undefined,
      contactPhones: (row?.contactPhones || []).filter(p => p !== row?.phone), targetCommunityId: communityId, targetBuildingId: buildingId, targetHouseId: houseId,
      moveInDate: dateOnly(link?.move_in_date), billingStartDate: dateOnly(link?.billing_start_date) });
  };
  const save = async () => {
    if (!editor || saving || !can(editor.kind === 'offices' ? 'offices' : 'properties', 'edit')) return;
    if (editor.kind === 'owners' && editor.row && (targetLoading || targetError)) { setSaveError(targetError || '目标房产仍在加载，请稍后再保存'); return; }
    let values;
    try { values = await form.validateFields(); } catch (e: any) { const n = e.errorFields?.[0]?.name; if (n) { form.scrollToField(n); document.getElementById(`archive_${n.join('_')}`)?.focus(); } return; }
    const { targetCommunityId: tc, targetBuildingId: tb, targetHouseId: th, ...v } = values;
    const kind = editor.kind;
    const target = targetBuildings.find(b => b.id === tb && b.communityId === tc);
    const targetShop = target?.buildingType === 'shop';
    if (kind === 'owners' && editor.row && (!target || (!targetShop && !targetHouses.some(h => h.id === th && h.buildingId === tb)))) {
      setSaveError('目标房产不可用，请重新选择小区、楼栋和房号'); return;
    }
    setSaving(true); setSaveError('');
    const data = kind === 'communities' ? { ...v, officeId: v.officeId ?? null }
      : kind === 'buildings' ? { ...v, communityId }
      : kind === 'houses' ? { ...v, buildingId, ...(editor.row ? {} : { propertyType: '住宅' }), areaSqm: v.areaSqm == null ? null : String(v.areaSqm), floor: v.floor?.trim() || null, propertyNature: v.propertyNature || null, roomLayout: v.roomLayout?.trim() || null, remark: v.remark?.trim() || null }
      : kind === 'owners' ? { ...v, moveInDate: v.moveInDate || null, billingStartDate: v.billingStartDate || null,
          ...(editor.row ? { currentHouseId: shop ? undefined : houseId, currentOwnerBuildingId: shop ? buildingId : undefined, houseId: targetShop ? null : th, ownerBuildingId: targetShop ? tb : null }
            : { houseId: shop ? undefined : houseId, ownerBuildingId: shop ? buildingId : undefined }) } : v;
    try { await request({ url: `${urls[kind]}${editor.row ? '/' + editor.row.id : ''}`, method: editor.row ? 'PATCH' : 'POST', data }); message.success('档案已保存'); setEditor(undefined); refresh(); }
    catch (e: any) { setSaveError(e.message || '保存失败，已保留填写内容'); } finally { setSaving(false); }
  };
  const remove = (r: Row) => modal.confirm({ title: `${level === 'owners' ? '解除当前房产关联' : level === 'houses' ? '归档房产' : '删除档案'}？`,
    content: level === 'owners' ? '只解除当前关联，保留业主档案、电话、其他房产和历史记录。' : level === 'houses' ? '保留历史记录，可在已归档列表恢复。' : '存在下级档案时不能删除。', okText: '确认', cancelText: '取消', okButtonProps: { danger: true },
    onOk: async () => { try { await request({ url: `${urls[level]}/${r.id}${level === 'owners' ? '/properties' : ''}`, method: 'DELETE', query: level === 'owners' ? { houseId: shop ? undefined : houseId, ownerBuildingId: shop ? buildingId : undefined } : undefined }); refresh(); message.success('操作成功'); } catch (e: any) { message.error(e.message); throw e; } } });
  const restore = async (r: Row) => { try { await request({ url: `${urls[level]}/${r.id}${level === 'houses' ? '/restore' : ''}`, method: level === 'houses' ? 'POST' : 'PATCH', data: level === 'owners' ? { status: 'active' } : {} }); refresh(); message.success('已恢复'); } catch (e: any) { message.error(e.message); } };
  const searchOwners = async () => { setLinkLoading(true); setSaveError(''); try { setOwnerOptions(await request<Row[]>({ url: '/owners-mgmt', query: { q: ownerSearch.trim() || undefined, status: 'active' } })); } catch (e: any) { setSaveError(e.message); } finally { setLinkLoading(false); } };
  const linkOwner = async () => { if (!selectedOwnerId) { setSaveError('请选择要关联的已有业主'); return; } setLinkLoading(true); setSaveError('');
    try { await request({ url: `/owners-mgmt/${selectedOwnerId}/properties`, method: 'POST', data: { houseId: shop ? undefined : houseId, ownerBuildingId: shop ? buildingId : undefined } }); setLinkOpen(false); refresh(); message.success('已关联，其他房产关联保留'); } catch (e: any) { setSaveError(e.message); } finally { setLinkLoading(false); } };
  const actions = (r: Row) => <Space wrap>{level !== 'owners' && <Button onClick={() => enter(r)}>{level === 'houses' || level === 'buildings' && r.buildingType === 'shop' ? '查看业主' : level === 'buildings' ? '查看房号' : '查看下级'}</Button>}
    {level === 'houses' && <Button onClick={() => setDetail(r)}>详情</Button>}{canEdit && <Button onClick={() => edit(r)}>编辑</Button>}
    {archived && canEdit ? <Button onClick={() => void restore(r)}>恢复</Button> : canDelete && <Button danger onClick={() => remove(r)}>{level === 'owners' ? '解除关联' : level === 'houses' ? '归档' : '删除'}</Button>}</Space>;
  const columns: any[] = [
    { title: labels[level], key: 'name', render: (_: unknown,r: Row) => level === 'owners' ? <strong>{r.name || '未登记姓名'}</strong> : <Button className="pa-name" type="link" onClick={() => enter(r)}>{r.name || (level === 'buildings' ? buildingLabel(r) : roomLabel(r))}</Button> },
    ...(level === 'communities' ? [{ title: '分类', render: (_: unknown,r: Row) => <Tag>{r.communityType === 'apartment' ? '公寓' : '小区'}</Tag> }] : []),
    ...(level === 'buildings' ? [{ title: '分类', render: (_: unknown,r: Row) => <Tag>{r.buildingType === 'shop' ? '商铺' : '住宅楼'}</Tag> }, { title: '房号数', render: (_: unknown,r: Row) => r.houseCount ?? '—' }, { title: '绑定业主', render: (_: unknown,r: Row) => r.ownerCount == null ? '—' : `${r.ownerCount} 位` }] : []),
    ...(level === 'houses' ? [{ title: '楼层', render: (_: unknown,r: Row) => r.floor || '未登记' }, { title: '面积（㎡）', render: (_: unknown,r: Row) => r.areaSqm ?? '未登记' }, { title: '房产性质', render: (_: unknown,r: Row) => r.propertyNature || '未登记' }, { title: '绑定业主', render: (_: unknown,r: Row) => `${r.owners?.length || 0} 位` }] : []),
    ...(level === 'owners' ? [{ title: '全部联系电话', render: (_: unknown,r: Row) => <div className="pa-phones">{phonesOf(r).map(p => <div key={p}>{p}</div>)}{!phonesOf(r).length && '未登记'}</div> }, { title: '备注', render: (_: unknown,r: Row) => r.contactNote || '—' }, { title: '当前房产 · 入住 / 起费日期', render: (_: unknown,r: Row) => ownerDates(r) }, { title: '关联房产', render: (_: unknown,r: Row) => propertyLinks(r) }] : []),
    { title: '操作', key: 'actions', render: (_: unknown,r: Row) => actions(r) },
  ];
  const crumbs = [<button key="all" onClick={() => go({ level: 'offices' })}>全部管理处</button>,
    ...(officeId ? [<button key="office" onClick={() => go({ level: 'communities', office: officeId })}>{offices.find(o => o.id === officeId)?.name || '管理处'}</button>] : []),
    ...(communityId ? [<button key="community" onClick={() => go({ level: 'buildings', office: officeId, community: communityId })}>{community?.name || '小区'}</button>] : []),
    ...(buildingId ? [<button key="building" onClick={() => go({ level: shop ? 'owners' : 'houses', office: officeId, community: communityId, building: buildingId })}>{buildingLabel(building) || '楼栋'}</button>] : []),
    ...(houseId ? [<span key="house">{roomLabel(house) || '房号'}</span>] : [])];
  const laneHint = buildings.find(b => b.lane)?.lane?.replace(/弄$/, '') || (/枫桦.*一期/.test(community?.name || '') ? '198' : /枫桦.*二期/.test(community?.name || '') ? '228' : '');
  const typeOptions = level === 'buildings' ? [{ value:'residential',label:'住宅楼' },{ value:'shop',label:'商铺' }] : level === 'houses' ? ['商品房','公房','配套房','其他'].map(value => ({value,label:value})) : [{value:'community',label:'小区'},{value:'apartment',label:'公寓'}];
  const pagedRows = level === 'houses' ? rows : rows.slice((page-1)*10,page*10);
  return <div className="property-archive">
    <div className="ph"><div><div className="h1row"><ToneIcon kind="houses" /><h1>房产档案</h1></div><p>管理处、小区与房产统一管理；点选小区，继续查看下级档案。</p></div>{can('offices','edit') && <Button onClick={() => edit(undefined,'offices')}>新建管理处</Button>}</div>
    {directoryError && <Alert type="error" showIcon message={directoryError} action={<Button onClick={refresh}>重试</Button>} />}
    {!directoryLoading && unassigned.length > 0 && <Alert type="warning" showIcon message={`有 ${unassigned.length} 个小区 / 公寓未划分管理处，可在管理处编辑中划入。`} />}
    <section aria-label="管理处与管辖小区" aria-busy={directoryLoading} className="pa-overview">
      <h2>管理处与管辖小区 <small>{directoryLoading ? '加载中…' : `${offices.length} 个管理处 · ${leafCommunities.length} 个小区 / 公寓`}</small></h2>
      <div className="pa-offices">{offices.map(o => <article key={o.id} className={`pa-office ${officeId === o.id ? 'selected' : ''}`}><header><button onClick={() => go({level:'communities',office:o.id})}>{o.name}</button><Tag>{o.enabled === false ? '停用' : '启用'}</Tag></header>
        <div className="pa-chips">{leafCommunities.filter(c => officeOf(c) === o.id).map(c => <button key={c.id} aria-pressed={communityId === c.id} onClick={() => enterCommunity(c)}>{c.name}</button>)}</div>
        <footer><span>{leafCommunities.filter(c => officeOf(c) === o.id).length} 个小区 / 公寓</span>{can('offices','edit') && <Button type="link" onClick={() => edit(o,'offices')}>管辖小区 / 编辑</Button>}</footer></article>)}</div>
      {unassigned.length > 0 && <div className="pa-unassigned"><span>未划分管理处</span>{unassigned.map(c => <Button key={c.id} onClick={() => enterCommunity(c)}>{c.name}</Button>)}</div>}
      {!directoryLoading && !directoryError && offices.length === 0 && <p>暂无管理处。请先新建管理处，或直接管理未划分的小区。</p>}
    </section>
    <section className="pa-panel" aria-busy={loading || directoryLoading}>
      <header className="pa-panel-heading"><nav aria-label="档案路径">{crumbs.map((c,i) => <span key={i}>{i>0 && <span aria-hidden="true"> / </span>}{c}</span>)}</nav><h2>{level === 'owners' ? `${shop ? buildingLabel(building) : roomLabel(house)} · 绑定业主` : `${community?.name || offices.find(o => o.id === officeId)?.name || '房产档案'} · ${labels[level]}`}</h2></header>
      <div className="pa-steps"><span className={level === 'buildings' ? 'current' : ''}>1 楼栋 / 商铺</span><span aria-hidden="true">›</span><span className={level === 'houses' ? 'current' : ''}>2 房号</span><span aria-hidden="true">›</span><span className={level === 'owners' ? 'current' : ''}>3 绑定业主</span><small>逐级查看，不合并房号与业主</small></div>
      {level === 'owners' && house && <div className="pa-summary"><strong>{roomLabel(house)}</strong><span>楼层 {house.floor || '未登记'}</span><span>面积 {house.areaSqm == null ? '未登记' : `${house.areaSqm} ㎡`}</span><span>{house.propertyNature || '房产性质未登记'}</span><Button onClick={() => setDetail(house)}>房产详情</Button></div>}
      <div className="pa-toolbar"><label>搜索{labels[level]}<Input aria-label={`搜索${labels[level]}`} placeholder={level === 'owners' ? '姓名或任一联系电话' : level === 'houses' ? '房号、业主或电话' : '输入名称'} value={q} maxLength={60} onChange={e => filter({q:e.target.value})} allowClear /></label>
        {level !== 'offices' && level !== 'owners' && <label>档案类型<Select aria-label="档案类型" value={type || undefined} placeholder="全部类型" allowClear onChange={v => filter({type:v})} options={typeOptions} /></label>}
        {(level === 'houses' || level === 'owners') && <label>在册状态<Select aria-label="在册状态" value={archived ? '1' : ''} onChange={v => filter({archived:v})} options={[{value:'',label:'在册'},{value:'1',label:'已归档'}]} /></label>}
        <div className="pa-toolbar-actions"><Button onClick={refresh} loading={loading}>刷新</Button>{canEdit && eligible && <Button type="primary" onClick={() => edit()}>新增{labels[level]}</Button>}{level === 'owners' && eligible && canEdit && <Button onClick={() => {setLinkOpen(true);setOwnerOptions([]);setSelectedOwnerId(undefined);setOwnerSearch('');setSaveError('');}}>关联已有业主</Button>}</div>
        {laneHint && <small>小区地址：{laneHint}弄 · 楼号不重复弄号</small>}
      </div>
      {error && <Alert type="error" showIcon message={error} action={<Button onClick={refresh}>重试</Button>} />}
      {!eligible ? <div className="pa-empty">{directoryLoading || loading ? '档案加载中…' : level === 'owners' ? '当前房产不可用或无查看权限，请从上级重新选择。' : '请先从管理处卡片选择小区 / 公寓。'}</div> : <>
        <div className="pa-desktop"><Table rowKey="id" columns={columns} dataSource={pagedRows} loading={loading || directoryLoading} pagination={false} locale={{emptyText:error ? '加载未成功，请重试' : '暂无档案'}} /></div>
        <div className="pa-mobile">{loading ? <p role="status">档案加载中…</p> : pagedRows.map(r => <article key={r.id}><h3>{r.name || (level === 'buildings' ? buildingLabel(r) : roomLabel(r))}</h3><div className="pa-mobile-meta">{level === 'buildings' ? <><span>{r.buildingType === 'shop' ? '商铺' : '住宅楼'}</span><span>房号 {r.houseCount ?? '—'}</span><span>业主 {r.ownerCount ?? '—'}</span></> : level === 'houses' ? <><span>楼层 {r.floor || '未登记'}</span><span>{r.areaSqm ?? '未登记'} ㎡</span><span>{r.propertyNature || '性质未登记'}</span><span>{r.owners?.length || 0} 位业主</span></> : level === 'owners' ? <><div className="pa-phones">{phonesOf(r).map(p => <div key={p}>{p}</div>)}</div><p>{r.contactNote || '暂无备注'}</p>{ownerDates(r)}{propertyLinks(r)}</> : <span>{r.communityType === 'apartment' ? '公寓' : '小区'}</span>}</div>{actions(r)}</article>)}{!loading && !rows.length && <p className="pa-empty">{error ? '加载未成功，请重试' : '暂无档案'}</p>}</div>
        <footer className="pa-pagination"><span>共 {total} 条 · 每页 10 条</span><div><Button disabled={page<=1 || loading} onClick={() => filter({page:page-1})}>上一页</Button><span>{page} / {Math.max(1,Math.ceil(total/10))}</span><Button disabled={page*10>=total || loading} onClick={() => filter({page:page+1})}>下一页</Button></div></footer>
      </>}
    </section>
    <Modal open={!!editor} title={`${editor?.row ? '编辑' : '新增'}${editor ? labels[editor.kind] : ''}`} onCancel={() => {if(!saving)setEditor(undefined);}} onOk={() => void save()} confirmLoading={saving} okButtonProps={{disabled:editor?.kind === 'owners' && !!editor.row && (targetLoading || !!targetError)}} cancelButtonProps={{disabled:saving}} okText="保存" cancelText="取消" destroyOnClose>
      <Form form={form} name="archive" layout="vertical" preserve={false}>
        {(editor?.kind === 'offices' || editor?.kind === 'communities' || editor?.kind === 'owners') && <Form.Item name="name" label={editor?.kind === 'owners' ? '业主姓名' : '名称'} rules={required('名称')}><Input maxLength={editor?.kind === 'owners' ? 60 : 120} /></Form.Item>}
        {editor?.kind === 'offices' && <><Form.Item name="communityIds" label="管辖小区 / 公寓"><Select mode="multiple" options={communities.filter(c=>!c.parentId).map(c=>({value:c.id,label:c.name}))} /></Form.Item><Form.Item name="remark" label="备注"><Input.TextArea maxLength={255}/></Form.Item></>}
        {editor?.kind === 'communities' && <><Form.Item name="communityType" label="分类" rules={[{required:true,message:'请选择分类'}]}><Select options={[{value:'community',label:'小区'},{value:'apartment',label:'公寓'}]}/></Form.Item><Form.Item name="officeId" label="所属管理处"><Select allowClear options={offices.map(o=>({value:o.id,label:o.name}))}/></Form.Item><Form.Item name="address" label="地址"><Input maxLength={255}/></Form.Item></>}
        {editor?.kind === 'buildings' && <><Form.Item name="buildingNo" label="楼栋 / 商铺名称" rules={required('楼栋或商铺名称')}><Input maxLength={30}/></Form.Item><Form.Item name="buildingType" label="分类" rules={[{required:true,message:'请选择分类'}]}><Select options={[{value:'residential',label:'住宅楼'},{value:'shop',label:'商铺'}]}/></Form.Item><Form.Item name="lane" label="弄号"><Input maxLength={30}/></Form.Item></>}
        {editor?.kind === 'houses' && <><Form.Item name="roomNo" label="房号" rules={required('房号')}><Input maxLength={30}/></Form.Item><Form.Item name="floor" label="楼层"><Input maxLength={30}/></Form.Item><Form.Item name="areaSqm" label="面积（㎡）"><InputNumber min={0} max={99999.99} precision={2} style={{width:'100%'}}/></Form.Item><Form.Item name="propertyNature" label="房产性质"><Select allowClear options={['商品房','公房','配套房','其他'].map(value=>({value,label:value}))}/></Form.Item><Form.Item name="roomLayout" label="房型"><Input maxLength={60}/></Form.Item><Form.Item name="remark" label="房产备注"><Input.TextArea maxLength={500}/></Form.Item></>}
        {editor?.kind === 'owners' && <><Form.Item name="phone" label="主要联系电话" rules={[...required('主要联系电话'),{pattern:/^[+\d][\d\s()+-]{4,29}$/,message:'请输入有效手机号或固定电话'}]}><Input maxLength={30}/></Form.Item>
          <Form.List name="contactPhones">{(fields,{add,remove})=><>{fields.map(({key,name,...rest})=><Space key={key} align="baseline"><Form.Item {...rest} name={name} label={`其他电话 ${name+1}`} rules={[...required('联系电话'),{pattern:/^[+\d][\d\s()+-]{4,29}$/,message:'电话格式不正确'}]}><Input maxLength={30}/></Form.Item><Button danger onClick={()=>remove(name)}>删除此电话</Button></Space>)}{fields.length<9 && <Button onClick={()=>add()}>添加联系电话</Button>}</>}</Form.List>
          <Form.Item name="contactNote" label="备注"><Input.TextArea maxLength={255}/></Form.Item>
          {editor.row && <><Alert type="info" message="只调整当前房产关联，保留其他房产及历史；姓名和电话由该业主的所有房产共用。"/><Form.Item name="targetCommunityId" label="当前关联 · 小区" rules={[{required:true,message:'请选择小区'}]}><Select onChange={()=>form.setFieldsValue({targetBuildingId:undefined,targetHouseId:undefined})} options={leafCommunities.map(c=>({value:c.id,label:c.name}))}/></Form.Item><Form.Item name="targetBuildingId" label="当前关联 · 楼栋 / 商铺" rules={[{required:true,message:'请选择楼栋或商铺'}]}><Select loading={targetBuildingsLoading} disabled={targetBuildingsLoading || !!targetBuildingsError} onChange={()=>form.setFieldValue('targetHouseId',undefined)} options={targetBuildings.map(b=>({value:b.id,label:buildingLabel(b)}))}/></Form.Item>{targetBuildings.find(b=>b.id===targetBuildingId)?.buildingType !== 'shop' && <Form.Item name="targetHouseId" label="当前关联 · 房号" rules={[{required:true,message:'请选择房号'}]}><Select loading={targetHousesLoading} disabled={targetBuildingsLoading || targetHousesLoading || !!targetError || !targetBuildingId} options={targetHouses.map(h=>({value:h.id,label:roomLabel(h)}))}/></Form.Item>}{targetError && <Alert type="error" message={targetError} action={<Button onClick={()=>setTargetVersion(v=>v+1)}>重试目标列表</Button>}/>}</>}
          <Form.Item name="moveInDate" label="当前房产 · 入住日期"><Input type="date"/></Form.Item><Form.Item name="billingStartDate" label="当前房产 · 起费日期"><Input type="date"/></Form.Item>
        </>}
      </Form>{saveError && <Alert type="error" showIcon message={saveError}/>}
    </Modal>
    <Modal open={linkOpen} title="关联已有业主" onCancel={()=>{if(!linkLoading)setLinkOpen(false);}} onOk={()=>void linkOwner()} confirmLoading={linkLoading} okText="关联" cancelText="取消"><p>关联当前房产，不重复建档，其他房产关联保留。</p><Input.Search aria-label="搜索已有业主" placeholder="姓名或任一电话" value={ownerSearch} onChange={e=>setOwnerSearch(e.target.value)} onSearch={()=>void searchOwners()} loading={linkLoading} enterButton="搜索"/><Select aria-label="选择已有业主" placeholder="选择搜索结果" value={selectedOwnerId} onChange={setSelectedOwnerId} style={{width:'100%',marginTop:16}} options={ownerOptions.map(r=>({value:r.id,label:`${r.name || '未命名'} · ${r.phone || '未登记电话'}`}))}/>{saveError && <Alert type="error" message={saveError}/>}</Modal>
    <Modal open={!!detail} title="房产详情" footer={<Button onClick={()=>setDetail(undefined)}>关闭</Button>} onCancel={()=>setDetail(undefined)}><dl className="pa-detail">{[['房号',roomLabel(detail)],['楼层',detail?.floor],['面积（㎡）',detail?.areaSqm],['房产性质',detail?.propertyNature],['房型',detail?.roomLayout],['备注',detail?.remark]].map(([label,value])=><div key={String(label)}><dt>{label}</dt><dd>{value ?? '未登记'}</dd></div>)}</dl></Modal>
  </div>;
}
