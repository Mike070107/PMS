import { formatBeijingDateTime } from '@pms/shared-types';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router-dom';
import { can } from '@/lib/perm';
import './plate-review.css';
import { accessCardIssuance, request } from '@pms/api-client';
import Icon from '@/components/Icon';
import { dayjs, money } from '@/lib/format';
import { formBase, type Car, type Lot, type ParkHouse, type ParkingCart, type ParkRule, type ParkTarget } from './ParkingTab';

export interface IntakeFile { index: number; fileName: string; contentType: string; fileUrl: string; uploadedAt: string }
export interface Intake {
  id: number; kind: 'paid' | 'family'; status: 'waiting' | 'submitted' | 'reupload' | 'approved' | 'void';
  houseId: number; houseLabel: string; ownerName: string; ownerPhone: string;
  plate: string; contactName: string; contactPhone: string; relation: string; vehicleClass: string;
  garages: string[]; garageNumbers: Record<string, string>;
  expiresAt: string; qrValid: boolean; openedAt: string | null; submittedAt: string | null; reviewedAt: string | null; reviewNote: string;
  files: IntakeFile[];
  transaction: { id: number; txnNo: string; amountCents: number; startDate: string | null; endDate: string | null; externalSyncStatus: string; execution: { lastError?: string | null } | null } | null;
  familyCarId: number | null;
  createdAt: string;
  qr?: { url: string; dataUrl: string; expiresAt: string };
  log?: Array<{ at: string; userName: string; action: string; note?: string }>;
}

export const INTAKE_STATUS: Record<Intake['status'], [string, string]> = {
  waiting: ['等业主扫码填写', 'warn'], submitted: ['待审核资料', 'warn'], reupload: ['已退回，等业主重传', 'warn'],
  approved: ['资料已通过', 'ok'], void: ['已作废', 'mute'],
};
export const TXN_STATUS: Record<string, string> = {
  awaiting_docs: '款已收，等资料审核通过', review: '金额待物业经理审核', queued: '排队办理中', running: '办理中', retry: '等待自动重试',
  synced: '已生效', dry_run: '演练完成（未真正写入）', manual: '需人工办理', failed: '办理失败', rejected: '经理驳回', mocked: '已登记',
};
export const RELATIONS = ['父母', '子女', '配偶', '兄弟姐妹', '祖父母/外祖父母', '孙子女/外孙子女', '其他亲属'];
const FAMILY_GARAGES: Array<[string, string]> = [['phase1', '一期地面'], ['phase2', '二期地面'], ['main', '二期大车库'], ['civil', '二期人防车库']];
const isImg = (f: IntakeFile) => f.contentType.startsWith('image/');
let targetsCache: Promise<ParkTarget[]> | null = null;
/** 停车场目录（静态，按小区过滤），整个页面只拉一次 */
const loadTargets = () => (targetsCache ??= request<ParkTarget[]>({ url: '/business/parking-targets' }).catch((e) => { targetsCache = null; throw e; }));
export const hm = (v: string | null) => (v ? formatBeijingDateTime(v, 'HH:mm') : '');

/** 原附件不改写；只有图片进入预览，PDF 等仍直接打开原 URL。 */
function FileThumb({ file }: { file: IntakeFile }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [file.fileUrl]);
  return failed ? <span className="np-thumb-error"><Icon name="file" size={22} />图片未加载</span>
    : <img src={file.fileUrl} alt="" loading="lazy" onError={() => setFailed(true)} />;
}

