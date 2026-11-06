import { useEffect, useMemo, useState, type ReactNode } from 'react';
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
export const hm = (v: string | null) => (v ? dayjs(v).format('HH:mm') : '');

/** 一条新办车牌 / 亲情车扫码登记：二维码 → 实时看业主填写 → 审核 → （付费车）收款 */
export default function NewPlateCard({ intake: it, house, targets: targetsProp, onChange, onDrop, onCart, renewal, manage = false }: {
  intake: Intake; house: ParkHouse; rules: ParkRule[]; targets: ParkTarget[];
  onChange: (x: Intake) => void; onDrop: (id: number) => void;
  onCart: (key: string, c: ParkingCart | null) => void;
  renewal: (car: Car, label: string, vehicleClass: string, onClass: (v: string) => Promise<void>) => ReactNode;
  /** 车牌登记审核页：只审核、看日志，不在这里选车库收款（收款在收银台） */
  manage?: boolean;
}) {
  const [qr, setQr] = useState(it.qr ?? null);
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const [note, setNote] = useState('');
  const [ask, setAsk] = useState<'' | 'reupload' | 'void'>('');
  const [edit, setEdit] = useState({ plate: it.plate, contactName: it.contactName, contactPhone: it.contactPhone, relation: it.relation });
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
  // 选的车库存到登记单上：收银台和车牌登记审核看到的是同一份
  const saveGarages = (next: string[], n = nums) => {
    setPicked(next);
    void request<Intake>({ method: 'POST', url: `/vehicle-intakes/${it.id}/garages`, data: { garages: next, garageNumbers: n } })
      .then((x) => onChange({ ...x, log: x.log ?? it.log, qr: qr ?? undefined })).catch((e) => setErr(e instanceof Error ? e.message : '车库保存失败'));
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
  useEffect(() => { if (it.kind === 'paid' && !picked.length && !it.garages.length && targets.length && canEditGarages) saveGarages([targets[0].key]); }, [targets.length]); // eslint-disable-line react-hooks/exhaustive-deps
  const [, tick] = useState(0);
  const key = `新办#${it.id}`;

  // 业主填写是实时的：等扫码 / 等审核 / 等办理时每 3 秒刷新
  const live = ['waiting', 'submitted', 'reupload'].includes(it.status) || (it.kind === 'paid' && !it.transaction && it.status !== 'void') || ['awaiting_docs', 'queued', 'running'].includes(it.transaction?.externalSyncStatus || '');
  useEffect(() => {
    if (!live) return;
    const t = window.setInterval(() => {
      request<Intake>({ url: `/vehicle-intakes/${it.id}` }).then((x) => onChange({ ...x, log: x.log ?? it.log, qr: qr ?? undefined })).catch(() => undefined);
      tick((n) => n + 1);
    }, 3000);
    return () => window.clearInterval(t);
  }, [it.id, live, qr]); // eslint-disable-line react-hooks/exhaustive-deps
  // 业主提交后，把填的内容带进可更正的输入框
  useEffect(() => { setEdit({ plate: it.plate, contactName: it.contactName, contactPhone: it.contactPhone, relation: it.relation }); }, [it.submittedAt]); // eslint-disable-line react-hooks/exhaustive-deps
  // 收过款 / 作废后，从收款车里拿掉
  useEffect(() => { if (it.transaction || it.status === 'void' || it.kind === 'family') onCart(key, null); }, [it.transaction?.id, it.status]); // eslint-disable-line react-hooks/exhaustive-deps

  const expired = dayjs(it.expiresAt).isBefore(dayjs());
  const canQr = ['waiting', 'reupload'].includes(it.status);
  const lots = useMemo<Lot[]>(() => targets.filter((t) => picked.includes(t.key)).map((t) => ({
    key: t.key, system: t.system, label: t.label, targetKey: t.key, space: null, spaceFromNote: false, endDate: null, garages: [],
    ref: t.system === 'local'
      ? { kind: 'local' as const, database: (t.database || 'parking2') as 'parking1' | 'parking2', sourceRecordId: '', previousEndDate: null, label: t.label }
      : { kind: 'deliyun' as const, park: t.deliyunPark || '', label: t.label },
  })), [targets, picked]);
  const car: Car = { plate: key, identity: null, lots };

  const call = async (label: string, fn: () => Promise<Intake>) => {
    setBusy(label); setErr('');
    try { const x = await fn(); if (x.qr) setQr(x.qr); onChange({ ...x, log: x.log ?? it.log, qr: x.qr ?? qr ?? undefined }); if (label !== '显示二维码') { setAsk(''); setNote(''); } }
    catch (e) { setErr(e instanceof Error ? e.message : `${label}失败`); }
    finally { setBusy(''); }
  };
  const setClass = async (v: string) => {
    const x = await request<Intake>({ method: 'POST', url: `/vehicle-intakes/${it.id}/class`, data: { vehicleClass: v } });
    onChange({ ...x, qr: qr ?? undefined });
  };
  const [big, setBig] = useState(false);
  const toastOk = (t: string) => { setErr(''); setOkMsg(t); window.setTimeout(() => setOkMsg(''), 1800); };
  const [okMsg, setOkMsg] = useState('');
  // 刷新页面 / 换了电脑后：没过期就再显示同一个码（业主之前拍下的码继续有效），不换码
  // 显示失败（码已过期 / 被换掉 / 更新前生成的旧登记）就只能重新生成，按钮随之切换
  const [qrGone, setQrGone] = useState(false);
  const showQr = async () => {
    setBusy('显示二维码'); setErr(''); setQrGone(false);
    try { const x = await request<Intake>({ method: 'POST', url: `/vehicle-intakes/${it.id}/show-qr`, data: { formBase: formBase() } }); if (x.qr) setQr(x.qr); onChange({ ...x, log: x.log ?? it.log, qr: x.qr ?? undefined }); }
    catch { setQrGone(true); }
    finally { setBusy(''); }
  };
  useEffect(() => {
    if (!qr && ['waiting', 'reupload'].includes(it.status) && !dayjs(it.expiresAt).isBefore(dayjs())) showQr();
  }, [it.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const regenerate = () => call('生成二维码', () => request<Intake>({ method: 'POST', url: `/vehicle-intakes/${it.id}/qr`, data: { formBase: formBase() } }));
  const review = (decision: 'approve' | 'reupload' | 'void', extra: Record<string, unknown> = {}) =>
    call(decision === 'approve' ? '审核' : decision === 'void' ? '作废' : '退回', () => request<Intake>({ method: 'POST', url: `/vehicle-intakes/${it.id}/review`, data: {
      decision, note: note.trim() || undefined, ...edit, garages: picked, garageNumbers: nums, ...extra,
    } }));
  const approve = async () => {
    if (it.kind === 'paid') return review('approve');
    // 亲情车：先在旧停车库按车牌查重（现场助手，约 5–20 秒）
    setBusy('旧库查重'); setErr('');
    try {
      let q = await accessCardIssuance.createParkingQuery(edit.plate.replace(/[\s·.．・]/g, '').toUpperCase());
      for (let i = 0; i < 24 && (q.status === 'pending' || q.status === 'running'); i += 1) {
        await new Promise((ok) => window.setTimeout(ok, 1500));
        q = await accessCardIssuance.parkingQuery(q.id);
      }
      if (q.status !== 'completed') throw new Error(q.status === 'failed' ? (q.error || '旧库查重失败') : '现场停车库 35 秒内没有回应，现场电脑可能不在线，请稍后再点');
      setBusy('');
      await review('approve', { duplicateCheckQueryId: q.id });
    } catch (e) { setErr(e instanceof Error ? e.message : '旧库查重失败'); setBusy(''); }
  };

  const [stLabel, stTone] = INTAKE_STATUS[it.status];
  return (
    <div className="card np-card">
      <div className="side-h" style={{ marginBottom: 10 }}>
        <Icon name="car" size={18} />{it.kind === 'family' ? '亲情车登记' : '新办车牌'}
        {it.plate ? <b className="plate" style={{ marginLeft: 6 }}>{it.plate}</b> : null}
        <span className={`tag ${stTone}`} style={{ marginLeft: 8 }}>{stLabel}</span>
        {it.kind === 'family' ? <span className="tag mute" style={{ marginLeft: 6 }}>免费 · 有效期一年</span> : it.vehicleClass ? <span className="tag acc" style={{ marginLeft: 6 }}>{it.vehicleClass}</span> : null}
        <span style={{ marginLeft: 'auto' }} />
        {it.status !== 'approved' && it.status !== 'void' ? <button className="btn g sm" onClick={() => setAsk(ask === 'void' ? '' : 'void')}>作废</button> : null}
        {it.status === 'void' || (it.status === 'approved' && (it.kind === 'family' || it.transaction)) ? <button className="btn g sm" onClick={() => onDrop(it.id)} title="从这里收起（车牌登记审核里仍可查）">✕</button> : null}
      </div>

      <div className="np-grid">
        {/* 左：二维码 / 业主进度 */}
        <div className="np-qr">
          {canQr && qr && !expired ? (
            <>
              <img src={qr.dataUrl} alt="扫码填写" style={{ cursor: 'zoom-in' }} onClick={() => setBig(true)} title="点击放大，方便业主扫码或拍照" />
              <div className="muted" style={{ fontSize: 13 }}>有效至 {hm(it.expiresAt)} · 业主可拍下二维码回家再扫，同一个码到时前一直能用</div>
              <div style={{ display: 'flex', gap: 6, justifyContent: 'center', marginTop: 4 }}>
                <button className="btn g sm" onClick={() => setBig(true)}>放大</button>
                <button className="btn g sm" onClick={() => { void navigator.clipboard?.writeText(qr.url); toastOk('链接已复制'); }}>复制链接</button>
                <button className="btn g sm" disabled={!!busy} onClick={() => { if (window.confirm('换新码后，业主之前拍下 / 收到的二维码会立即作废。确定换吗？')) regenerate(); }}>换新码</button>
              </div>
              {big ? (
                <div className="np-qr-big" onClick={() => setBig(false)}>
                  <div onClick={(e) => e.stopPropagation()}>
                    <img src={qr.dataUrl} alt="" />
                    <b>{it.kind === 'family' ? '亲情车登记' : '新车登记'} · {it.houseLabel}</b>
                    <span>请用手机扫码填写，{hm(it.expiresAt)} 前有效</span>
                    <button className="btn" onClick={() => setBig(false)}>关闭</button>
                  </div>
                </div>
              ) : null}
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
          <ol className="np-steps">
            <li className={it.openedAt || it.submittedAt ? 'on' : ''}>扫码{it.openedAt ? <small>{hm(it.openedAt)} 已打开</small> : <small>等待中</small>}</li>
            <li className={it.submittedAt ? 'on' : ''}>填写上传{it.submittedAt ? <small>{hm(it.submittedAt)} 已提交</small> : null}</li>
            <li className={it.status === 'approved' ? 'on' : ''}>办公室审核{it.reviewedAt ? <small>{hm(it.reviewedAt)}</small> : null}</li>
            <li className={it.kind === 'family' ? (it.familyCarId ? 'on' : '') : it.transaction ? 'on' : ''}>{it.kind === 'family' ? '经理审核 · 开通' : '收款 · 开通'}</li>
          </ol>
          {it.status === 'reupload' && it.reviewNote ? <div className="note2" style={{ marginBottom: 8 }}><Icon name="alert" />已退回：{it.reviewNote}</div> : null}

          {it.submittedAt ? (
            <>
              <div className="np-fields">
                <label>车牌<input className="in" value={edit.plate} disabled={!['submitted', 'reupload'].includes(it.status)} onChange={(e) => setEdit({ ...edit, plate: e.target.value.toUpperCase() })} /></label>
                <label>车主（选填）<input className="in" value={edit.contactName} disabled={!['submitted', 'reupload'].includes(it.status)} onChange={(e) => setEdit({ ...edit, contactName: e.target.value })} /></label>
                <label>手机<input className="in" value={edit.contactPhone} disabled={!['submitted', 'reupload'].includes(it.status)} onChange={(e) => setEdit({ ...edit, contactPhone: e.target.value })} /></label>
                {it.kind === 'family' ? (
                  <label>与业主关系<select className="in" value={edit.relation} disabled={!['submitted', 'reupload'].includes(it.status)} onChange={(e) => setEdit({ ...edit, relation: e.target.value })}>
                    <option value="">请选择</option>{[...RELATIONS, ...(edit.relation && !RELATIONS.includes(edit.relation) ? [edit.relation] : [])].map((r) => <option key={r}>{r}</option>)}
                  </select></label>
                ) : null}
              </div>
              <div className="np-files">
                {it.files.map((f) => (
                  <a key={f.index} href={f.fileUrl} target="_blank" rel="noreferrer" title={f.fileName}>
                    {isImg(f) ? <img src={f.fileUrl} alt={f.fileName} /> : <span className="np-pdf"><Icon name="file" size={22} />PDF</span>}
                  </a>
                ))}
              </div>
            </>
          ) : <div className="muted" style={{ padding: '6px 0 10px' }}>业主填好后这里会实时显示车牌、电话和上传的资料</div>}

          {/* 开通哪些车库 */}
          {!canEditGarages && picked.length ? (
            <div style={{ marginTop: 6, fontSize: 14 }}><span style={{ color: 'var(--ink2)' }}>开通车库：</span>{picked.map((k) => <span key={k} className="tag mute" style={{ marginRight: 4 }}>{(it.kind === 'family' ? FAMILY_GARAGES.find(([x]) => x === k)?.[1] : (targets.find((t) => t.key === k)?.short || targets.find((t) => t.key === k)?.label)) || k}{nums[k] ? ` ${nums[k]}` : ''}</span>)}</div>
          ) : null}
          {canEditGarages ? (
            <div className="quickMonths" style={{ marginTop: 6 }}>
              <span style={{ fontSize: 14, color: 'var(--ink2)', marginRight: 4 }}>开通：</span>
              {it.kind === 'paid'
                ? (targets.length ? targets.map((t) => <button key={t.key} className={`chip ${picked.includes(t.key) ? 'on' : ''}`} onClick={() => togglePick(t.key)}>{t.short || t.label.replace(`${community} `, '')}</button>)
                  : catalog === null ? <span className="muted">正在读取本小区停车场…</span> : <span className="muted">本小区没有接入停车系统</span>)
                : FAMILY_GARAGES.map(([k, l]) => <button key={k} className={`chip ${picked.includes(k) ? 'on' : ''}`} onClick={() => togglePick(k)}>{l}</button>)}
              {it.kind === 'family' ? ['main', 'civil'].filter((k) => picked.includes(k)).map((k) => (
                <input key={k} className="in" style={{ height: 36, width: 150 }} placeholder={k === 'main' ? '大车库车库号' : '人防车位号'} value={nums[k] || ''} onChange={(e) => setNums({ ...nums, [k]: e.target.value })} onBlur={() => saveGarages(picked, nums)} />
              )) : null}
            </div>
          ) : null}

          {/* 审核 */}
          {['submitted', 'reupload'].includes(it.status) && it.submittedAt ? (
            <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
              <button className="btn p" disabled={!!busy || !picked.length} onClick={approve}><Icon name="check" size={16} />{busy === '旧库查重' ? '旧库查重中…' : busy === '审核' ? '提交中…' : '资料无误，通过'}</button>
              <button className="btn" disabled={!!busy} onClick={() => setAsk(ask === 'reupload' ? '' : 'reupload')}>退回重传</button>
            </div>
          ) : null}
          {ask ? (
            <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
              <input className="in" style={{ flex: 1 }} autoFocus value={note} onChange={(e) => setNote(e.target.value)} placeholder={ask === 'void' ? '作废原因（必填，记入日志）' : '要业主补什么，例如：行驶证照片看不清'} />
              <button className={`btn ${ask === 'void' ? 'd' : 'p'}`} disabled={!!busy || !note.trim()} onClick={() => review(ask)}>{ask === 'void' ? '确认作废' : '退回'}</button>
            </div>
          ) : null}
          {err ? <div className="note2" style={{ color: 'var(--dang)', marginTop: 8 }}><Icon name="alert" />{err}</div> : null}
          {okMsg ? <div className="note2" style={{ marginTop: 8 }}><Icon name="check" />{okMsg}</div> : null}

          {/* 结果 */}
          {it.kind === 'family' && it.status === 'approved' ? <div className="note2" style={{ marginTop: 10 }}><Icon name="check" />已转亲情车登记，等物业经理审核后自动开通车库并续期一年；进度在「车牌登记审核」。</div> : null}
          {it.transaction ? (
            <div className="note2" style={{ marginTop: 10 }}>
              <Icon name="cash" />已收款 <b className="money">{money(it.transaction.amountCents / 100)}</b>（{it.transaction.startDate} 至 {it.transaction.endDate}）· {TXN_STATUS[it.transaction.externalSyncStatus] || it.transaction.externalSyncStatus}
              {it.transaction.execution?.lastError ? <div style={{ color: 'var(--dang)', marginTop: 4 }}>{it.transaction.execution.lastError}</div> : null}
            </div>
          ) : null}
        </div>
      </div>

      {/* 付费车：选月数收款（资料没齐也可以先收，挂待处理） */}
      {manage && it.log?.length ? (
        <ol className="np-log">{[...it.log].reverse().map((l, i) => <li key={i}><time>{dayjs(l.at).format('MM-DD HH:mm')}</time><b>{l.userName}</b>{l.action}{l.note ? <small> · {l.note}</small> : null}</li>)}</ol>
      ) : null}
      {manage && it.kind === 'paid' && !it.transaction && it.status !== 'void' ? <div className="muted" style={{ marginTop: 8 }}>还没收款：请到收银台选这一户 → 停车缴费，在这条新办车牌下选月数收款。</div> : null}
      {!manage && it.kind === 'paid' && !it.transaction && it.status !== 'void' ? (
        <div style={{ marginTop: 12 }}>
          {lots.length ? renewal(car, it.plate ? `${it.plate}（新办）` : `新办车牌 #${it.id}`, it.vehicleClass, setClass) : <div className="muted">先选要开通的车库，再选月数收款</div>}
          {it.status !== 'approved' ? <div className="muted" style={{ fontSize: 13.5, marginTop: 6 }}>资料还没审核通过也可以先收款：款挂「待处理」，业主提交并审核通过后自动办理。</div> : null}
        </div>
      ) : null}
    </div>
  );
}
