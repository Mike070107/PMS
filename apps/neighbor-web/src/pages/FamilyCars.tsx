import { Fragment, useCallback, useEffect, useState } from 'react';
import { accessCardIssuance, request } from '@pms/api-client';
import Icon from '@/components/Icon';
import { Loading, toast } from '@/components/ui';
import { dayjs } from '@/lib/format';
import { can } from '@/lib/perm';
import { useSession } from '@/lib/auth';
import ToneIcon from '@/components/ToneIcon';

interface FamilyCar {
  id: number; houseId: number; lane: string; buildingNo: string; roomNo: string; roomKey: string;
  ownerName: string; carOwnerName: string; carOwnerPhone: string; relation: string; plate: string;
  status: string; statusLabel: string; mode: 'new' | 'existing'; startDate: string | null; endDate: string | null;
  daysLeft: number | null; expiringSoon: boolean; garages: string[]; garageNumbers: Record<string, string>;
  fileCount: number; lastError: string | null; createdAt: string;
}
interface FamilyDetail extends FamilyCar {
  files: Array<{ index: number; fileName: string; contentType: string; fileUrl: string; source: string }>;
  officeNote: string; managerNote: string; log: Array<{ at: string; userName: string; action: string; note?: string }>;
}

const GARAGE: Record<string, string> = { phase1: '一期地面', phase2: '二期地面', main: '二期大车库', civil: '二期人防' };
const FAMILY_FILTERS: Array<[string, string]> = [['', '全部'], ['office', '待办公室审核'], ['manager', '待经理审核'], ['opening', '开通中'], ['active', '已生效'], ['expired', '已过期'], ['upload', '待上传资料']];
const familyTone = (s: string) => (s === 'active' ? 'ok' : ['expired', 'void'].includes(s) ? 'mute' : s === 'returned' ? 'dang' : 'warn');

export default function FamilyCars() {
  useSession();
  const canFamily = ['family-cars', 'family-cars-approve', 'app:family-car-approve', 'app:approve-business-manager'].some(key => can(key, 'view'));
  const [q, setQ] = useState('');
  const [kw, setKw] = useState('');
  if (!canFamily) return null;
  return (
    <>
      <div className="ph" style={{ marginBottom: 14 }}>
        <div><div className="h1row"><ToneIcon kind="plates" /><h1 style={{ fontSize: 22 }}>亲情车管理</h1></div><p>亲情车登记、资料审核、有效期与授权车库；到期续登 · 失败重试</p></div>
        <form style={{ display: 'flex', gap: 8 }} onSubmit={(e) => { e.preventDefault(); setKw(q.trim()); }}>
          <input className="in" style={{ width: 260 }} value={q} onChange={(e) => setQ(e.target.value)} placeholder="车牌 / 房号 / 姓名 / 电话" />
          <button className="btn p"><Icon name="search" size={16} />查询</button>
        </form>
      </div>
      <FamilyList kw={kw} />
    </>
  );
}

