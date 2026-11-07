import { useEffect, useMemo, useState } from 'react';
import { request } from '@pms/api-client';
import { ADMIN_PAGES, PAGE_GROUPS, REPAIR_TYPE_OPTIONS, STAFF_APP_PAGES } from '@pms/shared-types';
import Icon from '@/components/Icon';
import { Btn, Field, Loading, Sheet, toast } from '@/components/ui';
import ToneIcon from '@/components/ToneIcon';
import { can } from '@/lib/perm';
import { useSession } from '@/lib/auth';
import '@/styles/staff-perms.css';

/* ───────── 类型 ───────── */
interface Assignment { officeId: number | null; skills: string[] }
interface StaffRow {
  id: number; name: string | null; phone: string | null; loginAccount: string | null;
  status: 'active' | 'disabled' | string; wxBound: boolean; onDuty: boolean; skills: string[];
  roles: Array<{ id: number; name: string; builtIn: boolean }>; roleIds: number[];
  assignments: Assignment[];
}
interface Perm { pageKey: string; canView: boolean; canEdit: boolean; canDelete: boolean }
interface RoleRow {
  id: number; name: string; remark: string | null; dataScope: string; builtIn: boolean; enabled: boolean;
  templateId: number | null; templateName: string | null; userCount: number; permissions: Perm[];
  officeIds: number[]; communityIds: number[]; warehouseIds?: number[]; externalAppIds: number[];
}
interface TemplateRow { id: number; name: string; remark: string | null; permissions: Perm[]; externalAppIds: number[] }
interface Office { id: number; name: string; enabled: boolean }
interface ExternalApp { id: number; name: string; enabled: boolean; publishStatus?: string | null; agentStatus?: string | null }
const EXT_STATUS: Record<string, { text: string; tone: string }> = {
  online: { text: '在线', tone: 'ok' },
  draft: { text: '未发布', tone: 'warn' },
  waiting_agent: { text: '等待发布', tone: 'warn' },
  publishing: { text: '发布中', tone: 'warn' },
  error: { text: '异常', tone: 'dang' },
  disabled: { text: '已下线', tone: 'mute' },
};
function extStatus(app: ExternalApp) {
  if (!app.enabled) return { text: '已下线', tone: 'mute' };
  if (app.publishStatus && EXT_STATUS[app.publishStatus]) return EXT_STATUS[app.publishStatus];
  if (app.agentStatus === 'offline' || app.agentStatus === 'degraded' || app.agentStatus === 'disabled') return { text: '客户端离线', tone: 'warn' };
  return { text: '在线', tone: 'ok' };
}
const extUsable = (app: ExternalApp) => app.enabled && (!app.publishStatus || app.publishStatus === 'online');

/* ───────── 字典 ───────── */
const SKILL_SHORT: Record<string, string> = {
  water: '水', electric: '电', door_window: '门锁门窗', appliance: '家电设备', elevator: '电梯',
  smart: '智能化', public: '公共设施', other: '其它',
};
const skillLabel = (s: string) => SKILL_SHORT[s] || s;
const maskPhone = (p?: string | null) => (p && p.length >= 7 ? `${p.slice(0, 3)}****${p.slice(-4)}` : p || '—');

/** 后台菜单分组 → 同一件事在小程序里的入口：一起勾，避免「后台能办、小程序被拒」。
 *  分组标题与组内顺序来自 @pms/shared-types 的 PAGE_GROUPS（与首页菜单、权限界面共用一份）。 */
const APP_BY_GROUP: Record<string, string[]> = {
  收费办理: ['app:apartment-cashier', 'app:meters', 'app:approve-business-manager'],
  车辆管理: ['app:family-car-approve'],
  // 旧的 app:approve-manager 已拆成采购/收费两格，不再出现在勾选列表（仍保留在目录里给旧数据看标签）
  报修养护: ['app:dispatch', 'app:pool', 'app:my-orders', 'app:order-rollback', 'app:order-void', 'app:maintenance-sign', 'app:maintenance-inspect', 'app:repair-create', 'app:my-repairs', 'app:experience-notes'],
  库存与盘点: ['app:materials', 'app:inventory', 'app:stocktakes', 'app:approve-purchase-manager', 'app:approve-purchaser'],
  系统: ['app:messages'],
};

type Tab = 'staff' | 'roles' | 'templates';

/**
 * 员工与权限：
 *  - 员工：谁、在哪个管理处做什么工种（工作范围）、绑什么角色、账号 / 微信 / 在职；
 *  - 角色：只管「能做什么」（页面与动作），可跟随权限模板；
 *  - 权限模板：一份勾选给多个角色共用，改模板即对所有跟随的角色生效。
 * 「在哪里做」只看员工工作范围：一个岗位一个角色，不用按管理处复制。
 */
