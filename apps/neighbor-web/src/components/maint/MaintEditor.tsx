import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { request } from '@pms/api-client';
// 套打表单、手写体、打印偏移、打印：复用旧后台已调好的源码（同一份代码，纸上格子位置不会两边各改各的）
import { MaintenanceSheets, sheetCount } from '@legacy/pages/maintenance/MaintenanceSheet';
import {
  ensureFontLoaded, filledText, findFont, HANDWRITING_FONTS, missingForOrder, readFontId, rememberFontId,
} from '@legacy/pages/maintenance/handwriting';
import {
  isZeroOffset, printOffsetCss, readPrintOffset, savePrintOffset, ZERO_OFFSET, type PrintOffset,
} from '@legacy/pages/maintenance/print-offset';
import {
  FEE_CATEGORY_OPTIONS, MAINTENANCE_STATUS_LABELS, SHARE_METHOD_OPTIONS, centsToYuan, materialTotalCents, optionText,
  quotaLabor, totalFeeCents,
  type MaintenanceItem, type MaintenanceMaterial, type MaintenanceOrder, type MaintenanceStatus,
  type QuotaItemRow, type QuotaParams, type SignSlot,
} from '@legacy/pages/maintenance/types';
import { printMaintenanceSheets } from '@legacy/lib/printSheet';
import Icon from '@/components/Icon';
import { Btn, ConfirmModal, Loading, toast } from '@/components/ui';

/* ───────── 与旧后台同口径的小工具 ───────── */
const SIGN_FIELDS: Record<SignSlot, keyof MaintenanceOrder> = {
  filler: 'fillerSignUrl', repairer: 'repairerSignUrl', inspector: 'inspectorSignUrl', owner: 'ownerSignUrl',
};
const SIGN_SLOT_LABELS: Record<SignSlot, string> = { filler: '填单人', repairer: '修理人', inspector: '查验员', owner: '报修人（户）' };
const STATUS_TONE: Record<MaintenanceStatus, string> = {
  filling: 's-wait', waiting_filler: 's-pend', waiting_repairer: 's-pend', waiting_inspector: 's-acc',
  pending_print: 's-work', completed: 's-done', void: 's-off',
};
const LAST_PAPER_NO_KEY = 'pms.maintenance.lastPaperNo';
function nextPaperNoFromLocal(): string {
  try {
    const raw = localStorage.getItem(LAST_PAPER_NO_KEY) || '';
    return /^\d+$/.test(raw) ? String(Number(raw) + 1).padStart(raw.length, '0') : '';
  } catch { return ''; }
}
function rememberPaperNo(v: string | null | undefined) {
  try { if (v && /^\d+$/.test(v)) localStorage.setItem(LAST_PAPER_NO_KEY, v); } catch { /* 隐私模式 */ }
}
const emptyItem = (): MaintenanceItem => ({
  part: '', name: '', surveyQty: null, actualQty: null, actualHours: null, measureQty: null, quotaCode: '',
  quotaHours: null, laborFeeCents: null, materialFeeCents: null, quality: '', note: '',
});
const emptyMaterial = (): MaintenanceMaterial => ({
  name: '', spec: '', unit: '', estQty: null, pickQty: null, usedQty: null, returnQty: null, amountCents: null, note: '',
});
const isEmptyItem = (i: MaintenanceItem) => !i.part && !i.name && !i.quotaCode && !i.quality && !i.note
  && [i.surveyQty, i.actualQty, i.actualHours, i.measureQty, i.quotaHours, i.laborFeeCents, i.materialFeeCents].every((v) => v == null);
const isEmptyMaterial = (r: MaintenanceMaterial) => !r.name && !r.spec && !r.unit && !r.note
  && [r.estQty, r.pickQty, r.usedQty, r.returnQty, r.amountCents].every((v) => v == null);