function FamilyList({ kw }: { kw: string }) {
  const [status, setStatus] = useState('');
  const [rows, setRows] = useState<FamilyCar[] | null>(null);
  const [open, setOpen] = useState<FamilyDetail | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const [qr, setQr] = useState<{ plate: string; dataUrl: string; expiresAt: string } | null>(null);
  const canEdit = can('family-cars', 'edit');
  // 与亲情车控制器 MANAGER 保持一致；旧采购经理键不授予亲情车审批权。
  const canManager = ['family-cars-approve', 'app:family-car-approve', 'app:approve-business-manager'].some(key => can(key, 'edit'));
  const load = useCallback(() => {
    // 接口返回 { rows, today }（不是数组）
    request<{ rows: FamilyCar[] } | FamilyCar[]>({ url: '/family-cars', query: { ...(status ? { status } : {}), ...(kw ? { q: kw } : {}) } })
      .then((r) => setRows(Array.isArray(r) ? r : r?.rows ?? [])).catch(() => setRows([]));
  }, [status, kw]);
  useEffect(() => { setRows(null); load(); }, [load]);
  const detail = async (id: number) => setOpen(await request<FamilyDetail>({ url: `/family-cars/${id}` }));
  const act = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(true);
    try { await fn(); toast(`${label}：已提交`); setNote(''); if (open) await detail(open.id); load(); }
    catch (e) { toast(e instanceof Error ? e.message : `${label}失败`); }
    finally { setBusy(false); }
  };
  // 续登一年：旧库查重 → 新登记（带上上一年的信息），业主扫码上传今年的资料
  const renew = (c: FamilyDetail) => act('续登', async () => {
    let qy = await accessCardIssuance.createParkingQuery(c.plate);
    for (let i = 0; i < 24 && (qy.status === 'pending' || qy.status === 'running'); i += 1) {
      await new Promise((ok) => window.setTimeout(ok, 1500));
      qy = await accessCardIssuance.parkingQuery(qy.id);
    }
    if (qy.status !== 'completed') throw new Error(qy.status === 'failed' ? (qy.error || '旧库查重失败') : '现场停车库没有回应，请稍后再试');
    const r = await request<{ qr?: { qrDataUrl: string; expiresAt: string } }>({ method: 'POST', url: '/family-cars', data: {
      houseId: c.houseId, plate: c.plate, duplicateCheckQueryId: qy.id, ownerFill: true, previousId: c.id,
      carOwnerName: c.carOwnerName, carOwnerPhone: c.carOwnerPhone, relation: c.relation, garages: c.garages, garageNumbers: c.garageNumbers,
    } });
    if (r.qr) setQr({ plate: c.plate, dataUrl: r.qr.qrDataUrl, expiresAt: r.qr.expiresAt });
  });

  // 从现场旧停车库（一期 / 二期）拉亲情车清单：助手只读查询 → 先核对 → 确认后导入
  type PullRow = { plate: string; room: string; verdict: 'imported' | 'would_import' | 'skipped' | 'failed'; message: string };
  const [pull, setPull] = useState<{ step: 'running' | 'review' | 'done'; text: string; rows?: unknown[]; results?: PullRow[]; summary?: { imported: number; skipped: number; failed: number } } | null>(null);
  // 接口返回 { dryRun, summary, rows }（逐行结果在 rows 里）
  const runImport = async (rows: unknown[], dryRun: boolean) => {
    const r = await request<{ summary: { imported: number; skipped: number; failed: number }; rows: PullRow[] }>({ method: 'POST', url: '/family-cars/import', data: { rows, dryRun } });
    return { summary: r.summary, results: r.rows ?? [] };
  };
  const startPull = async () => {
    setPull({ step: 'running', text: '正在通过数据同步助手读取一期、二期旧停车库…' });
    try {
      const job = await request<{ id: number }>({ method: 'POST', url: '/family-cars/legacy-pull' });
      let r: { status: string; error?: string | null; rows: unknown[] } = { status: 'pending', rows: [] };
      for (let i = 0; i < 60 && (r.status === 'pending' || r.status === 'running'); i += 1) {
        await new Promise((ok) => window.setTimeout(ok, 2000));
        r = await request({ url: `/family-cars/legacy-pull/${job.id}` });
      }
      if (r.status !== 'completed') throw new Error(r.status === 'failed' ? (r.error || '旧库读取失败') : '现场助手 2 分钟内没有回应，请稍后再试');
      if (!r.rows.length) { setPull({ step: 'done', text: '旧停车库里没有车辆授权类型为「亲情车」的车' }); return; }
      const all: PullRow[] = []; let sum = { imported: 0, skipped: 0, failed: 0 }; let would = 0;
      for (let i = 0; i < r.rows.length; i += 500) {
        const res = await runImport(r.rows.slice(i, i + 500), true);
        all.push(...res.results); sum = { imported: 0, skipped: sum.skipped + res.summary.skipped, failed: sum.failed + res.summary.failed };
        would += res.results.filter((x) => x.verdict === 'would_import').length;
      }
      setPull({ step: 'review', text: `旧库共 ${r.rows.length} 辆亲情车：可导入 ${would} 辆；已在列表 / 跳过 ${sum.skipped} 辆；不能导入 ${sum.failed} 辆（多为旧库没登记房号，原因见下表，需核实后手动登记）`, rows: r.rows, results: all, summary: sum });
    } catch (e) { setPull({ step: 'done', text: e instanceof Error ? e.message : '拉取失败' }); }
  };
  const confirmPull = async () => {
    if (!pull?.rows) return;
    setPull({ ...pull, step: 'running', text: '正在导入…' });
    try {
      const all: PullRow[] = []; const sum = { imported: 0, skipped: 0, failed: 0 };
      for (let i = 0; i < pull.rows.length; i += 500) {
        const res = await runImport(pull.rows.slice(i, i + 500), false);
        all.push(...res.results); sum.imported += res.summary.imported; sum.skipped += res.summary.skipped; sum.failed += res.summary.failed;
      }
      setPull({ step: 'done', text: `已导入 ${sum.imported} 辆，跳过 ${sum.skipped} 辆，失败 ${sum.failed} 辆（旧库已生效的直接记为已生效，已过期的记为已过期）`, results: all, summary: sum });
      load();
    } catch (e) { setPull({ ...pull, step: 'review', text: e instanceof Error ? e.message : '导入失败' }); }
  };

  return (
    <>
      <div className="quickMonths" style={{ marginTop: 0, marginBottom: 10 }}>
        {FAMILY_FILTERS.map(([k, l]) => <button key={k} className={`chip ${status === k ? 'on' : ''}`} onClick={() => setStatus(k)}>{l}</button>)}
        {canEdit ? <button className="btn sm" style={{ marginLeft: 'auto' }} disabled={pull?.step === 'running'} onClick={() => void startPull()}><Icon name="sync" size={15} />从旧停车库拉取</button> : null}
      </div>
      {pull ? (
        <div className="card" style={{ padding: 14, marginBottom: 12 }}>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <b style={{ flex: 1, minWidth: 260 }}>{pull.step === 'running' ? '⏳ ' : ''}{pull.text}</b>
            {pull.step === 'review' ? <button className="btn p sm" onClick={() => void confirmPull()}>确认导入</button> : null}
            {pull.step !== 'running' ? <button className="btn sm" onClick={() => setPull(null)}>收起</button> : null}
          </div>
          {pull.results?.some((x) => x.verdict !== 'would_import' && x.verdict !== 'imported') ? (
            <div className="t-scroll" style={{ maxHeight: 260, overflow: 'auto', marginTop: 10 }}>
              <table className="t"><thead><tr><th>车牌</th><th>旧库房号</th><th>结果</th><th>原因</th></tr></thead>
                <tbody>{pull.results.filter((x) => x.verdict !== 'would_import' && x.verdict !== 'imported').map((x, i) => (
                  <tr key={i}><td className="nw"><b className="plate">{x.plate}</b></td><td className="nw">{x.room}</td><td className="nw">{x.verdict === 'failed' ? <span className="tag dang">没导入</span> : <span className="tag mute">跳过</span>}</td><td>{x.message}</td></tr>
                ))}</tbody></table>
            </div>
          ) : null}
        </div>
      ) : null}
      {qr ? (
        <div className="card np-card" style={{ marginBottom: 12, display: 'flex', gap: 16, alignItems: 'center' }}>
          <img src={qr.dataUrl} alt="" style={{ width: 160, height: 160 }} />
          <div><b>{qr.plate} 续登：请业主扫码上传今年的资料</b><div className="muted">有效至 {dayjs(qr.expiresAt).format('HH:mm')}（1 小时）· 业主可拍下二维码回家再扫</div>
            <button className="btn sm" style={{ marginTop: 8 }} onClick={() => setQr(null)}>收起</button></div>
        </div>
      ) : null}
      {rows === null ? <Loading /> : (
        <div className="card" style={{ overflow: 'hidden' }}>
          <table className="tbl">
            <thead><tr><th>车牌</th><th>房号</th><th>车主 · 关系</th><th>授权车库</th><th>有效期</th><th>状态</th><th>问题</th></tr></thead>
            <tbody>
              {rows.map((c) => (
                <Fragment key={c.id}>
                  <tr key={c.id} className={open?.id === c.id ? 'sel' : ''} onClick={() => (open?.id === c.id ? setOpen(null) : void detail(c.id))}>
                    <td><b className="plate">{c.plate}</b></td>
                    <td>{c.roomKey}<div className="muted" style={{ fontSize: 13 }}>{c.ownerName}</div></td>
                    <td>{c.carOwnerName || '—'}{c.relation ? ` · ${c.relation}` : ''}<div className="muted" style={{ fontSize: 13 }}>{c.carOwnerPhone}</div></td>
                    <td>{(c.garages ?? []).map((g) => <span key={g} className="tag mute" style={{ marginRight: 4 }}>{GARAGE[g] || g}{c.garageNumbers?.[g] ? ` ${c.garageNumbers[g]}` : ''}</span>)}</td>
                    <td>{c.startDate ? `${c.startDate} ~ ${c.endDate}` : '—'}{c.daysLeft != null ? <div className="muted" style={{ fontSize: 13, color: c.expiringSoon ? 'var(--dang)' : undefined }}>剩 {c.daysLeft} 天</div> : null}</td>
                    <td><span className={`tag ${familyTone(c.status)}`}>{c.statusLabel}</span></td>
                    <td style={{ color: 'var(--dang)', fontSize: 13.5, maxWidth: 260 }}>{c.lastError || ''}</td>
                  </tr>
                  {open?.id === c.id ? (
                    <tr key={`d${c.id}`} style={{ cursor: 'default' }}><td colSpan={7} style={{ background: 'var(--sunken)', padding: 14 }}>
                      <div className="np-files" style={{ marginBottom: 10 }}>
                        {(open.files ?? []).map((f) => <a key={f.index} href={f.fileUrl} target="_blank" rel="noreferrer" title={f.fileName}>{f.contentType.startsWith('image/') ? <img src={f.fileUrl} alt="" /> : <span className="np-pdf"><Icon name="file" size={22} />PDF</span>}</a>)}
                        {!open.files.length ? <span className="muted">还没有资料</span> : null}
                      </div>
                      {open.lastError ? <div className="note2" style={{ color: 'var(--dang)', marginBottom: 8 }}><Icon name="alert" />{open.lastError}</div> : null}
                      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                        <input className="in" style={{ width: 240, height: 38 }} value={note} onChange={(e) => setNote(e.target.value)} placeholder="备注 / 原因（退回、作废必填）" />
                        {canEdit && ['office', 'returned'].includes(open.status) ? <>
                          <button className="btn p sm" disabled={busy} onClick={() => act('办公室审核', () => request({ method: 'POST', url: `/family-cars/${open.id}/office-review`, data: { decision: 'approve', note } }))}>办公室审核通过</button>
                          <button className="btn sm" disabled={busy} onClick={() => act('要求补资料', () => request({ method: 'POST', url: `/family-cars/${open.id}/office-review`, data: { decision: 'reupload', note } }))}>要求补资料</button>
                        </> : null}
                        {canManager && open.status === 'manager' ? <>
                          <button className="btn p sm" disabled={busy} onClick={() => act('经理审核', () => request({ method: 'POST', url: `/family-cars/${open.id}/manager-review`, data: { decision: 'approve', note } }))}>经理审核通过（开通一年）</button>
                          <button className="btn sm" disabled={busy || !note.trim()} onClick={() => act('退回办公室', () => request({ method: 'POST', url: `/family-cars/${open.id}/manager-review`, data: { decision: 'return', note } }))}>退回办公室</button>
                        </> : null}
                        {canEdit && (open.status === 'opening' || open.lastError) ? <button className="btn sm" disabled={busy} onClick={() => act('重试', () => request({ method: 'POST', url: `/family-cars/${open.id}/retry` }))}><Icon name="refresh" size={15} />失败重试</button> : null}
                        {canEdit && (open.status === 'expired' || (open.status === 'active' && open.expiringSoon)) ? <button className="btn sm" disabled={busy} onClick={() => renew(open)}>{busy ? '处理中…' : '续登一年'}</button> : null}
                        {canEdit && open.status === 'active' ? <button className="btn sm d" disabled={busy || !note.trim()} onClick={() => act('停用', () => request({ method: 'POST', url: `/family-cars/${open.id}/stop`, data: { note } }))}>停用</button> : null}
                      </div>
                      <ol className="np-log">{[...(open.log ?? [])].reverse().map((l, i) => <li key={i}><time>{dayjs(l.at).format('MM-DD HH:mm')}</time><b>{l.userName}</b>{l.action}{l.note ? <small> · {l.note}</small> : null}</li>)}</ol>
                    </td></tr>
                  ) : null}
                </Fragment>
              ))}
              {!rows.length ? <tr style={{ cursor: 'default' }}><td colSpan={7} className="muted" style={{ textAlign: 'center', padding: 26 }}>没有亲情车登记</td></tr> : null}
            </tbody>
          </table>
        </div>
      )}
      <div className="note2" style={{ marginTop: 12 }}><Icon name="alert" />亲情车不收费、每次有效一年；到期前 30 天提醒，到期自动停用车库权限。新登记在收银台「停车缴费 → 亲情车」生成二维码。</div>
    </>
  );
}