export default function Staff() {
  const session = useSession();
  const canStaff = can('users', 'view'), canRoles = can('roles', 'view');
  const [selectedTab, setTab] = useState<Tab>('staff');
  const tab: Tab = (selectedTab === 'staff' ? canStaff : canRoles) ? selectedTab : canStaff ? 'staff' : 'roles';
  const [staff, setStaff] = useState<StaffRow[] | null>(null);
  const [roles, setRoles] = useState<RoleRow[]>([]);
  const [templates, setTemplates] = useState<TemplateRow[]>([]);
  const [offices, setOffices] = useState<Office[]>([]);
  const [externalApps, setExternalApps] = useState<ExternalApp[]>([]);
  const [appsError, setAppsError] = useState(false);
  const [appsLoading, setAppsLoading] = useState(false);
  const [appsRetry, setAppsRetry] = useState(0);

  const loadStaff = () => !canStaff ? Promise.resolve() : request<StaffRow[]>({ url: '/staff' }).then(setStaff).catch(() => setStaff([]));
  const loadRoles = () => !canStaff && !canRoles ? Promise.resolve([]) : Promise.all([
    request<RoleRow[]>({ url: canRoles ? '/roles' : '/roles/assignable' }).then(rows => setRoles(rows.map(r => ({ ...r, enabled: r.enabled !== false })))).catch(() => setRoles([])),
    canRoles ? request<TemplateRow[]>({ url: '/roles/templates' }).then(setTemplates).catch(() => setTemplates([])) : Promise.resolve(),
  ]);
  useEffect(() => {
    if (canStaff) void loadStaff(); else setStaff([]);
    void loadRoles();
    setOffices((session.access?.offices ?? []).map(o => ({ ...o, enabled: true })));
  }, [session.access, canStaff, canRoles]);

  useEffect(() => {
    if (!canRoles) return undefined;
    let alive = true;
    setAppsLoading(true); setAppsError(false);
    request<ExternalApp[]>({ url: '/external-access/apps' })
      .then((rows) => { if (alive) setExternalApps(Array.isArray(rows) ? rows : []); })
      .catch(() => { if (alive) { setExternalApps([]); setAppsError(true); } })
      .finally(() => { if (alive) setAppsLoading(false); });
    return () => { alive = false; };
  }, [canRoles, appsRetry]);

  if (!canStaff && !canRoles) return null;
  if (canStaff && staff === null) return <Loading />;
  const staffRows = staff ?? [];
  const officeName = (id: number | null) => (id === null ? '全部管理处' : offices.find((o) => o.id === id)?.name?.replace(/管理处$/, '') || `#${id}`);

  return (
    <>
      <div className="ph" style={{ marginBottom: 14 }}>
        <div>
          <div className="h1row"><ToneIcon kind="staff" /><h1 style={{ fontSize: 22 }}>员工与权限</h1></div>
          <p>员工在哪个管理处做什么工种 · 角色决定能做什么 · 权限模板给多个角色共用</p>
        </div>
        <div className="seg" style={{ marginLeft: 'auto' }}>
          {([['staff', `员工 ${staffRows.length}`], ['roles', `业务角色 ${roles.filter((r) => r.enabled).length}`], ['templates', `权限模板 ${templates.length}`]] as Array<[Tab, string]>).filter(([k]) => k === 'staff' ? canStaff : canRoles).map(([k, n]) => (
            <button key={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{n}</button>
          ))}
        </div>
      </div>
      {tab === 'staff' ? <StaffTab list={staffRows} roles={roles} offices={offices} officeName={officeName} reload={loadStaff} /> : null}
      {tab === 'roles' ? <RolesTab roles={roles} templates={templates} reload={loadRoles} externalApps={externalApps} appsError={appsError} appsLoading={appsLoading} reloadApps={() => setAppsRetry((value) => value + 1)} /> : null}
      {tab === 'templates' ? <TemplatesTab roles={roles} templates={templates} reload={loadRoles} externalApps={externalApps} appsError={appsError} appsLoading={appsLoading} reloadApps={() => setAppsRetry((value) => value + 1)} /> : null}
    </>
  );
}

/* ═════════════ 员工 ═════════════ */
type StaffFilter = 'active' | 'disabled' | 'unbound' | '';
function StaffTab({ list, roles, offices, officeName, reload }: {
  list: StaffRow[]; roles: RoleRow[]; offices: Office[]; officeName: (id: number | null) => string; reload: () => Promise<void>;
}) {
  const [filter, setFilter] = useState<StaffFilter>('active');
  const [q, setQ] = useState('');
  const [office, setOffice] = useState<number | 'all' | ''>('');
  const [editing, setEditing] = useState<StaffRow | 'new' | null>(null);

  const rows = useMemo(() => {
    let l = list;
    if (filter === 'active' || filter === 'disabled') l = l.filter((s) => s.status === filter);
    if (filter === 'unbound') l = l.filter((s) => !s.wxBound && s.status === 'active');
    if (office === 'all') l = l.filter((s) => s.assignments.some((a) => a.officeId === null));
    else if (office) l = l.filter((s) => s.assignments.some((a) => a.officeId === office || a.officeId === null));
    const kw = q.trim();
    if (kw) l = l.filter((s) => [s.name, s.phone, s.loginAccount, ...s.roles.map((r) => r.name)].some((v) => (v || '').includes(kw)));
    return [...l].sort((a, b) => (a.status === b.status ? (a.name || '').localeCompare(b.name || '', 'zh') : a.status === 'active' ? -1 : 1));
  }, [list, filter, q, office]);

  const count = (f: StaffFilter) => (f === 'active' || f === 'disabled' ? list.filter((s) => s.status === f).length : f === 'unbound' ? list.filter((s) => !s.wxBound && s.status === 'active').length : list.length);

  return (
    <>
      <div className="wo-bar" style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <div className="chips">
          {([['active', '在职'], ['disabled', '离职（已停用）'], ['unbound', '未绑微信'], ['', '全部']] as Array<[StaffFilter, string]>).map(([k, n]) => (
            <button key={k} className={`chip ${filter === k ? 'on' : ''}`} onClick={() => setFilter(k)}>{n}<span className="c">{count(k)}</span></button>
          ))}
        </div>
        <select className="in" style={{ width: 180 }} value={String(office)} onChange={(e) => setOffice(e.target.value === '' ? '' : e.target.value === 'all' ? 'all' : Number(e.target.value))}>
          <option value="">全部管理处</option>
          <option value="all">只看跨全部管理处的</option>
          {offices.filter((o) => o.enabled).map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
        </select>
        <input className="in" style={{ width: 240, marginLeft: 'auto' }} value={q} placeholder="搜姓名 / 手机 / 账号 / 角色" onChange={(e) => setQ(e.target.value)} />
        <button className="btn p" onClick={() => setEditing('new')}><Icon name="plus" size={18} />新增员工</button>
      </div>

      <div className="card" style={{ overflow: 'auto', marginTop: 4 }}>
        {rows.length === 0 ? <div style={{ padding: 48, textAlign: 'center' }} className="muted">没有匹配的员工</div> : (
          <table className="tbl">
            <thead><tr><th>员工</th><th>工作范围 · 工种</th><th>业务角色</th><th>登录账号</th><th>微信</th><th>在职</th></tr></thead>
            <tbody>
              {rows.map((s) => (
                <tr key={s.id} className={s.status === 'active' ? '' : 'off'} onClick={() => setEditing(s)}>
                  <td><b>{s.name || '未填姓名'}</b><span className="sub">{maskPhone(s.phone)}</span></td>
                  <td>
                    {s.assignments.length ? s.assignments.map((a) => (
                      <div key={String(a.officeId)} style={{ marginBottom: 2 }}>
                        <span className={a.officeId === null ? 'tag acc' : 'tag'}>{officeName(a.officeId)}</span>
                        <span className="muted" style={{ marginLeft: 6, fontSize: 13.5 }}>{a.skills.length ? a.skills.map(skillLabel).join('、') : '—'}</span>
                      </div>
                    )) : <span className="tag warn">未安排</span>}
                  </td>
                  <td><div className="tags">{s.roles.length ? s.roles.map((r) => <span key={r.id} className={`tag ${r.builtIn ? 'warn' : 'acc'}`}>{r.name}</span>) : <span className="tag warn">无角色</span>}</div></td>
                  <td>{s.loginAccount || <span className="muted">—</span>}</td>
                  <td>{s.wxBound ? <span className="tag ok"><Icon name="wechat" size={14} />已绑</span> : <span className="tag mute">未绑</span>}</td>
                  <td>{s.status === 'active' ? <span className="tag ok">在职{s.onDuty ? '' : ' · 休息'}</span> : <span className="tag mute">离职</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <div className="note2" style={{ marginTop: 14 }}><Icon name="alert" />设为「离职」即停用账号（网页、小程序都登不进），历史工单与记录保留，可随时恢复在职。工作范围决定他能看到哪些管理处的数据、能被派哪些单。</div>

      {editing ? (
        <StaffEditor staff={editing === 'new' ? null : editing} roles={roles} offices={offices}
          onClose={() => setEditing(null)} onSaved={async (msg) => { toast(msg); setEditing(null); await reload(); }} />
      ) : null}
    </>
  );
}

function StaffEditor({ staff, roles, offices, onClose, onSaved }: {
  staff: StaffRow | null; roles: RoleRow[]; offices: Office[]; onClose: () => void; onSaved: (msg: string) => Promise<void>;
}) {
  const [name, setName] = useState(staff?.name || '');
  const [phone, setPhone] = useState(staff?.phone || '');
  const [account, setAccount] = useState(staff?.loginAccount || '');
  const [password, setPassword] = useState('');
  const [roleIds, setRoleIds] = useState<number[]>(staff?.roleIds || []);
  const [rows, setRows] = useState<Assignment[]>(staff?.assignments?.length ? staff.assignments.map((a) => ({ ...a, skills: [...a.skills] })) : []);
  const [active, setActive] = useState(staff ? staff.status === 'active' : true);
  const [busy, setBusy] = useState(false);
  const [custom, setCustom] = useState<Record<string, string>>({});

  const usable = roles.filter((r) => r.enabled || roleIds.includes(r.id));
  /** 顺序只在打开时定一次（原本已有的角色在前），勾选过程中不重排，免得行跳走看错 */
  const [roleOrder] = useState(() => {
    const initial = new Set(staff?.roleIds || []);
    return [...usable].sort((x, y) => Number(initial.has(y.id)) - Number(initial.has(x.id)) || Number(y.userCount > 0) - Number(x.userCount > 0));
  });
  /** 表格行：全部管理处 + 启用中的管理处 + 已安排但已停用的管理处 */
  const officeRows: Array<number | null> = [
    null,
    ...offices.filter((o) => o.enabled || rows.some((r) => r.officeId === o.id)).map((o) => o.id),
  ];
  const toggleOffice = (oid: number | null, on: boolean) =>
    setRows((p) => (on ? (p.some((r) => r.officeId === oid) ? p : [...p, { officeId: oid, skills: [] }]) : p.filter((r) => r.officeId !== oid)));
  const setSkill = (oid: number | null, s: string, on: boolean) =>
    setRows((p) => {
      const has = p.find((r) => r.officeId === oid);
      if (!has) return on ? [...p, { officeId: oid, skills: [s] }] : p; // 勾工种自动勾上「在此工作」
      return p.map((r) => (r.officeId !== oid ? r : { ...r, skills: on ? [...new Set([...r.skills, s])] : r.skills.filter((x) => x !== s) }));
    });
  const commitCustom = (oid: number | null) => {
    const text = custom[String(oid)];
    if (text === undefined) return;
    const extra = [...new Set(text.split(/[、,，;；\s]+/).map((x) => x.trim()).filter(Boolean))];
    setRows((p) => p.map((r) => (r.officeId !== oid ? r : { ...r, skills: [...r.skills.filter((x) => SKILL_SHORT[x]), ...extra] })));
    setCustom((p) => { const n = { ...p }; delete n[String(oid)]; return n; });
  };

  const suggest = async () => {
    if (!name.trim()) { toast('先填姓名'); return; }
    try {
      const r = await request<{ loginAccount: string; password: string }>({ method: 'POST', url: '/staff/suggest-credentials', data: { name: name.trim(), excludeUserId: staff?.id } });
      setAccount(r.loginAccount); setPassword(r.password);
      toast('已生成，保存后生效；请把账号密码告诉本人');
    } catch (e) { toast(e instanceof Error ? e.message : '生成失败'); }
  };

  const save = async () => {
    if (!name.trim()) { toast('请填写姓名'); return; }
    if (!/^1\d{10}$/.test(phone.trim())) { toast('请填写 11 位手机号'); return; }
    if (!roleIds.length) { toast('请至少选一个业务角色'); return; }
    if (Object.keys(custom).length) { toast('「其他工种」还没确认，点一下输入框外面再保存'); return; }
    if (!rows.length) { toast('请至少勾一个管理处的「在此工作」'); return; }
    if (!staff && account && !password) { toast('设了登录账号就要一起设密码'); return; }
    const data: Record<string, unknown> = {
      name: name.trim(), phone: phone.trim(), roleIds, assignments: rows,
      ...(account.trim() !== (staff?.loginAccount || '') ? { loginAccount: account.trim() } : {}),
      ...(password ? { password } : {}),
    };
    if (staff) data.status = active ? 'active' : 'disabled';
    setBusy(true);
    try {
      if (staff) await request({ method: 'PATCH', url: `/staff/${staff.id}`, data });
      else await request({ method: 'POST', url: '/staff', data });
      await onSaved(staff ? (staff.status === 'active' && !active ? '已设为离职，账号已停用' : '已保存') : '已新增员工');
    } catch (e) { toast(e instanceof Error ? e.message : '保存失败'); }
    finally { setBusy(false); }
  };

  const unbind = async () => {
    if (!staff || !window.confirm(`解绑「${staff.name}」的微信？解绑后本人需要重新用微信登录绑定。`)) return;
    setBusy(true);
    try { await request({ method: 'POST', url: `/staff/${staff.id}/unbind-wx` }); await onSaved('已解绑微信'); }
    catch (e) { toast(e instanceof Error ? e.message : '解绑失败'); }
    finally { setBusy(false); }
  };

  return (
    <Sheet open onClose={onClose} width={880} title={staff ? `编辑员工 · ${staff.name || ''}` : '新增员工'} subtitle={staff ? (staff.wxBound ? '微信已绑定' : '微信未绑定（本人首次用微信登录小程序即自动绑定）') : '姓名 + 手机号即可，本人用手机号登录小程序就能用'}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <Field label="姓名"><input className="in" value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <Field label="手机号"><input className="in" value={phone} inputMode="numeric" onChange={(e) => setPhone(e.target.value.replace(/\D/g, '').slice(0, 11))} /></Field>
      </div>

      <Field label="业务角色（决定能做什么）" hint="勾选要给他的岗位；在哪个管理处做由下面的工作范围决定">
        <div className="card" style={{ overflow: 'auto', maxHeight: 300 }}>
          <table className="pm-mx">
            <thead><tr><th className="c">选择</th><th>角色</th><th>权限来源</th><th className="c">人数</th></tr></thead>
            <tbody>
              {roleOrder.map((r) => {
                const on = roleIds.includes(r.id);
                return (
                  <tr key={r.id} style={{ cursor: 'pointer', background: on ? 'var(--mute-w)' : undefined }} onClick={() => setRoleIds((p) => (p.includes(r.id) ? p.filter((x) => x !== r.id) : [...p, r.id]))}>
                    <td className="c"><input type="checkbox" checked={on} readOnly /></td>
                    <td style={{ fontWeight: on ? 600 : 400 }}>{r.name}{r.enabled ? '' : <span className="tag mute" style={{ marginLeft: 6 }}>已归档</span>}</td>
                    <td className="muted">{r.builtIn ? '全部页面' : r.templateName ? `模板「${r.templateName}」` : '自定义'}</td>
                    <td className="c muted">{r.userCount}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Field>

      <Field label="工作范围（在哪个管理处 · 做哪些工种）" hint="勾「在此工作」再勾工种；派单按该管理处的工种匹配。智能化等跨所有管理处的勾「全部管理处」那一行">
        <div className="card" style={{ overflow: 'auto' }}>
          <table className="pm-mx asg-mx">
            <thead>
              <tr>
                <th>管理处</th>
                <th className="c">在此工作</th>
                {REPAIR_TYPE_OPTIONS.map((o) => <th key={o.value} className="c">{skillLabel(o.value)}</th>)}
                <th>其他工种</th>
              </tr>
            </thead>
            <tbody>
              {officeRows.map((oid) => {
                const i = rows.findIndex((r) => r.officeId === oid);
                const row = i >= 0 ? rows[i] : null;
                const extra = row ? row.skills.filter((s) => !SKILL_SHORT[s]) : [];
                return (
                  <tr key={String(oid)} style={{ background: row ? 'var(--mute-w)' : undefined }}>
                    <td style={{ fontWeight: row ? 600 : 400, whiteSpace: 'nowrap' }}>{oid === null ? '全部管理处' : offices.find((o) => o.id === oid)?.name || `#${oid}`}</td>
                    <td className="c"><input type="checkbox" checked={!!row} onChange={(e) => toggleOffice(oid, e.target.checked)} /></td>
                    {REPAIR_TYPE_OPTIONS.map((o) => (
                      <td key={o.value} className="c"><input type="checkbox" checked={!!row?.skills.includes(o.value)} onChange={(e) => setSkill(oid, o.value, e.target.checked)} /></td>
                    ))}
                    <td>
                      <input className="in" style={{ height: 32, minWidth: 130, fontSize: 14 }} placeholder="如 泥工、电焊工" disabled={!row}
                        value={custom[String(oid)] ?? extra.join('、')}
                        onChange={(e) => setCustom((p) => ({ ...p, [String(oid)]: e.target.value }))}
                        onBlur={() => commitCustom(oid)} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div className="muted" style={{ fontSize: 13, marginTop: 6 }}>办公室、经理这类不接单的岗位只勾「在此工作」，工种留空。其他工种用顿号分隔，用于登记与展示；自动派单按表头的报修类型匹配。</div>
      </Field>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr auto', gap: 12, alignItems: 'end' }}>
        <Field label="网页登录账号（选填）"><input className="in" value={account} onChange={(e) => setAccount(e.target.value.trim())} placeholder="不填则用微信扫码登录" /></Field>
        <Field label={staff?.loginAccount ? '重设密码（不改留空）' : '密码'}><input className="in" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="至少 6 位" /></Field>
        <div style={{ marginBottom: 14 }}><Btn onClick={() => void suggest()}><Icon name="key" size={16} />自动生成</Btn></div>
      </div>

      {staff ? (
        <div className="card" style={{ padding: 14, display: 'flex', gap: 12, alignItems: 'center', margin: '4px 0 14px' }}>
          <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 15 }}>
            <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />在职
          </label>
          <span className="muted" style={{ fontSize: 13.5 }}>{active ? '取消勾选并保存 = 离职，账号立即停用' : '已离职：账号停用，保存时勾回即恢复'}</span>
          {staff.wxBound ? <span style={{ marginLeft: 'auto' }}><Btn size="sm" disabled={busy} onClick={() => void unbind()}><Icon name="wechat" size={15} />解绑微信</Btn></span> : null}
        </div>
      ) : null}

      <div style={{ display: 'flex', gap: 10 }}>
        <Btn kind="p" size="lg" disabled={busy} onClick={() => void save()}>{busy ? '保存中…' : '保存'}</Btn>
        <Btn onClick={onClose}>取消</Btn>
      </div>
    </Sheet>
  );
}

/* ═════════════ 业务角色 ═════════════ */
function samePerms(a: Perm[], b: Perm[]) {
  const key = (l: Perm[]) => l.filter((p) => p.canView).map((p) => `${p.pageKey}:${+p.canEdit}${+p.canDelete}`).sort().join('|');
  return key(a) === key(b);
}
/** 「枫桦景苑维修工」→ 模板「维修工」：按岗位名尾巴找同岗位模板 */
function templateForName(name: string, templates: TemplateRow[]) {
  return [...templates].sort((a, b) => b.name.length - a.name.length).find((t) => name.endsWith(t.name) || name.endsWith(t.name.replace(/^物业/, '')));
}

function RolesTab({ roles, templates, reload, externalApps, appsError, appsLoading, reloadApps }: { roles: RoleRow[]; templates: TemplateRow[]; reload: () => Promise<unknown>; externalApps: ExternalApp[]; appsError: boolean; appsLoading: boolean; reloadApps: () => void }) {
  const [showOff, setShowOff] = useState(false);
  const [editing, setEditing] = useState<RoleRow | 'new' | null>(null);
  const list = roles.filter((r) => showOff || r.enabled);
  const groups = [
    ...templates.map((t) => ({ key: `t${t.id}`, title: `跟随模板「${t.name}」`, rows: list.filter((r) => r.templateId === t.id) })),
    { key: 'own', title: '自定义权限（不跟随模板）', rows: list.filter((r) => !r.templateId) },
  ].filter((g) => g.rows.length);

  const archive = async (r: RoleRow, enabled: boolean) => {
    if (!enabled && r.userCount > 0) { toast(`还有 ${r.userCount} 人在用这个角色，先给他们换角色再归档`); return; }
    try {
      await request({ method: 'PATCH', url: `/roles/${r.id}`, data: rolePayload(r, { enabled }) });
      toast(enabled ? '已恢复' : '已归档，可在「含已归档」里恢复'); await reload();
    } catch (e) { toast(e instanceof Error ? e.message : '操作失败'); }
  };
  const follow = async (r: RoleRow, t: TemplateRow) => {
    if (!window.confirm(`把「${r.name}」改为跟随模板「${t.name}」？勾选会以模板为准（多出来的收回、缺的补上）。`)) return;
    try { await request({ method: 'PATCH', url: `/roles/${r.id}`, data: rolePayload(r, { templateId: t.id }) }); toast('已改为跟随模板'); await reload(); }
    catch (e) { toast(e instanceof Error ? e.message : '操作失败'); }
  };

  return (
    <>
      <div className="wo-bar" style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
        <button className={`chip ${showOff ? 'on' : ''}`} onClick={() => setShowOff(!showOff)}>含已归档</button>
        <span className="muted" style={{ fontSize: 13.5 }}>角色只管「能做什么」；在哪个管理处由员工工作范围决定，同一岗位不用再按管理处复制</span>
        <button className="btn p" style={{ marginLeft: 'auto' }} onClick={() => setEditing('new')}><Icon name="plus" size={18} />新建角色</button>
      </div>
      {groups.map((g) => (
        <div key={g.key} className="card" style={{ overflow: 'auto', marginTop: 8 }}>
          <div style={{ padding: '10px 14px', fontWeight: 600, borderBottom: '1px solid var(--line)' }}>{g.title} · {g.rows.length} 个角色</div>
          <table className="tbl">
            <thead><tr><th>角色</th><th>人数</th><th>能做什么</th><th>提示</th><th /></tr></thead>
            <tbody>
              {g.rows.map((r) => {
                const tpl = !r.templateId && !r.builtIn ? templateForName(r.name, templates) : undefined;
                const drift = tpl && !samePerms(r.permissions, tpl.permissions) ? tpl : undefined;
                const admin = r.permissions.filter((p) => p.canView && !p.pageKey.startsWith('app:')).length;
                const app = r.permissions.filter((p) => p.canView && p.pageKey.startsWith('app:')).length;
                return (
                  <tr key={r.id} className={r.enabled ? '' : 'off'} onClick={() => setEditing(r)}>
                    <td><b>{r.name}</b>{r.remark ? <span className="sub">{r.remark}</span> : null}</td>
                    <td>{r.userCount ? `${r.userCount} 人` : <span className="tag mute">0 人</span>}</td>
                    <td>{r.builtIn ? '全部页面' : `网页 ${admin} 项 · 小程序 ${app} 项`}</td>
                    <td><div className="tags">
                      {!r.enabled ? <span className="tag mute">已归档</span> : null}
                      {r.enabled && !r.userCount && !r.builtIn ? <span className="tag warn">没人用，可归档</span> : null}
                      {drift ? <span className="tag warn">和模板「{drift.name}」不一致</span> : null}
                    </div></td>
                    <td onClick={(e) => e.stopPropagation()} style={{ whiteSpace: 'nowrap' }}>
                      {drift ? <button className="btn sm" onClick={() => void follow(r, drift)}>改为跟随模板</button> : null}
                      {r.builtIn ? null : r.enabled
                        ? <button className="btn sm" onClick={() => void archive(r, false)}>归档</button>
                        : <button className="btn sm" onClick={() => void archive(r, true)}>恢复</button>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ))}
      {editing ? <RoleEditor role={editing === 'new' ? null : editing} templates={templates} externalApps={externalApps} appsError={appsError} appsLoading={appsLoading} reloadApps={reloadApps} onClose={() => setEditing(null)} onSaved={async (m) => { toast(m); setEditing(null); await reload(); }} /> : null}
    </>
  );
}

/** PATCH /roles 要整份字段；数据范围已挪到员工，这里原样带回旧值（旧后台兼容） */
function rolePayload(r: RoleRow, patch: Partial<{ name: string; remark: string; enabled: boolean; templateId: number | null; permissions: Perm[]; externalAppIds: number[] }>) {
  const templateId = patch.templateId !== undefined ? patch.templateId : r.templateId;
  return {
    name: patch.name ?? r.name,
    remark: patch.remark ?? r.remark ?? undefined,
    dataScope: r.dataScope,
    officeIds: r.dataScope === 'offices' ? r.officeIds : undefined,
    communityIds: r.dataScope === 'communities' ? r.communityIds : undefined,
    warehouseIds: r.warehouseIds ?? [],
    enabled: patch.enabled ?? r.enabled,
    templateId,
    permissions: templateId ? [] : (patch.permissions ?? r.permissions),
    externalAppIds: templateId ? [] : (patch.externalAppIds ?? r.externalAppIds),
  };
}

function RoleEditor({ role, templates, onClose, onSaved, externalApps, appsError, appsLoading, reloadApps }: { role: RoleRow | null; templates: TemplateRow[]; onClose: () => void; onSaved: (m: string) => Promise<void>; externalApps: ExternalApp[]; appsError: boolean; appsLoading: boolean; reloadApps: () => void }) {
  const [name, setName] = useState(role?.name || '');
  const [remark, setRemark] = useState(role?.remark || '');
  const [templateId, setTemplateId] = useState<number | null>(role ? role.templateId : templates[0]?.id ?? null);
  const [perms, setPerms] = useState<Perm[]>(role?.permissions || []);
  const [extAppIds, setExtAppIds] = useState<number[]>(role?.externalAppIds || []);
  const [busy, setBusy] = useState(false);
  const template = templateId ? templates.find((t) => t.id === templateId) : null;
  const shown = template ? template.permissions : perms;
  const shownExt = template ? (template.externalAppIds || []) : extAppIds;

  const save = async () => {
    if (!name.trim()) { toast('请填写角色名称'); return; }
    const own = perms.filter((p) => p.canView);
    if (!templateId && !own.length) { toast('至少勾一项权限'); return; }
    const ownExt = extAppIds;
    setBusy(true);
    try {
      if (role) await request({ method: 'PATCH', url: `/roles/${role.id}`, data: rolePayload(role, { name: name.trim(), remark, templateId, permissions: own, externalAppIds: ownExt }) });
      else await request({ method: 'POST', url: '/roles', data: { name: name.trim(), remark: remark || undefined, dataScope: 'all', enabled: true, templateId, permissions: templateId ? [] : own, warehouseIds: [], externalAppIds: templateId ? [] : ownExt } });
      await onSaved(role ? '已保存' : '已新建角色');
    } catch (e) { toast(e instanceof Error ? e.message : '保存失败'); }
    finally { setBusy(false); }
  };
  const saveAsTemplate = async () => {
    if (!role) return;
    const n = window.prompt('模板名称', role.name);
    if (!n) return;
    try { await request({ method: 'POST', url: `/roles/${role.id}/save-as-template`, data: { name: n } }); await onSaved('已另存为模板'); }
    catch (e) { toast(e instanceof Error ? e.message : '另存失败'); }
  };

  return (
    <Sheet open onClose={onClose} width={720} title={role ? `编辑角色 · ${role.name}` : '新建角色'} subtitle={role?.builtIn ? '企业超级管理员：全部页面，不可修改权限' : '先选模板最省事；特殊岗位再自定义'}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <Field label="角色名称"><input className="in" value={name} disabled={role?.builtIn} onChange={(e) => setName(e.target.value)} placeholder="例如：维修工" /></Field>
        <Field label="备注"><input className="in" value={remark} onChange={(e) => setRemark(e.target.value)} /></Field>
      </div>
      {role?.builtIn ? null : (
        <>
          <Field label="权限来源">
            <select className="in" value={templateId ?? ''} onChange={(e) => { const v = e.target.value ? Number(e.target.value) : null; if (!v && templateId) { const prev = templates.find((t) => t.id === templateId); setPerms(prev?.permissions || []); setExtAppIds(prev?.externalAppIds || []); } setTemplateId(v); }}>
              {templates.map((t) => <option key={t.id} value={t.id}>跟随模板「{t.name}」（改模板即同步）</option>)}
              <option value="">自定义勾选（不跟随模板）</option>
            </select>
          </Field>
          <PermMatrix value={shown} readOnly={!!templateId} onChange={setPerms} externalApps={externalApps} externalAppIds={shownExt} onExternalChange={setExtAppIds} appsError={appsError} appsLoading={appsLoading} reloadApps={reloadApps} />
        </>
      )}
      <div style={{ display: 'flex', gap: 10, marginTop: 14 }}>
        <Btn kind="p" size="lg" disabled={busy} onClick={() => void save()}>{busy ? '保存中…' : '保存'}</Btn>
        <Btn onClick={onClose}>取消</Btn>
        {role && !role.builtIn && !role.templateId ? <span style={{ marginLeft: 'auto' }}><Btn onClick={() => void saveAsTemplate()}>另存为权限模板</Btn></span> : null}
      </div>
    </Sheet>
  );
}

/* ═════════════ 权限模板 ═════════════ */
function TemplatesTab({ roles, templates, reload, externalApps, appsError, appsLoading, reloadApps }: { roles: RoleRow[]; templates: TemplateRow[]; reload: () => Promise<unknown>; externalApps: ExternalApp[]; appsError: boolean; appsLoading: boolean; reloadApps: () => void }) {
  const [editing, setEditing] = useState<TemplateRow | 'new' | null>(null);
  const remove = async (t: TemplateRow) => {
    const used = roles.filter((r) => r.templateId === t.id);
    if (used.length) { toast(`还有 ${used.length} 个角色跟随这个模板，先改掉再删除`); return; }
    if (!window.confirm(`删除模板「${t.name}」？没有角色在用，不影响任何人。`)) return;
    try { await request({ method: 'DELETE', url: `/roles/templates/${t.id}` }); toast('已删除'); await reload(); }
    catch (e) { toast(e instanceof Error ? e.message : '删除失败'); }
  };
  return (
    <>
      <div className="wo-bar" style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
        <span className="muted" style={{ fontSize: 13.5 }}>一份勾选给多个角色共用；改模板，所有跟随它的角色立即同步</span>
        <button className="btn p" style={{ marginLeft: 'auto' }} onClick={() => setEditing('new')}><Icon name="plus" size={18} />新建模板</button>
      </div>
      <div className="card" style={{ overflow: 'auto', marginTop: 4 }}>
        <table className="tbl">
          <thead><tr><th>模板</th><th>跟随的角色</th><th>能做什么</th><th /></tr></thead>
          <tbody>
            {templates.map((t) => {
              const used = roles.filter((r) => r.templateId === t.id);
              return (
                <tr key={t.id} onClick={() => setEditing(t)}>
                  <td><b>{t.name}</b>{t.remark ? <span className="sub">{t.remark}</span> : null}</td>
                  <td><div className="tags">{used.length ? used.map((r) => <span key={r.id} className="tag">{r.name} · {r.userCount}人</span>) : <span className="tag mute">没有角色在用</span>}</div></td>
                  <td>网页 {t.permissions.filter((p) => p.canView && !p.pageKey.startsWith('app:')).length} 项 · 小程序 {t.permissions.filter((p) => p.canView && p.pageKey.startsWith('app:')).length} 项</td>
                  <td onClick={(e) => e.stopPropagation()}>{used.length ? null : <button className="btn sm" onClick={() => void remove(t)}>删除</button>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {editing ? <TemplateEditor tpl={editing === 'new' ? null : editing} externalApps={externalApps} appsError={appsError} appsLoading={appsLoading} reloadApps={reloadApps} onClose={() => setEditing(null)} onSaved={async (m) => { toast(m); setEditing(null); await reload(); }} /> : null}
    </>
  );
}

function TemplateEditor({ tpl, onClose, onSaved, externalApps, appsError, appsLoading, reloadApps }: { tpl: TemplateRow | null; onClose: () => void; onSaved: (m: string) => Promise<void>; externalApps: ExternalApp[]; appsError: boolean; appsLoading: boolean; reloadApps: () => void }) {
  const [name, setName] = useState(tpl?.name || '');
  const [remark, setRemark] = useState(tpl?.remark || '');
  const [perms, setPerms] = useState<Perm[]>(tpl?.permissions || []);
  const [extAppIds, setExtAppIds] = useState<number[]>(tpl?.externalAppIds || []);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    if (!name.trim()) { toast('请填写模板名称'); return; }
    const permissions = perms.filter((p) => p.canView);
    if (!permissions.length) { toast('至少勾一项权限'); return; }
    setBusy(true);
    try {
      const data = { name: name.trim(), remark: remark || undefined, permissions, externalAppIds: extAppIds };
      if (tpl) await request({ method: 'PATCH', url: `/roles/templates/${tpl.id}`, data });
      else await request({ method: 'POST', url: '/roles/templates', data });
      await onSaved(tpl ? '已保存，跟随的角色已同步' : '已新建模板');
    } catch (e) { toast(e instanceof Error ? e.message : '保存失败'); }
    finally { setBusy(false); }
  };
  return (
    <Sheet open onClose={onClose} width={720} title={tpl ? `编辑模板 · ${tpl.name}` : '新建权限模板'} subtitle="网页菜单和对应的小程序入口放在同一组，一次勾全">
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <Field label="模板名称"><input className="in" value={name} onChange={(e) => setName(e.target.value)} placeholder="例如：维修工" /></Field>
        <Field label="备注"><input className="in" value={remark} onChange={(e) => setRemark(e.target.value)} /></Field>
      </div>
      <PermMatrix value={perms} onChange={setPerms} externalApps={externalApps} externalAppIds={extAppIds} onExternalChange={setExtAppIds} appsError={appsError} appsLoading={appsLoading} reloadApps={reloadApps} />
      <div style={{ display: 'flex', gap: 10, marginTop: 14 }}>
        <Btn kind="p" size="lg" disabled={busy} onClick={() => void save()}>{busy ? '保存中…' : '保存'}</Btn>
        <Btn onClick={onClose}>取消</Btn>
      </div>
    </Sheet>
  );
}

/* ═════════════ 权限勾选表 ═════════════ */
function PermMatrix({ value, onChange, readOnly, externalApps, externalAppIds, onExternalChange, appsError, appsLoading, reloadApps }: {
  value: Perm[]; onChange: (p: Perm[]) => void; readOnly?: boolean;
  externalApps: ExternalApp[]; externalAppIds: number[]; onExternalChange: (ids: number[]) => void;
  appsError: boolean; appsLoading: boolean; reloadApps: () => void;
}) {
  const get = (k: string) => value.find((p) => p.pageKey === k) || { pageKey: k, canView: false, canEdit: false, canDelete: false };
  const set = (k: string, patch: Partial<Perm>) => {
    if (readOnly) return;
    const next = { ...get(k), ...patch };
    if (patch.canEdit || patch.canDelete) next.canView = true;
    if (patch.canView === false) { next.canEdit = false; next.canDelete = false; }
    onChange([...value.filter((p) => p.pageKey !== k), next]);
  };
  const toggleApp = (id: number, checked: boolean) => {
    if (readOnly) return;
    onExternalChange(checked ? [...new Set([...externalAppIds, id])] : externalAppIds.filter((value) => value !== id));
  };
  const mapped = new Set(Object.values(APP_BY_GROUP).flat());
  const extraApp = STAFF_APP_PAGES.filter((p) => !mapped.has(p.key) && !p.legacy);
  const pageByKey = new Map(ADMIN_PAGES.map((p) => [p.key, p] as const));
  const box = (k: string, f: 'canView' | 'canEdit' | 'canDelete', show = true) => (show
    ? <input type="checkbox" checked={get(k)[f]} disabled={readOnly} onChange={(e) => set(k, { [f]: e.target.checked })} />
    : <span className="muted">—</span>);
  const appRow = (k: string) => {
    const p = STAFF_APP_PAGES.find((x) => x.key === k);
    if (!p) return null;
    return (
      <tr key={p.key}>
        <td><Icon name="phone" size={14} /> 小程序 · {p.label}{p.editLabel ? <span className="muted" style={{ fontSize: 12.5 }}>（办理 = {p.editLabel}）</span> : null}</td>
        <td className="c">{box(p.key, 'canView')}</td>
        <td className="c">{box(p.key, 'canEdit', !!p.editLabel)}</td>
        <td className="c"><span className="muted">—</span></td>
      </tr>
    );
  };
  return (
    <div className="card" style={{ overflow: 'auto', marginTop: 4, opacity: readOnly ? 0.75 : 1 }}>
      {readOnly ? <div className="muted" style={{ padding: '8px 12px', fontSize: 13.5 }}>跟随模板：这里只读，改勾选请到「权限模板」页改模板</div> : null}
      <table className="pm-mx">
        <thead><tr><th>页面 / 入口</th><th className="c">查看</th><th className="c">办理</th><th className="c">归档</th></tr></thead>
        <tbody>
          {/* 分组标题/顺序与首页菜单共用 PAGE_GROUPS，找页面时和导航一致 */}
          {PAGE_GROUPS.map((group) => {
            const pages = group.pageKeys
              .map((key) => pageByKey.get(key))
              .filter((p): p is (typeof ADMIN_PAGES)[number] => !!p);
            const appKeys = APP_BY_GROUP[group.title] || [];
            if (!pages.length && !appKeys.length) return null;
            return (
              <GroupRows key={group.title} title={group.title}>
                {pages.map((p) => {
                  const acts = p.actions ?? [{ field: 'canEdit' as const }, { field: 'canDelete' as const }];
                  return (
                    <tr key={p.key}>
                      <td><Icon name="globe" size={14} /> 网页 · {p.label}</td>
                      <td className="c">{box(p.key, 'canView')}</td>
                      <td className="c">{box(p.key, 'canEdit', acts.some((a) => a.field === 'canEdit'))}</td>
                      <td className="c">{box(p.key, 'canDelete', acts.some((a) => a.field === 'canDelete'))}</td>
                    </tr>
                  );
                })}
                {appKeys.map(appRow)}
              </GroupRows>
            );
          })}
          {extraApp.length ? <GroupRows title="小程序其他入口">{extraApp.map((p) => appRow(p.key))}</GroupRows> : null}
          <GroupRows title="内网应用">
            {appsLoading ? <tr className="pm-app-row"><td colSpan={4}><span className="muted">读取应用列表…</span></td></tr>
              : appsError ? <tr className="pm-app-row pm-app-error"><td colSpan={4}><span className="muted">应用列表读取失败，可重试</span><button type="button" className="btn sm" style={{ marginLeft: 10 }} onClick={() => reloadApps()}>重试</button></td></tr>
                : !externalApps.length ? <tr className="pm-app-row"><td colSpan={4}><span className="muted">还没有发布内网应用，请先在『内网应用』页发布</span></td></tr>
                  : externalApps.map((app) => {
                    const status = extStatus(app);
                    const usable = extUsable(app);
                    return (
                      <tr key={'ext-' + app.id} className={'pm-app-row' + (usable ? '' : ' is-off')}>
                        <td><span className="pm-app-name"><Icon name="link" size={13} />{app.name}<span className={'pm-app-status ' + status.tone}>{status.text}</span></span></td>
                        <td className="c"><input type="checkbox" aria-label={'内网应用 ' + app.name} checked={externalAppIds.includes(app.id)} disabled={readOnly || !usable} onChange={(e) => toggleApp(app.id, e.target.checked)} /></td>
                        <td className="c"><span className="muted">—</span></td>
                        <td className="c"><span className="muted">—</span></td>
                      </tr>
                    );
                  })}
          </GroupRows>
        </tbody>
      </table>
    </div>
  );
}

function GroupRows({ title, children }: { title: string; children: React.ReactNode }) {
  return (<><tr className="g"><td colSpan={4}>{title}</td></tr>{children}</>);
}