/** 签名只在「刚签完」那次随保存带上；普通保存不碰，免得把手机上刚签的字抹掉 */
function signaturePatch(extra?: Partial<MaintenanceOrder>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of ['fillerSignUrl', 'repairerSignUrl', 'ownerSignUrl'] as const) {
    if (extra && k in extra) out[k] = (extra[k] as string | null) ?? '';
  }
  return out;
}
function printHint(status: MaintenanceStatus, verb: string) {
  if (status === 'void') return '已作废的单不能打印';
  if (status === 'pending_print') return `${verb}后确认已打好，自动标记已完成`;
  if (status === 'completed') return `已完成的单再${verb}一份，不改状态`;
  return `签字还没齐：${verb}当前内容，签名栏留空可手签；不会标记完成`;
}

interface PhoneSign {
  slot: SignSlot;
  status: 'loading' | 'waiting' | 'opened' | 'signed' | 'expired' | 'error';
  token?: string; linkUrl?: string; qrDataUrl?: string; expiresAt?: number;
  hadSignature?: boolean; signUrl?: string | null; error?: string;
}

/**
 * 养护单编辑器：屏幕上就是那张纸（直接在格子里填），外面一圈是工具栏。
 * 流程：填单中（可改）→ 保存并推送签名 → 填单人 / 修理人 / 查验员依次手机签 → 待打印 → 打印后归档。
 */