function ImagePreview({ files, initialIndex, title, onClose }: { files: IntakeFile[]; initialIndex: number; title: string; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [index, setIndex] = useState(initialIndex);
  const [zoom, setZoom] = useState(1);
  const [failed, setFailed] = useState(false);
  const stage = useRef<HTMLDivElement>(null);
  const file = files[index];
  const move = (step: number) => setIndex((n) => (n + step + files.length) % files.length);
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const el = dialog.current;
    const overflow = document.body.style.overflow;
    el?.showModal(); // Native modal makes the rest of the document inert and confines Tab focus.
    document.body.style.overflow = 'hidden';
    return () => { el?.close(); document.body.style.overflow = overflow; if (opener?.isConnected) opener.focus({ preventScroll: true }); };
  }, []);
  useEffect(() => { setZoom(1); setFailed(false); stage.current?.scrollTo(0, 0); }, [index]);
  return createPortal(
    <dialog ref={dialog} className="np-image-preview" aria-label={title} onCancel={(e) => { e.preventDefault(); onClose(); }}
      onClick={(e) => { if (e.target === e.currentTarget) { const r = e.currentTarget.getBoundingClientRect(); if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) onClose(); } }}
      onKeyDown={(e) => {
        if (e.key === 'Tab') {
          const controls = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), a[href]'));
          const first = controls[0]; const last = controls[controls.length - 1];
          if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
          else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
        }
        if (files.length > 1 && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) { e.preventDefault(); move(e.key === 'ArrowLeft' ? -1 : 1); }
      }}>
      <div className="np-preview-shell">
        <header className="np-preview-header"><div><b>{title}</b><span>{file.fileName}</span></div><button type="button" className="btn" onClick={onClose} autoFocus aria-label="关闭图片预览"><Icon name="x" size={20} /></button></header>
        <div className="np-preview-tools" role="group" aria-label="图片缩放">
          <button type="button" className="btn" aria-label="缩小图片" disabled={zoom <= 0.5 || failed} onClick={() => setZoom((n) => Math.max(0.5, n - 0.25))}>−</button>
          <output aria-live="polite" aria-label="缩放比例">{Math.round(zoom * 100)}%</output>
          <button type="button" className="btn" aria-label="放大图片" disabled={zoom >= 3 || failed} onClick={() => setZoom((n) => Math.min(3, n + 0.25))}>＋</button>
          <button type="button" className="btn" onClick={() => { setZoom(1); stage.current?.scrollTo(0, 0); }}>适应窗口</button>
          <a className="btn" href={file.fileUrl} target="_blank" rel="noreferrer">打开原图</a>
        </div>
        <div className="np-preview-stage" ref={stage}>
          {failed ? <div className="np-preview-error" role="alert"><Icon name="alert" size={28} /><b>图片加载失败</b><span>可打开原图查看，或切换其他资料。</span></div>
            : <div className="np-preview-zoom" style={{ width: `${zoom * 100}%`, height: `${zoom * 100}%` }}><img key={file.fileUrl} src={file.fileUrl} alt={file.fileName} onError={() => setFailed(true)} /></div>}
        </div>
        <footer className="np-preview-footer">
          {files.length > 1 ? <><button type="button" className="btn" onClick={() => move(-1)} aria-label="上一张">上一张</button><span aria-live="polite">{index + 1} / {files.length}</span><button type="button" className="btn" onClick={() => move(1)} aria-label="下一张">下一张</button></> : <span>单张图片</span>}
          <span className="np-preview-hint">Esc 关闭{files.length > 1 ? ' · ← → 切换' : ''} · 放大后可滚动查看</span>
        </footer>
      </div>
    </dialog>, document.body,
  );
}

/** 一条新办车牌 / 亲情车扫码登记：二维码 → 实时看业主填写 → 审核 → （付费车）收款 */
export default function NewPlateCard({ intake: it, house, targets: targetsProp, onChange, onDrop, onCart, renewal, manage = false }: {
  intake: Intake; house: ParkHouse; rules: ParkRule[]; targets: ParkTarget[];
  onChange: (x: Intake) => void; onDrop: (id: number) => void;
  onCart: (key: string, c: ParkingCart | null) => void;
  renewal: (car: Car, label: string, vehicleClass: string, onClass: (v: string) => Promise<void>) => ReactNode;
  /** 车牌登记审核页：审核、选授权车库、看日志；收款仍在收银台。 */
  manage?: boolean;
}) {
  const [qr, setQr] = useState(it.qr ?? null);
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const [note, setNote] = useState('');
  const [ask, setAsk] = useState<'' | 'reupload' | 'void'>('');
  const [converting, setConverting] = useState(false);
  const [kindNote, setKindNote] = useState('');
  const [kindRelation, setKindRelation] = useState(it.relation);
  // Synchronous lock also covers two clicks before React paints disabled controls.
  // Epochs discard GETs started before a mutation, including old-kind polls.
  const operation = useRef('');
  const epoch = useRef(0);
  const savingGarage = useRef(false);
  const allowInitialPaidDefault = useRef(it.kind === 'paid');
  const finalized = it.status === 'approved' && (it.kind === 'family' || !!it.transaction);
  const canConvert = can('business', 'edit') && it.status !== 'void' && !finalized && !it.transaction && !it.familyCarId;
  const handedOff = !!it.familyCarId || finalized || (!!it.transaction && !['awaiting_docs', 'review'].includes(it.transaction.externalSyncStatus));
  const canVoid = can('business', 'edit') && it.status !== 'void' && !handedOff;
  const [edit, setEdit] = useState({ plate: it.plate, contactName: it.contactName, contactPhone: it.contactPhone, relation: it.relation });
  const acceptResponse = (x: Intake) => {
    const nextQr = x.status === 'void' || x.qrValid === false ? null : x.qr ?? qr;
    setQr(nextQr);
    onChange({ ...x, log: x.log ?? it.log, qr: nextQr ?? undefined });
  };
  // 本小区的停车场：直接读停车场目录（瞬时），不等「这一户的车」查询（德立云 + 现场库要十几秒）
  const community = it.houseLabel.split('/')[0];
  const [catalog, setCatalog] = useState<ParkTarget[] | null>(null);
  useEffect(() => { void loadTargets().then(setCatalog).catch(() => setCatalog([])); }, []);
  const targets = useMemo(() => {
    const own = (catalog ?? []).filter((t) => (t as ParkTarget & { communities?: string[] }).communities?.includes(community));
    return own.length ? own : targetsProp;
  }, [catalog, community, targetsProp]);
  const [picked, setPicked] = useState<string[]>(() => (it.garages.length ? it.garages : it.kind === 'family' ? [String(house.lane || '').includes('198') ? 'phase1' : 'phase2'] : []));
  const [nums, setNums] = useState<Record<string, string>>(it.garageNumbers || {});
  const canEditGarages = it.status !== 'void' && !(it.kind === 'family' && it.status === 'approved') && !(it.kind === 'paid' && it.transaction);
  const [savingGarages, setSavingGarages] = useState(false);
  const [garageError, setGarageError] = useState('');
  // 选的车库存到登记单上：收银台和车牌登记审核看到的是同一份。
  // 保存期间暂禁下一次选择，避免并行 POST 乱序覆盖；失败保留选择并提供原样重试。
  const saveGarages = (next: string[], n = nums) => {
    if (operation.current || savingGarage.current || !canEditGarages) return;
    const version = ++epoch.current;
    savingGarage.current = true;
    setPicked(next); setSavingGarages(true); setGarageError('');
    void request<Intake>({ method: 'POST', url: `/vehicle-intakes/${it.id}/garages`, data: { garages: next, garageNumbers: n } })
      .then((x) => { if (version === epoch.current) acceptResponse(x); })
      .catch((e) => { if (version === epoch.current) setGarageError(e instanceof Error ? e.message : '车库保存失败，请重试'); })
      .finally(() => { savingGarage.current = false; setSavingGarages(false); });
  };
  // 二期大车库 / 人防都在二期小区内，进库先过二期地面：选它们自动带上 phase2，取消 phase2 连带取消
  const togglePick = (k: string) => {
    const has = picked.includes(k);
    let next = has ? picked.filter((x) => x !== k) : [...picked, k];
    if (!has && (k === 'main' || k === 'civil') && !next.includes('phase2')) next = [...next, 'phase2'];
    if (has && k === 'phase2') next = next.filter((x) => x !== 'main' && x !== 'civil');
    void saveGarages(next);
  };
  // 付费车还没选过车库：目录到了默认选第一个（一般是地面车库），前台可再改
  useEffect(() => { if (allowInitialPaidDefault.current && it.kind === 'paid' && !picked.length && !it.garages.length && targets.length && canEditGarages) saveGarages([targets[0].key]); }, [targets.length]); // eslint-disable-line react-hooks/exhaustive-deps
  const [, tick] = useState(0);
  const key = `新办#${it.id}`;

  // 业主填写是实时的：等扫码 / 等审核 / 等办理时每 3 秒刷新
  const live = it.status !== 'void' && (['waiting', 'submitted', 'reupload'].includes(it.status) || (it.kind === 'paid' && !it.transaction) || ['awaiting_docs', 'queued', 'running'].includes(it.transaction?.externalSyncStatus || ''));
  useEffect(() => {
    if (!live) return;
    const t = window.setInterval(() => {
      if (operation.current || savingGarage.current) return;
      const version = epoch.current;
      request<Intake>({ url: `/vehicle-intakes/${it.id}` }).then((x) => {
        if (version === epoch.current && !operation.current && !savingGarage.current) acceptResponse(x);
      }).catch(() => undefined);
      tick((n) => n + 1);
    }, 3000);
    return () => window.clearInterval(t);
  }, [it.id, live, qr]); // eslint-disable-line react-hooks/exhaustive-deps
  // 业主提交后，把填的内容带进可更正的输入框
  useEffect(() => { if (!operation.current) setEdit({ plate: it.plate, contactName: it.contactName, contactPhone: it.contactPhone, relation: it.relation }); }, [it.submittedAt]); // eslint-disable-line react-hooks/exhaustive-deps
  // 收过款 / 作废后，从收款车里拿掉
  useEffect(() => { if (it.transaction || it.status === 'void' || it.kind === 'family') onCart(key, null); }, [it.transaction?.id, it.status, it.kind]); // eslint-disable-line react-hooks/exhaustive-deps

  const expired = dayjs(it.expiresAt).isBefore(dayjs());
  const canQr = ['waiting', 'reupload'].includes(it.status);
  const lots = useMemo<Lot[]>(() => targets.filter((t) => picked.includes(t.key)).map((t) => ({
    key: t.key, system: t.system, label: t.label, targetKey: t.key, space: null, spaceFromNote: false, endDate: null, garages: [],
    ref: t.system === 'local'
      ? { kind: 'local' as const, database: (t.database || 'parking2') as 'parking1' | 'parking2', sourceRecordId: '', previousEndDate: null, label: t.label }
      : { kind: 'deliyun' as const, park: t.deliyunPark || '', label: t.label },
  })), [targets, picked]);
  const car: Car = { plate: key, identity: null, lots };

  const call = async (label: string, fn: () => Promise<Intake>, rethrow = false) => {
    if (operation.current || savingGarage.current) return;
    operation.current = label; ++epoch.current;
    setBusy(label); setErr('');
    try { const x = await fn(); acceptResponse(x); if (label !== '显示二维码') { setAsk(''); setNote(''); } }
    catch (e) { setErr(e instanceof Error ? e.message : `${label}失败`); if (rethrow) throw e; }
    finally { operation.current = ''; setBusy(''); }
  };
  const setClass = async (v: string) => {
    if (it.kind !== 'paid' || it.status === 'void' || it.transaction) return;
    await call('保存价格分类', () => request<Intake>({ method: 'POST', url: `/vehicle-intakes/${it.id}/class`, data: { vehicleClass: v } }), true);
  };
  const convertKind = async () => {
    if (!canConvert || operation.current || savingGarage.current || !kindNote.trim() || (it.kind === 'paid' && !kindRelation.trim())) return;
    if (!window.confirm('确认转换登记类型？已上传资料及联系人会保留；原车库授权、车位号和价格分类将清空，已审核资料须重新审核。转为亲情车后仍需旧库查重和经理审核，不会自动开通。')) return;
    operation.current = '转换登记类型'; ++epoch.current;
    setBusy('转换登记类型'); setErr('');
    try {
      const x = await request<Intake>({ method: 'POST', url: `/vehicle-intakes/${it.id}/kind`, data: {
        kind: it.kind === 'paid' ? 'family' : 'paid', note: kindNote.trim(), ...(it.kind === 'paid' ? { relation: kindRelation.trim() } : {}),
      } });
      // Do not mirror every poll into these drafts: failed selections must survive.
      // Only a successful conversion deliberately replaces old-kind local state.
      allowInitialPaidDefault.current = false;
      setPicked(x.garages ?? []); setNums(x.garageNumbers ?? {}); setGarageError('');
      setEdit({ plate: x.plate, contactName: x.contactName, contactPhone: x.contactPhone, relation: x.relation });
      setKindRelation(x.relation); setKindNote(''); setConverting(false); setAsk(''); setNote('');
      onCart(key, null); acceptResponse(x);
    } catch (e) { setErr(e instanceof Error ? e.message : '登记类型转换失败，请重试'); }
    finally { operation.current = ''; setBusy(''); }
  };
  const [preview, setPreview] = useState<{ files: IntakeFile[]; index: number; title: string } | null>(null);
  const images = it.files.filter(isImg);
  const previewQr = () => { if (qr) setPreview({ files: [{ index: -1, fileName: `${it.kind === 'family' ? '亲情车登记' : '新车登记'} · ${it.houseLabel} · ${hm(it.expiresAt)} 前有效`, contentType: 'image/png', fileUrl: qr.dataUrl, uploadedAt: '' }], index: 0, title: '扫码登记二维码' }); };
  const toastOk = (t: string) => { setErr(''); setOkMsg(t); window.setTimeout(() => setOkMsg(''), 1800); };
  const [okMsg, setOkMsg] = useState('');
  // 刷新页面 / 换了电脑后：没过期就再显示同一个码（业主之前拍下的码继续有效），不换码
  // 显示失败（码已过期 / 被换掉 / 更新前生成的旧登记）就只能重新生成，按钮随之切换
  const [qrGone, setQrGone] = useState(false);
  const showQr = async () => {
    if (it.status === 'void' || operation.current || savingGarage.current) return;
    operation.current = '显示二维码'; ++epoch.current;
    setBusy('显示二维码'); setErr(''); setQrGone(false);
    try { const x = await request<Intake>({ method: 'POST', url: `/vehicle-intakes/${it.id}/show-qr`, data: { formBase: formBase() } }); acceptResponse(x); }
    catch { setQrGone(true); }
    finally { operation.current = ''; setBusy(''); }
  };
  useEffect(() => {
    if (!qr && ['waiting', 'reupload'].includes(it.status) && !dayjs(it.expiresAt).isBefore(dayjs())) showQr();
  }, [it.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const regenerate = () => call('生成二维码', () => request<Intake>({ method: 'POST', url: `/vehicle-intakes/${it.id}/qr`, data: { formBase: formBase() } }));
  const review = (decision: 'approve' | 'reupload' | 'void', extra: Record<string, unknown> = {}) => {
    if (it.status === 'void' || operation.current || savingGarage.current) return;
    if (decision === 'void' && (!canVoid || !note.trim() || !window.confirm(it.transaction ? '确认只作废本条登记？不会退款，原收款与财务流水保留并转待处理，请联系财务核对。' : '确认撤销 / 作废本条登记？业主二维码将立即失效，资料和审计日志保留。'))) return;
    return call(decision === 'approve' ? '审核' : decision === 'void' ? '作废' : '退回', () => request<Intake>({ method: 'POST', url: `/vehicle-intakes/${it.id}/review`, data: decision === 'void' ? { decision, note: note.trim() } : {
      decision, note: note.trim() || undefined, ...edit, garages: picked, garageNumbers: nums, ...extra,
    } }));
  };
  const approve = async () => {
    if (operation.current || savingGarage.current || garageError || !picked.length || it.status === 'void') return;
    if (it.kind === 'paid') return review('approve');
    if (!edit.relation.trim() || edit.relation === '其他亲属') { setErr('请填写与业主的具体关系后再审核'); return; }
    // 亲情车：先在旧停车库按车牌查重（现场助手，约 5–20 秒）
    operation.current = '旧库查重'; ++epoch.current;
    setBusy('旧库查重'); setErr('');
    try {
      let q = await accessCardIssuance.createParkingQuery(edit.plate.replace(/[\s·.．・]/g, '').toUpperCase());
      for (let i = 0; i < 24 && (q.status === 'pending' || q.status === 'running'); i += 1) {
        await new Promise((ok) => window.setTimeout(ok, 1500));
        q = await accessCardIssuance.parkingQuery(q.id);
      }
      if (q.status !== 'completed') throw new Error(q.status === 'failed' ? (q.error || '旧库查重失败') : '现场停车库 35 秒内没有回应，现场电脑可能不在线，请稍后再点');
      operation.current = ''; setBusy('');
      await review('approve', { duplicateCheckQueryId: q.id });
    } catch (e) { operation.current = ''; setErr(e instanceof Error ? e.message : '旧库查重失败'); setBusy(''); }
  };

  const [stLabel, stTone] = INTAKE_STATUS[it.status];
  const reviewed = it.status === 'approved';
  const sync = it.transaction?.externalSyncStatus;
  const steps = [
    { label: '扫码', state: it.openedAt ? 'done' : 'pending', detail: it.openedAt ? '已打开' : it.submittedAt ? '未记录扫码时间' : '等待扫码', at: it.openedAt },
    { label: '填写上传', state: it.status === 'reupload' ? 'attention' : it.submittedAt ? 'done' : 'pending', detail: it.status === 'reupload' ? '待重新上传' : it.submittedAt ? '已提交' : '待填写上传', at: it.submittedAt },
    { label: '办公室审核', state: reviewed ? 'done' : ['reupload', 'void'].includes(it.status) ? 'attention' : 'pending', detail: reviewed ? '已通过' : it.status === 'reupload' ? '已退回' : it.status === 'void' ? '已作废' : '待办公室审核', at: it.reviewedAt },
    { label: it.kind === 'family' ? '经理审核 · 开通' : '收款 · 开通', state: it.status === 'void' ? 'attention' : sync === 'synced' ? 'done' : ['failed', 'rejected', 'manual'].includes(sync || '') ? 'attention' : 'pending', detail: it.status === 'void' ? '登记已作废' : it.kind === 'family' ? (it.familyCarId ? '已转登记 · 待经理审核' : '待经理审核') : it.transaction ? `已收款 · ${TXN_STATUS[sync || ''] || sync}` : '未收款', at: null },
  ];
  return (
    <div className="card np-card np-review">
      {preview ? <ImagePreview files={preview.files} initialIndex={preview.index} title={preview.title} onClose={() => setPreview(null)} /> : null}
      <div className="side-h" style={{ marginBottom: 10 }}>
        <Icon name="car" size={18} />{it.kind === 'family' ? '亲情车登记' : '新办车牌'}
        {it.plate ? <b className="plate" style={{ marginLeft: 6 }}>{it.plate}</b> : null}
        <span className={`tag ${stTone}`} style={{ marginLeft: 8 }}>{stLabel}</span>
        {it.kind === 'family' ? <span className="tag mute" style={{ marginLeft: 6 }}>免费 · 有效期一年</span> : it.vehicleClass ? <span className="tag acc" style={{ marginLeft: 6 }}>{it.vehicleClass}</span> : null}
        <span style={{ marginLeft: 'auto' }} />
        {canVoid ? <button className="btn g sm" disabled={!!busy || savingGarages} onClick={() => { setConverting(false); setAsk(ask === 'void' ? '' : 'void'); }}>撤销 / 作废登记</button> : null}
        {it.status === 'void' || (it.status === 'approved' && (it.kind === 'family' || it.transaction)) ? <button className="btn g sm" onClick={() => onDrop(it.id)} title="从这里收起（车牌登记审核里仍可查）">✕</button> : null}
      </div>

      <div className="note2" style={{ marginBottom: 10, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <b>登记类型：{it.kind === 'family' ? '亲情车（免费，需关系及经理审核）' : '付费月租车'}</b>
        <span className="muted">与缴费价格分类不同</span>
        {canConvert ? <button type="button" className="btn sm" disabled={!!busy || savingGarages} onClick={() => { setConverting(!converting); setAsk(''); }}>{it.kind === 'paid' ? '转为亲情车登记' : '转为付费车登记'}</button> : null}
        {it.status !== 'void' && (it.transaction || it.familyCarId) ? <span className="muted">已关联财务或办理，不能转换登记类型。</span> : null}
      </div>
      {converting && canConvert ? <fieldset className="np-garages" disabled={!!busy || savingGarages}>
        <legend>转换登记类型</legend>
        <p className="np-garage-help">保留上传资料、联系人及审计日志；清空原车库、车位号和价格分类，已审核资料须重审。亲情车仍须填写具体关系、旧库查重并走经理审核，不会自动开通。</p>
        <div className="np-fields">
          {it.kind === 'paid' ? <label>转换后与业主关系<input className="in" value={kindRelation} maxLength={12} placeholder="如父母、子女、表姐" onChange={(e) => setKindRelation(e.target.value)} /></label> : null}
          <label>转换原因<input className="in" value={kindNote} maxLength={500} onChange={(e) => setKindNote(e.target.value)} /></label>
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
          <button type="button" className="btn p" disabled={!!busy || savingGarages || !kindNote.trim() || (it.kind === 'paid' && (!kindRelation.trim() || kindRelation.trim() === '其他亲属'))} onClick={convertKind}>{busy === '转换登记类型' ? '转换中…' : '确认转换登记类型'}</button>
          <button type="button" className="btn" onClick={() => setConverting(false)}>暂不转换</button>
        </div>
      </fieldset> : null}
      {it.status !== 'void' && handedOff ? <div className="note2" style={{ marginBottom: 10 }}>{it.familyCarId || (it.kind === 'family' && it.status === 'approved') ? '已转亲情车办理，请到「亲情车管理」核对；' : '原收款已进入执行或待核对阶段，请到「待处理」核对原流水；'}已入库车辆请到「车辆管理」注销，不在登记审核硬删，也不在这里退款。</div> : null}
      <ol className="np-steps np-review-steps" aria-label="车牌登记办理流程">
        {steps.map((step, i) => <li key={step.label} data-state={step.state}>
          <span className="np-step-heading"><span className="np-step-number" aria-hidden="true">{i + 1}</span><b>{step.label}</b></span>
          <span className="np-step-detail">{step.detail}</span>
          {step.at ? <time dateTime={step.at} title={formatBeijingDateTime(step.at, 'YYYY-MM-DD HH:mm:ss')}>{formatBeijingDateTime(step.at, 'MM-DD HH:mm')}</time> : <span className="np-step-time">{i === 3 && sync === 'synced' ? '接口未提供开通时间' : '—'}</span>}
          {i < 3 ? <span className="np-step-arrow" aria-hidden="true">→</span> : null}
        </li>)}
      </ol>
      <div className="np-grid">
        {/* 左：二维码 / 业主进度 */}
        <div className="np-qr">
          {canQr && qr && !expired ? (
            <>
              <button type="button" className="np-qr-trigger" onClick={previewQr} aria-label="放大扫码登记二维码"><img src={qr.dataUrl} alt="扫码填写" title="点击放大，方便业主扫码或拍照" /></button>
              <div className="muted" style={{ fontSize: 13 }}>有效至 {hm(it.expiresAt)} · 业主可拍下二维码回家再扫，同一个码到时前一直能用</div>
              <div style={{ display: 'flex', gap: 6, justifyContent: 'center', marginTop: 4 }}>
                <button className="btn g sm" onClick={previewQr}>放大</button>
                <button className="btn g sm" onClick={() => { void navigator.clipboard?.writeText(qr.url); toastOk('链接已复制'); }}>复制链接</button>
                <button className="btn g sm" disabled={!!busy} onClick={() => { if (window.confirm('换新码后，业主之前拍下 / 收到的二维码会立即作废。确定换吗？')) regenerate(); }}>换新码</button>
              </div>
            </>
          ) : canQr ? (
            <div className="np-qr-empty">
              <Icon name="qr" size={34} />
              <div className="muted" style={{ fontSize: 13.5, padding: '0 8px' }}>{expired ? '二维码已过期' : qrGone ? '原二维码无法再显示，请重新生成（业主手上的旧码会作废）' : busy === '显示二维码' ? '正在读取二维码…' : '二维码没有读取到'}</div>
              {expired || qrGone
                ? <button className="btn sm" disabled={!!busy} onClick={regenerate}>{busy === '生成二维码' ? '生成中…' : '重新生成二维码'}</button>
                : <button className="btn sm" disabled={!!busy} onClick={showQr}>再显示二维码</button>}
            </div>
          ) : (
            <div className="np-qr-empty"><Icon name={it.status === 'void' ? 'x' : 'check'} size={30} /><div className="muted" style={{ fontSize: 13.5 }}>{it.status === 'void' ? '已作废' : '资料已收齐'}</div></div>
          )}
        </div>

        {/* 右：业主填写内容 + 审核 */}
        <div>
          {it.status === 'reupload' && it.reviewNote ? <div className="note2" style={{ marginBottom: 8 }}><Icon name="alert" />已退回：{it.reviewNote}</div> : null}

          {it.submittedAt ? (
            <>
              <div className="np-fields">
                <label>车牌<input className="in" value={edit.plate} disabled={!!busy || !['submitted', 'reupload'].includes(it.status)} onChange={(e) => setEdit({ ...edit, plate: e.target.value.toUpperCase() })} /></label>
                <label>车主（选填）<input className="in" value={edit.contactName} disabled={!!busy || !['submitted', 'reupload'].includes(it.status)} onChange={(e) => setEdit({ ...edit, contactName: e.target.value })} /></label>
                <label>手机<input className="in" value={edit.contactPhone} disabled={!!busy || !['submitted', 'reupload'].includes(it.status)} onChange={(e) => setEdit({ ...edit, contactPhone: e.target.value })} /></label>
                {it.kind === 'family' ? (
                  <label>与业主关系<select aria-label="与业主关系" className="in" value={edit.relation} disabled={!!busy || !['submitted', 'reupload'].includes(it.status)} onChange={(e) => setEdit({ ...edit, relation: e.target.value })}>
                    <option value="">请选择</option>{[...RELATIONS, ...(edit.relation && !RELATIONS.includes(edit.relation) ? [edit.relation] : [])].map((r) => <option key={r}>{r}</option>)}
                  </select></label>
                ) : null}
              </div>
              <div className="np-files">
                {it.files.map((f) => (
                  isImg(f) ? <button type="button" key={f.index} className="np-file-trigger" title={f.fileName} aria-label={`预览图片：${f.fileName}`} onClick={() => setPreview({ files: images, index: images.indexOf(f), title: '登记资料图片预览' })}><FileThumb file={f} /><span className="np-file-caption">{f.fileName}</span></button>
                    : <a key={f.index} href={f.fileUrl} target="_blank" rel="noreferrer" title={f.fileName} aria-label={`打开原附件：${f.fileName}`}><span className="np-pdf"><Icon name="file" size={22} />{f.contentType === 'application/pdf' ? 'PDF' : '附件'}</span><span className="np-file-caption">{f.fileName}</span></a>
                ))}
              </div>
            </>
          ) : <div className="muted" style={{ padding: '6px 0 10px' }}>业主填好后这里会实时显示车牌、电话和上传的资料</div>}

          {/* 开通哪些车库 */}
          {!canEditGarages && picked.length ? (
            <div style={{ marginTop: 6, fontSize: 14 }}><span style={{ color: 'var(--ink2)' }}>开通车库：</span>{picked.map((k) => <span key={k} className="tag mute" style={{ marginRight: 4 }}>{(it.kind === 'family' ? FAMILY_GARAGES.find(([x]) => x === k)?.[1] : (targets.find((t) => t.key === k)?.short || targets.find((t) => t.key === k)?.label)) || k}{nums[k] ? ` ${nums[k]}` : ''}</span>)}</div>
          ) : null}
          {canEditGarages ? (
            <fieldset className="np-garages" aria-busy={savingGarages}>
              <legend>开通车库授权 <span>可多选</span></legend>
              <p className="np-garage-help">大车库、人防车库需同时授权二期地面；取消二期地面会一并取消这两项。</p>
              <div className="np-garage-options">
                {(it.kind === 'family' ? FAMILY_GARAGES : targets.map((t) => [t.key, t.short || t.label.replace(`${community} `, '')])).map(([k, label]) => (
                  <label key={k} className={`np-garage-option ${picked.includes(k) ? 'is-checked' : ''}`}>
                    <input type="checkbox" checked={picked.includes(k)} disabled={savingGarages || !!busy} onChange={() => togglePick(k)} /><span>{label}</span>
                  </label>
                ))}
                {it.kind === 'paid' && !targets.length ? <span className="muted">{catalog === null ? '正在读取本小区停车场…' : '本小区没有接入停车系统'}</span> : null}
              </div>
              {it.kind === 'family' ? <div className="np-garage-numbers">{['main', 'civil'].filter((k) => picked.includes(k)).map((k) => (
                <label key={k}>{k === 'main' ? '大车库车库号' : '人防车位号'}<input className="in" value={nums[k] || ''} disabled={savingGarages || !!busy} onChange={(e) => setNums({ ...nums, [k]: e.target.value })} onBlur={() => saveGarages(picked, nums)} /></label>
              ))}</div> : null}
              <div className="np-garage-status" role="status">{savingGarages ? '正在保存授权…' : garageError ? <><span>{garageError}</span><button type="button" className="btn" disabled={!!busy || savingGarages} onClick={() => saveGarages(picked, nums)}>重试保存授权</button></> : `已选择 ${picked.length} 个车库`}</div>
            </fieldset>
          ) : null}

          {/* 审核 */}
          {['submitted', 'reupload'].includes(it.status) && it.submittedAt ? (
            <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
              <button className="btn p" disabled={!!busy || savingGarages || !!garageError || !picked.length || (it.kind === 'family' && (!edit.relation.trim() || edit.relation === '其他亲属'))} onClick={approve}><Icon name="check" size={16} />{busy === '旧库查重' ? '旧库查重中…' : busy === '审核' ? '提交中…' : '资料无误，通过'}</button>
              <button className="btn" disabled={!!busy} onClick={() => setAsk(ask === 'reupload' ? '' : 'reupload')}>退回重传</button>
            </div>
          ) : null}
          {ask && it.status !== 'void' ? (
            <div style={{ marginTop: 8 }}>
              {ask === 'void' ? <p className="np-garage-help">{it.transaction ? '这里只作废登记，不会退款；保留原收款及流水，转财务待处理，请联系财务核对。' : '作废后业主二维码失效，保留资料和审计日志。'}</p> : null}
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'end' }}>
                <label style={{ flex: '1 1 180px', minWidth: 0 }}>{ask === 'void' ? '作废原因' : '退回原因'}<input className="in" style={{ width: '100%' }} autoFocus value={note} disabled={!!busy} onChange={(e) => setNote(e.target.value)} placeholder={ask === 'void' ? '必填，记入日志' : '要业主补什么，例如：行驶证照片看不清'} /></label>
                <button className={`btn ${ask === 'void' ? 'd' : 'p'}`} disabled={!!busy || savingGarages || !note.trim()} onClick={() => review(ask)}>{ask === 'void' ? '确认作废' : '退回'}</button>
                <button type="button" className="btn" disabled={!!busy} onClick={() => setAsk('')}>取消操作</button>
              </div>
            </div>
          ) : null}
          {err ? <div className="note2" role="alert" style={{ color: 'var(--dang)', marginTop: 8 }}><Icon name="alert" />{err}</div> : null}
          {okMsg ? <div className="note2" style={{ marginTop: 8 }}><Icon name="check" />{okMsg}</div> : null}

          {/* 结果 */}
          {it.kind === 'family' && it.status === 'approved' ? <div className="note2" style={{ marginTop: 10 }}><Icon name="check" />已转亲情车登记，等物业经理审核后自动开通车库并续期一年；进度在「车牌登记审核」。</div> : null}
          {it.transaction ? (
            <div className="note2" style={{ marginTop: 10, display: 'block' }}>
              <Icon name="cash" />已收款 <b className="money">{money(it.transaction.amountCents / 100)}</b>（{it.transaction.startDate} 至 {it.transaction.endDate}）· {TXN_STATUS[it.transaction.externalSyncStatus] || it.transaction.externalSyncStatus}
              {it.status === 'void' ? <div style={{ marginTop: 4 }}>登记已作废，未执行退款；原收款及流水保留，财务待处理，请联系财务核对。</div> : null}
              {it.transaction.execution?.lastError ? <div style={{ color: 'var(--dang)', marginTop: 4 }}>{it.transaction.execution.lastError}</div> : null}
            </div>
          ) : null}
        </div>
      </div>

      {/* 付费车：选月数收款（资料没齐也可以先收，挂待处理） */}
      {manage && it.log?.length ? (
        <ol className="np-log">{[...it.log].reverse().map((l, i) => <li key={i}><time>{formatBeijingDateTime(l.at, 'MM-DD HH:mm')}</time><b>{l.userName}</b>{l.action}{l.note ? <small> · {l.note}</small> : null}</li>)}</ol>
      ) : null}
      {manage && it.kind === 'paid' && !it.transaction && it.status !== 'void' ? <div className="muted" style={{ marginTop: 8 }}>还没收款：<Link className="btn sm" to={`/cashier?intakeId=${it.id}`}>去收银台处理此登记</Link>（定位原登记，不新建计费业务）</div> : null}
      {!manage && it.kind === 'paid' && !it.transaction && it.status !== 'void' ? (
        <div style={{ marginTop: 12 }}>
          {lots.length ? renewal(car, it.plate ? `${it.plate}（新办）` : `新办车牌 #${it.id}`, it.vehicleClass, setClass) : <div className="muted">先选要开通的车库，再选月数收款</div>}
          {it.status !== 'approved' ? <div className="muted" style={{ fontSize: 13.5, marginTop: 6 }}>资料还没审核通过也可以先收款：款挂「待处理」，业主提交并审核通过后自动办理。</div> : null}
        </div>
      ) : null}
    </div>
  );
}