export default function MaintEditor({
  id, quotaItems, quotaParams, canEdit, canDelete, canInspect, onClose, onChanged,
}: {
  id: number; quotaItems: QuotaItemRow[]; quotaParams: QuotaParams;
  canEdit: boolean; canDelete: boolean; canInspect: boolean;
  onClose: () => void; onChanged: () => void;
}) {
  const [draft, setDraft] = useState<MaintenanceOrder | null>(null);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [phoneSign, setPhoneSign] = useState<PhoneSign | null>(null);
  const [phoneOpen, setPhoneOpen] = useState(false);
  const [printJob, setPrintJob] = useState<null | 'normal' | 'overlay'>(null);
  const [askArchive, setAskArchive] = useState(false);
  const [askClose, setAskClose] = useState(false);
  const [askVoid, setAskVoid] = useState(false);
  const [offsetOpen, setOffsetOpen] = useState(false);
  const printRef = useRef<HTMLDivElement | null>(null);
  const [fontId, setFontId] = useState(readFontId);
  const [fontReady, setFontReady] = useState(false);
  const [offset, setOffset] = useState<PrintOffset>(readPrintOffset);

  /** 定额编号不唯一（一个兜底号下挂多个项目）：先按「编号+项目名」，名字没填才退回按编号 */
  const quota = useMemo(() => {
    const byCode = new Map<string, QuotaItemRow>();
    const byCodeName = new Map<string, QuotaItemRow>();
    const byName = new Map<string, QuotaItemRow>();
    for (const it of quotaItems) {
      if (!byCode.has(it.code)) byCode.set(it.code, it);
      byCodeName.set(`${it.code}||${it.name}`, it);
      if (!byName.has(it.name)) byName.set(it.name, it);
    }
    return {
      pick: (code: string, name?: string | null) => (name ? byCodeName.get(`${code}||${name.trim()}`) : undefined) ?? byCode.get(code),
      byName,
    };
  }, [quotaItems]);

  useEffect(() => {
    request<MaintenanceOrder>({ url: `/maintenance-orders/${id}` })
      .then((data) => {
        // 还没填实体单号：先把下一个号填上（服务端建议优先，其次本机上次），保存时才落库
        const suggestion = data.suggestedPaperNo || nextPaperNoFromLocal();
        const prefill = !data.paperNo && suggestion && data.status === 'filling';
        setDraft(prefill ? { ...data, paperNo: suggestion } : data);
        setDirty(!!prefill);
      })
      .catch((e) => { toast(e instanceof Error ? e.message : '加载养护单失败'); onClose(); });
  }, [id, onClose]);

  const editable = canEdit && draft?.status === 'filling';
  const font = findFont(fontId);
  const missing = useMemo(() => missingForOrder(fontId, draft), [fontId, draft]);

  useEffect(() => {
    if (!font.family) { setFontReady(true); return; }
    let alive = true;
    setFontReady(false);
    ensureFontLoaded(fontId, filledText(draft)).catch(() => undefined).finally(() => { if (alive) setFontReady(true); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fontId, font.family]);

  const recompute = (o: MaintenanceOrder): MaintenanceOrder => ({
    ...o, totalCents: totalFeeCents(o.items, o.coefficient), materialTotalCents: materialTotalCents(o.materials),
  });
  const patch = (p: Partial<MaintenanceOrder>) => {
    setDraft((prev) => {
      if (!prev) return prev;
      const next = { ...prev, ...p };
      if ('feeCategory' in p) next.feeCategoryText = optionText(FEE_CATEGORY_OPTIONS, next.feeCategory);
      if ('shareMethod' in p) next.shareMethodText = optionText(SHARE_METHOD_OPTIONS, next.shareMethod);
      return recompute(next);
    });
    setDirty(true);
  };
  const patchItem = (index: number, p: Partial<MaintenanceItem>) => {
    setDraft((prev) => {
      if (!prev) return prev;
      const items = [...prev.items];
      while (items.length <= index) items.push(emptyItem());
      const next = { ...items[index], ...p };
      if ('name' in p && !next.quotaCode && next.name) {
        const hit = quota.byName.get(next.name.trim());
        if (hit) next.quotaCode = hit.code;
      }
      if ('quotaCode' in p || 'actualQty' in p || 'name' in p) {
        const q = quota.pick(next.quotaCode, next.name);
        if (q) {
          const qty = next.actualQty ?? next.surveyQty ?? 1;
          const { hours, laborFeeCents } = quotaLabor(Number(q.hours) || 0, qty, prev.laborRateCents || 0);
          next.quotaHours = hours;
          next.laborFeeCents = laborFeeCents;
          if (!next.name) next.name = q.name;
          if (next.materialFeeCents === null && q.materialFeeCents) next.materialFeeCents = Math.round(q.materialFeeCents * qty);
        }
      }
      items[index] = next;
      return recompute({ ...prev, items });
    });
    setDirty(true);
  };
  const patchMaterial = (index: number, p: Partial<MaintenanceMaterial>) => {
    setDraft((prev) => {
      if (!prev) return prev;
      const materials = [...prev.materials];
      while (materials.length <= index) materials.push(emptyMaterial());
      materials[index] = { ...materials[index], ...p };
      return recompute({ ...prev, materials });
    });
    setDirty(true);
  };

  const save = async (extra?: Partial<MaintenanceOrder>): Promise<boolean> => {
    if (!draft) return false;
    const m = recompute({ ...draft, ...extra });
    setSaving(true);
    try {
      const saved = await request<MaintenanceOrder>({
        method: 'PATCH', url: `/maintenance-orders/${draft.id}`,
        data: {
          paperNo: m.paperNo ?? '', unitName: m.unitName ?? '', reporterName: m.reporterName ?? '',
          addrVillage: m.addrVillage ?? '', addrRoad: m.addrRoad ?? '', addrLane: m.addrLane ?? '',
          addrBuildingNo: m.addrBuildingNo ?? '', addrRoom: m.addrRoom ?? '', reportedOn: m.reportedOn,
          presentTime: m.presentTime ?? '', faultPart: m.faultPart ?? '', repairItem: m.repairItem ?? '',
          appointOn: m.appointOn, startOn: m.startOn, finishOn: m.finishOn, partCategory: m.partCategory ?? '',
          feeCategory: m.feeCategory ?? '', shareMethod: m.shareMethod ?? '', repairDateText: m.repairDateText ?? '',
          feeCategoryText: m.feeCategoryText ?? '', shareMethodText: m.shareMethodText ?? '',
          items: m.items.filter((i) => !isEmptyItem(i)), materials: m.materials.filter((r) => !isEmptyMaterial(r)),
          scrapNote: m.scrapNote ?? '', voucherIssue: m.voucherIssue ?? '', serviceRecord: m.serviceRecord ?? '',
          followUpRecord: m.followUpRecord ?? '', fillerName: m.fillerName ?? '', repairerName: m.repairerName ?? '',
          ...signaturePatch(extra),
        },
      });
      setDraft(saved); setDirty(false); rememberPaperNo(saved.paperNo); onChanged();
      toast('已保存');
      return true;
    } catch (e) { toast(e instanceof Error ? e.message : '保存失败'); return false; }
    finally { setSaving(false); }
  };

  const publish = async () => {
    if (!draft || saving) return;
    if (!draft.paperNo && !window.confirm('还没填实体单号，纸上那一格会是空的。仍要推送签名吗？')) return;
    if (dirty && !(await save())) return;
    setSaving(true);
    try {
      const saved = await request<MaintenanceOrder>({ method: 'POST', url: `/maintenance-orders/${draft.id}/publish` });
      setDraft(saved); setDirty(false); onChanged();
      toast('已推送给填单人，小程序里的签字任务不会过期');
    } catch (e) { toast(e instanceof Error ? e.message : '推送签名失败'); }
    finally { setSaving(false); }
  };

  const phoneOpenRef = useRef(phoneOpen);
  useEffect(() => { phoneOpenRef.current = phoneOpen; }, [phoneOpen]);

  const startPhoneSign = useCallback(async (slot: SignSlot) => {
    if (!draft) return;
    setPhoneOpen(true);
    setPhoneSign({ slot, status: 'loading' });
    try {
      const data = await request<{ token: string; url: string; qrDataUrl: string; expiresInSec: number }>(
        slot === 'inspector'
          ? { method: 'POST', url: `/maintenance-orders/${draft.id}/inspect-token` }
          : { method: 'POST', url: `/maintenance-orders/${draft.id}/sign-token`, data: { slot } },
      );
      setPhoneSign({
        slot, status: 'waiting', token: data.token, linkUrl: data.url, qrDataUrl: data.qrDataUrl,
        expiresAt: Date.now() + data.expiresInSec * 1000, hadSignature: !!draft[SIGN_FIELDS[slot]],
      });
    } catch (e) { setPhoneSign({ slot, status: 'error', error: e instanceof Error ? e.message : '二维码生成失败' }); }
  }, [draft]);

  // 按 token 问签字进度（不看单据那一格有没有值：重签时那一格本来就有）。依赖只放 token/status，免得定时器被重建
  useEffect(() => {
    const token = phoneSign?.token;
    const status = phoneSign?.status;
    if (!token || !draft || (status !== 'waiting' && status !== 'opened')) return;
    let alive = true;
    const timer = window.setInterval(async () => {
      if (!alive) return;
      if (phoneSign?.expiresAt && Date.now() > phoneSign.expiresAt) {
        setPhoneSign((p) => (p && p.token === token ? { ...p, status: 'expired' } : p));
        return;
      }
      try {
        const st = await request<{ opened: boolean; submitted: boolean }>({ url: `/sign/status?token=${encodeURIComponent(token)}` });
        if (!alive) return;
        if (st.submitted) {
          const fresh = await request<MaintenanceOrder>({ url: `/maintenance-orders/${draft.id}` });
          if (!alive) return;
          setDraft((p) => (p ? { ...p, ...fresh } : fresh));
          setDirty(false); onChanged();
          setPhoneSign((p) => (p && p.token === token ? { ...p, status: 'signed', signUrl: (fresh[SIGN_FIELDS[p.slot]] as string) || null } : p));
          if (!phoneOpenRef.current) toast(`${SIGN_SLOT_LABELS[phoneSign!.slot]}的签名已收到`);
        } else if (st.opened && status !== 'opened') {
          setPhoneSign((p) => (p && p.token === token ? { ...p, status: 'opened' } : p));
        }
      } catch { /* 网络抖动，下一轮再问 */ }
    }, 2000);
    return () => { alive = false; window.clearInterval(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phoneSign?.token, phoneSign?.status, draft?.id]);

  // 打印：字体下完再打（swap 会让没下完的那一张印成宋体，联单印废一张少一张）
  useEffect(() => {
    if (!printJob || !printRef.current || !draft) return;
    let alive = true;
    const html = printRef.current.innerHTML;
    ensureFontLoaded(fontId, filledText(draft)).catch(() => undefined)
      .then(() => printMaintenanceSheets(html, `养护单 ${draft.paperNo || draft.orderNo}`, printOffsetCss(offset)))
      .then(() => { if (alive && draft.status === 'pending_print') setAskArchive(true); })
      .catch((e) => toast(e instanceof Error ? e.message : '打印失败'))
      .finally(() => { if (alive) setPrintJob(null); });
    return () => { alive = false; };
  }, [printJob, draft, fontId, offset]);

  const archive = async () => {
    if (!draft) return;
    try {
      const saved = await request<MaintenanceOrder>({ method: 'POST', url: `/maintenance-orders/${draft.id}/printed` });
      setDraft(saved); onChanged(); toast('已标记为完成');
    } catch (e) { toast(e instanceof Error ? e.message : '归档失败'); }
    finally { setAskArchive(false); }
  };
  const voidOrder = async () => {
    if (!draft) return;
    try {
      await request({ method: 'DELETE', url: `/maintenance-orders/${draft.id}` });
      toast('已作废，原工单可以重新开单'); onChanged(); onClose();
    } catch (e) { toast(e instanceof Error ? e.message : '作废失败'); }
    finally { setAskVoid(false); }
  };
  const tryClose = () => { if (dirty) setAskClose(true); else onClose(); };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !phoneOpen && !offsetOpen) tryClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const setOff = (p: Partial<PrintOffset>) => { const n = { ...offset, ...p }; setOffset(n); savePrintOffset(n); };
  const pages = draft ? sheetCount(draft) : 1;
  const signing = draft && ['waiting_filler', 'waiting_repairer', 'waiting_inspector'].includes(draft.status);
  const currentSlot: SignSlot | null = draft?.status === 'waiting_filler' ? 'filler' : draft?.status === 'waiting_repairer' ? 'repairer' : draft?.status === 'waiting_inspector' ? 'inspector' : null;
  const STEPS: Array<[string, boolean]> = draft ? [
    ['填单', draft.status !== 'filling'],
    ['填单人签', !!draft.fillerSignUrl],
    ['修理人签', !!draft.repairerSignUrl],
    ['查验员签', !!draft.inspectorSignUrl],
    ['打印归档', draft.status === 'completed'],
  ] : [];

  return (
    <div className="mo-ed">
      <div className="mo-ed-h">
        {!draft ? <b>养护单</b> : (
          <>
            <b style={{ fontSize: 18 }}>养护单 {draft.paperNo || draft.orderNo}</b>
            <span className={`pill ${STATUS_TONE[draft.status]}`}>{MAINTENANCE_STATUS_LABELS[draft.status]}</span>
            {pages > 1 ? <span className="tag">共 {pages} 张</span> : null}
            {dirty ? <span className="tag warn">未保存</span> : null}
            <div className="mo-steps">
              {STEPS.map(([label, done], i) => <span key={label} className={done ? 'on' : ''}>{i + 1}. {label}</span>)}
            </div>
          </>
        )}
        <button className="btn g sm" style={{ marginLeft: 'auto' }} onClick={tryClose}>✕ 关闭 <span className="kbd">Esc</span></button>
      </div>

      {!draft ? <Loading text="加载养护单…" /> : (
        <>
          <div className="mo-ed-bar">
            {editable ? (
              <label className="mo-f"><span>实体单号</span>
                <input className="in" style={{ width: 130 }} inputMode="numeric" maxLength={12} placeholder="如 0119610"
                  value={draft.paperNo || ''} onChange={(e) => patch({ paperNo: e.target.value.replace(/\D/g, '') })} />
              </label>
            ) : null}
            <label className="mo-f"><span>手写体</span>
              <select className="in" value={fontId} onChange={(e) => { setFontId(e.target.value); rememberFontId(e.target.value); }}>
                {HANDWRITING_FONTS.map((f) => <option key={f.id} value={f.id}>{f.label}{f.sizeMb ? `（约 ${f.sizeMb}MB）` : ''}</option>)}
              </select>
              {!fontReady && font.family ? <span className="muted" style={{ fontSize: 13 }}>下载中…</span> : null}
            </label>
            <label className="mo-f"><span>缩放</span>
              <select className="in" value={zoom} onChange={(e) => setZoom(Number(e.target.value))}>
                {[0.6, 0.8, 1, 1.2].map((z) => <option key={z} value={z}>{Math.round(z * 100)}%</option>)}
              </select>
            </label>
            <div style={{ position: 'relative' }}>
              <Btn size="sm" onClick={() => setOffsetOpen(!offsetOpen)}><Icon name="gear" size={15} />打印偏移{isZeroOffset(offset) ? '' : '·已设'}</Btn>
              {offsetOpen ? (
                <div className="mo-pop" onClick={(e) => e.stopPropagation()}>
                  <div className="muted" style={{ fontSize: 13, lineHeight: 1.6 }}>套打时内容没落进格子，用这里整体挪。正数往右/往下，<b>只影响打印</b>。存在这台电脑上。</div>
                  {([['正面', 'fx', 'fy'], ['反面', 'bx', 'by']] as const).map(([t, x, y]) => (
                    <div key={t} style={{ marginTop: 10 }}>
                      <b style={{ fontSize: 13.5 }}>{t}</b>
                      <div style={{ display: 'flex', gap: 10, marginTop: 4 }}>
                        <label className="mo-f"><span>左右</span><input className="in" type="number" step={0.5} min={-15} max={15} style={{ width: 80 }} value={offset[x]} onChange={(e) => setOff({ [x]: Number(e.target.value) || 0 })} />mm</label>
                        <label className="mo-f"><span>上下</span><input className="in" type="number" step={0.5} min={-15} max={15} style={{ width: 80 }} value={offset[y]} onChange={(e) => setOff({ [y]: Number(e.target.value) || 0 })} />mm</label>
                      </div>
                    </div>
                  ))}
                  <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                    <Btn size="sm" onClick={() => setOff({ bx: offset.fx, by: offset.fy })}>反面同正面</Btn>
                    <Btn size="sm" disabled={isZeroOffset(offset)} onClick={() => setOff(ZERO_OFFSET)}>全部归零</Btn>
                    <Btn size="sm" kind="p" onClick={() => setOffsetOpen(false)}>好了</Btn>
                  </div>
                </div>
              ) : null}
            </div>
          </div>

          {!editable && draft.status !== 'void' ? (
            <div className="note2" style={{ margin: '0 0 10px' }}><Icon name="alert" />
              {draft.status !== 'filling' ? '已进入顺序签字，正文已锁定（三方签的必须是同一份）。要修改请作废后从原工单重新开单。' : '你的角色只有查看权限，不能修改。'}
            </div>
          ) : null}

          <div className="mo-stage">
            <div className="mo-stage__inner" style={{ transform: `scale(${zoom})`, width: `${227 * zoom}mm`, height: `${(116 * pages * 2 + 4 * pages * 2) * zoom}mm` }}>
              <MaintenanceSheets order={draft} editable={editable} fontId={fontId}
                quotaListId="mo-quota-codes" quotaNameListId="mo-quota-names"
                onPatch={patch} onItemPatch={patchItem} onMaterialPatch={patchMaterial} onSign={undefined} />
            </div>
          </div>
          <datalist id="mo-quota-codes">
            {quotaItems.filter((q) => q.enabled).map((q) => <option key={q.id} value={q.code} label={`${q.name}${q.spec ? ` ${q.spec}` : ''}（${q.hours} 工时/${q.unit}）`} />)}
          </datalist>
          <datalist id="mo-quota-names">
            {quotaItems.filter((q) => q.enabled).map((q) => <option key={q.id} value={q.name} label={`${q.code}${q.spec ? ` ${q.spec}` : ''}（${q.hours} 工时/${q.unit}）`} />)}
          </datalist>
          {missing.length ? <div className="note2" style={{ marginTop: 8 }}><Icon name="alert" />「{font.label}」里没有这几个字：<b>{missing.join(' ')}</b>，纸上会用宋体顶上。换「宅在家自动笔」（生僻字最全）可以避免。</div> : null}
          <div className="muted" style={{ fontSize: 13.5, marginTop: 8 }}>
            定额人工单价 {centsToYuan(quotaParams.laborRateCents)} 元/工时 · 取费系数 {quotaParams.coefficient} · 合计 =（人工费 + 材料费）× 系数。在「编号」格选定额编号，工时和人工费自动算出，算完还能手改。
          </div>

          <div className="mo-ed-foot">
            {canDelete && draft.status !== 'void' ? <Btn kind="d" onClick={() => setAskVoid(true)}>作废养护单</Btn> : null}
            <span style={{ flex: 1 }} />
            <Btn title={printHint(draft.status, '打印')} disabled={draft.status === 'void' || !!printJob} onClick={() => setPrintJob('normal')}><Icon name="print" size={16} />打印整单</Btn>
            <Btn title={printHint(draft.status, '套打')} disabled={draft.status === 'void' || !!printJob} onClick={() => setPrintJob('overlay')}><Icon name="print" size={16} />套打（只打内容）</Btn>
            {signing && currentSlot ? (
              <Btn kind="p" disabled={currentSlot === 'inspector' && !canInspect} title={currentSlot === 'inspector' && !canInspect ? '查验签字需要「养护单查验」权限' : ''} onClick={() => void startPhoneSign(currentSlot)}>
                <Icon name="qr" size={16} />{SIGN_SLOT_LABELS[currentSlot]}签字二维码
              </Btn>
            ) : null}
            {editable ? <Btn disabled={saving} onClick={() => void save()}>保存</Btn> : null}
            {draft.status === 'filling' && canEdit ? <Btn kind="p" disabled={saving} onClick={() => void publish()}>保存并推送签名</Btn> : null}
          </div>
        </>
      )}

      {phoneOpen && phoneSign ? <PhoneSignPanel state={phoneSign} onRetry={() => void startPhoneSign(phoneSign.slot)} onClose={() => setPhoneOpen(false)} /> : null}

      <ConfirmModal open={askArchive} title="这张养护单已成功打印吗？" confirmText="已打印，完成归档" onClose={() => setAskArchive(false)} onConfirm={() => void archive()}>
        只有纸质单已正常打出时才标记完成；取消打印或打印失败请点「取消」，之后可以再打。
      </ConfirmModal>
      <ConfirmModal open={askVoid} danger title="作废这张养护单？" confirmText="作废" onClose={() => setAskVoid(false)} onConfirm={() => void voidOrder()}>
        作废后记录保留可查，原工单可以重新开单。
      </ConfirmModal>
      <ConfirmModal open={askClose} title="有没保存的修改" confirmText="保存并关闭" onClose={() => { setAskClose(false); onClose(); }} onConfirm={async () => { setAskClose(false); if (await save()) onClose(); }}>
        点「取消」直接关闭会丢掉这次填的内容。
      </ConfirmModal>

      {/* 打印实体挂在 body 下：放在滚动容器里会把超出一屏的页裁掉 */}
      {printJob && draft ? createPortal(
        <div ref={printRef} className="mo-print-offscreen">
          <MaintenanceSheets order={draft} editable={false} fontId={fontId} overlay={printJob === 'overlay'} />
        </div>,
        document.body,
      ) : null}
    </div>
  );
}

function PhoneSignPanel({ state, onRetry, onClose }: { state: PhoneSign; onRetry: () => void; onClose: () => void }) {
  const [now, setNow] = useState(() => Date.now());
  const counting = state.status === 'waiting' || state.status === 'opened';
  useEffect(() => {
    if (!counting) return;
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [counting]);
  const left = Math.max(0, Math.ceil(((state.expiresAt ?? 0) - now) / 1000));
  const label = SIGN_SLOT_LABELS[state.slot];
  const copy = async () => {
    if (!state.linkUrl) return;
    try { await navigator.clipboard.writeText(state.linkUrl); toast('一次性签字链接已复制，可以直接发到微信'); }
    catch { toast('复制失败，请用二维码扫码'); }
  };
  return (
    <div className="cmdk" style={{ alignItems: 'center', paddingTop: 0, zIndex: 90 }} onClick={onClose}>
      <div className="box" style={{ width: 440, padding: 22, textAlign: 'center' }} onClick={(e) => e.stopPropagation()}>
        <h3 style={{ margin: '0 0 12px', fontSize: 18 }}>{label}：用手机扫码签名</h3>
        {state.status === 'loading' ? <Loading text="正在生成二维码…" /> : null}
        {counting ? (
          <>
            <img src={state.qrDataUrl} alt="签名二维码" style={{ width: 240, height: 240 }} />
            <div style={{ margin: '8px 0', fontWeight: 600, color: state.status === 'opened' ? 'var(--ok)' : 'var(--ink2)' }}>
              {state.status === 'opened' ? '● 手机已打开签名页，等他写完' : '○ 等待手机扫码…'}
            </div>
            <div className="muted" style={{ fontSize: 14, lineHeight: 1.7 }}>
              让签字的人用<b>微信扫一扫</b>，手机横过来写，写完点提交。<br />
              二维码 <b>{Math.floor(left / 60)}:{String(left % 60).padStart(2, '0')}</b> 后失效；<b>关掉这个窗口也没关系</b>，签好会自动贴到单子上。
            </div>
            {state.hadSignature ? <div className="tag warn" style={{ marginTop: 8 }}>这一格原来就有签名，签完会覆盖</div> : null}
          </>
        ) : null}
        {state.status === 'signed' ? (
          <>
            <div style={{ fontSize: 40, color: 'var(--ok)' }}>✓</div>
            <b>{label}的签名已收到</b>
            {state.signUrl ? <img src={state.signUrl} alt="签名" style={{ maxWidth: '100%', maxHeight: 120, margin: '10px auto', display: 'block', border: '1px solid var(--line)', borderRadius: 8 }} /> : null}
            <div className="muted" style={{ fontSize: 14 }}>已存进这张养护单，不用再点保存。写歪了可以重新签一次。</div>
          </>
        ) : null}
        {state.status === 'expired' ? <div style={{ padding: 20 }}><b>二维码已过期</b><div className="muted" style={{ fontSize: 14, marginTop: 6 }}>30 分钟内没人签，重新生成一张就行。</div></div> : null}
        {state.status === 'error' ? <div className="tag warn" style={{ padding: 12 }}>{state.error}</div> : null}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'center', marginTop: 16 }}>
          {counting ? <Btn onClick={() => void copy()} disabled={!state.linkUrl}>复制签字链接</Btn> : null}
          <Btn onClick={onRetry} disabled={state.status === 'loading'}>{state.status === 'signed' ? '重新签一次' : state.status === 'expired' ? '重新生成二维码' : state.status === 'error' ? '重试' : '换一张二维码'}</Btn>
          <Btn kind="p" onClick={onClose}>{state.status === 'signed' ? '完成' : '关闭'}</Btn>
        </div>
      </div>
    </div>
  );
}
