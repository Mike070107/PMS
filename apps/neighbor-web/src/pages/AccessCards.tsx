import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { accessCardIssuance, address, request } from '@pms/api-client';
import type { AccessCardIssueBatch, AccessCardIssueItem } from '@pms/api-client/src/endpoints/access-card-issuance';
import type { AddressCommunity } from '@pms/shared-types';
import { useSession } from '@/lib/auth';
import { can } from '@/lib/perm';
import { dayjs } from '@/lib/format';
import Icon from '@/components/Icon';
import { Loading, Sheet, toast } from '@/components/ui';
import HousePicker, { type PickedHouse } from '@/components/HousePicker';
import { accessStatusLabel, legacyStatusLabel, rawTitle } from '@/lib/access-card-status';
import '@/styles/access-door.css';
import ToneIcon from '@/components/ToneIcon';

interface CardRow { id: number; cardNo: string; houseId: number; status?: string }
interface CardHistoryRow {
  id: number; personNo?: string | null; sequence: number; roomLabel: string; hidden?: boolean; status?: string | null;
  personCreatedAt?: string | null; icCardNo?: string | null; wgCardNo?: string | null;
  issuedAt?: string | null; lastSwipeAt?: string | null; lastDevice?: string | null;
}
interface CardHistoryResp { status: 'ready' | 'pending'; rows: CardHistoryRow[]; refreshedAt?: string; fieldsIncomplete?: boolean }
type CardRecent = {
  id: number; personNo?: string | null; sequence?: number; roomLabel: string; icCardNo?: string | null; wgCardNo?: string | null;
  issuedAt?: string | null; hidden?: boolean; status?: string | null;
  communityId?: number | null; communityName?: string | null; lane?: string | null; buildingId?: number | null;
  buildingNo?: string | null; buildingText?: string | null; houseId?: number | null; roomNo?: string | null;
  ownerName?: string | null; ownerPhone?: string | null; ownerId?: number | null;
};
interface CardDetail {
  id: number; appliedSystems?: string[]; grantedBuildings?: string[]; latestTasks?: unknown[];
  icCardNo?: string | null; wgCardNo?: string | null; roomLabel?: string | null; status?: string | null;
}

const CARD_STATUS: Record<string, { text: string; tone: string }> = {
  pending: { text: '等放卡', tone: 'mute' },
  card_completed: { text: '已写卡', tone: 'ok' },
  card_failed: { text: '写卡失败', tone: 'dang' },
};
const cardStatusLabel = (v?: string | null) => CARD_STATUS[v || ''] ?? { text: v ? '处理中' : '—', tone: 'mute' };

const fmtCardTime = (value?: string | null) => value && dayjs(value).isValid() ? dayjs(value).format('YYYY-MM-DD HH:mm') : '—';
const actionText = (value: unknown) => typeof value === 'string' ? value : value == null ? '' : JSON.stringify(value);
const cardActionResults = (raw: any): Array<{ name: string; ok: boolean; detail: string }> => {
  const source = raw?.systems ?? raw?.results ?? raw;
  const entries: Array<[string, any]> = Array.isArray(source)
    ? source.map((item: any) => [String(item?.system ?? item?.name ?? item?.key ?? 'system'), item])
    : source && typeof source === 'object' ? Object.entries(source) : [];
  return entries.map(([name, item]) => {
    const ok = item?.success === true || item?.ok === true || item?.status === 'succeeded' || item?.status === 'success' || item?.result === 'success';
    return { name, ok, detail: actionText(item?.message ?? item?.error ?? item?.reason ?? item?.detail ?? item?.result) || (ok ? '成功' : '失败') };
  });
};
const grantResultRows = (raw: any): Array<{ buildingNo: string; status: string; ok: boolean; detail: string }> => {
  const source = raw?.results ?? raw?.buildings ?? raw;
  const entries: Array<[string, any]> = Array.isArray(source)
    ? source.map((item: any, index: number) => [String(item?.buildingNo ?? item?.building ?? item?.no ?? index + 1), item])
    : source && typeof source === 'object' ? Object.entries(source) : [];
  return entries.map(([buildingNo, item]) => {
    const status = String(item?.status ?? item?.result ?? (item?.offline ? 'offline' : item?.success === false ? 'failed' : item?.success === true ? 'succeeded' : ''));
    const ok = item?.success === true || status === 'succeeded' || status === 'success' || status === 'ok';
    const label = ['offline', '待连', '未连接', 'unreachable'].includes(status) ? '离线' : ok ? '成功' : status === 'failed' || status === 'error' ? '失败' : status ? status : (ok ? '成功' : '失败');
    return { buildingNo, status: label, ok, detail: actionText(item?.message ?? item?.error ?? item?.reason ?? item?.detail) || (ok ? '成功' : label) };
  });
};

/**
 * 门禁管理：按户发卡 + 查卡 + 发卡历史，全部在本页完成（不再跳旧发卡台）。
 * 发卡走 /access-card-issuance/batches：建批次 → 装读卡器的工作站逐张写卡 →
 * 下发楼栋控制器 / 写旧物业库；页面轮询批次进度，允许单张重试下发。
 */
export default function AccessCards() {
  const session = useSession();
  const canEdit = can('business', 'edit');
  const [tree, setTree] = useState<AddressCommunity[]>([]);
  const [picked, setPicked] = useState<PickedHouse | null>(null);
  const [cards, setCards] = useState<CardRow[] | null>(null);
  const [history, setHistory] = useState<CardHistoryResp | null>(null);
  const [err, setErr] = useState('');
  const [issuer, setIssuer] = useState<{ id: string; name: string } | null>(null);
  const [qty, setQty] = useState(1);
  const [batch, setBatch] = useState<AccessCardIssueBatch | null>(null);
  const [busy, setBusy] = useState('');
  const timer = useRef<number | null>(null);
  const [historyError, setHistoryError] = useState('');
  const [historyRetrying, setHistoryRetrying] = useState(false);
  const [historyRetry, setHistoryRetry] = useState(0);
  const [recent, setRecent] = useState<CardRecent[] | null>(null);
  const [recentError, setRecentError] = useState('');
  const [recentRetry, setRecentRetry] = useState(0);
  const [applyCard, setApplyCard] = useState<CardHistoryRow | null>(null);
  const [applyBusy, setApplyBusy] = useState(false);
  const [applyResults, setApplyResults] = useState<Array<{ name: string; ok: boolean; detail: string }> | null>(null);
  const [grantCard, setGrantCard] = useState<CardHistoryRow | null>(null);
  const [grantMode, setGrantMode] = useState<'add' | 'remove'>('add');
  const [grantSearch, setGrantSearch] = useState('');
  const [grantSelected, setGrantSelected] = useState<string[]>([]);
  const [grantBusy, setGrantBusy] = useState(false);
  const [grantResults, setGrantResults] = useState<Array<{ buildingNo: string; status: string; ok: boolean; detail: string }> | null>(null);
  const [cardDetails, setCardDetails] = useState<Record<number, CardDetail>>({});

  useEffect(() => { address.tree().then(setTree).catch(() => setTree([])); }, []);
  useEffect(() => {
    accessCardIssuance.readiness()
      .then((r) => {
        const list = (r?.agents ?? []) as Array<{ id: string; kind: string; name?: string; status: string }>;
        const iss = list.find((a) => a.kind === 'issuer' && a.status === 'online') ?? null;
        setIssuer(iss ? { id: iss.id, name: iss.name || '发卡工作站' } : null);
      })
      .catch(() => setIssuer(null));
  }, []);

  const communities = useMemo(() => {
    const list = tree.filter((c) => !c.isGroup);
    const a = session.access;
    if (!a || a.scopeAll) return list;
    const ids = new Set(a.communityIds ?? []);
    return list.filter((c) => ids.has(c.id));
  }, [tree, session.access]);

  const loadHouse = useCallback((houseId: number) => {
    setCards(null); setErr('');
    request<{ accessCards: CardRow[] }>({ url: '/business/search', query: { q: '', serviceType: 'access_card' } })
      .then((r) => setCards((r?.accessCards ?? []).filter((c) => c.houseId === houseId)))
      .catch(() => setCards([]));
  }, []);

  const historyKey = JSON.stringify([picked?.communityId, picked?.lane, picked?.buildingNo, picked?.roomNo]);
  useEffect(() => {
    if (!picked?.houseId) { setCards(null); setHistory(null); setBatch(null); setHistoryError(''); setHistoryRetrying(false); return undefined; }
    loadHouse(picked.houseId);
    let cancelled = false;
    let attempts = 0;
    let retryTimer = 0;
    setHistory(null); setHistoryError(''); setHistoryRetrying(false);
    const addressText = [picked.lane, picked.buildingNo, picked.roomNo].filter(Boolean).join('/');
    const runHistory = async () => {
      try {
        const res = await request<CardHistoryResp>({ url: '/access-card-issuance/cards/history', query: { communityId: picked.communityId, address: addressText } });
        if (cancelled) return;
        if (res?.status === 'pending' && attempts < 3) {
          attempts += 1;
          setHistoryRetrying(true);
          retryTimer = window.setTimeout(() => void runHistory(), 3000);
          return;
        }
        setHistory(res);
        setHistoryRetrying(false);
      } catch (e) {
        if (cancelled) return;
        setHistoryError(e instanceof Error && e.message ? e.message : '发卡历史读取失败');
        setHistoryRetrying(false);
      }
    };
    void runHistory();
    return () => { cancelled = true; if (retryTimer) window.clearTimeout(retryTimer); };
  }, [historyKey, historyRetry, loadHouse, picked]);

  useEffect(() => {
    let cancelled = false;
    setRecent(null); setRecentError('');
    request<CardRecent[]>({ url: '/access-card-issuance/cards/recent', query: { limit: 30 } })
      .then((rows) => { if (!cancelled) setRecent(Array.isArray(rows) ? rows : []); })
      .catch((e) => { if (!cancelled) setRecentError(e instanceof Error && e.message ? e.message : '最近做卡记录读取失败'); });
    return () => { cancelled = true; };
  }, [recentRetry]);

  const refreshCardDetail = useCallback(async (cardId: number) => {
    const detail = await request<CardDetail>({ url: '/cards/' + cardId });
    setCardDetails((prev) => ({ ...prev, [cardId]: detail }));
    return detail;
  }, []);

  const openGrant = (card: CardHistoryRow) => {
    setGrantCard(card); setGrantMode('add'); setGrantSearch(''); setGrantSelected([]); setGrantResults(null);
    void refreshCardDetail(card.id)
      .then((detail) => setGrantSelected(Array.isArray(detail.grantedBuildings) ? detail.grantedBuildings.map(String) : []))
      .catch(() => undefined);
  };
  const submitApply = async () => {
    if (!applyCard || applyBusy) return;
    setApplyBusy(true);
    try {
      const raw = await request<unknown>({ method: 'POST', url: '/cards/' + applyCard.id + '/apply-mdb', data: { systems: ['iccard'] } });
      setApplyResults(cardActionResults(raw));
      await refreshCardDetail(applyCard.id);
    } catch (e) {
      setApplyResults([{ name: 'iccard', ok: false, detail: e instanceof Error && e.message ? e.message : '写入失败' }]);
    } finally { setApplyBusy(false); }
  };
  const openApply = (card: CardHistoryRow) => { setApplyCard(card); setApplyResults(null); };
  const submitGrant = async () => {
    if (!grantCard || grantBusy) return;
    if (!grantSelected.length) { setGrantResults([{ buildingNo: '—', status: '失败', ok: false, detail: '请至少选择一栋楼' }]); return; }
    setGrantBusy(true);
    try {
      const raw = await request<unknown>({ method: 'POST', url: '/cards/' + grantCard.id + '/grant-boards', data: { buildingNos: grantSelected, mode: grantMode } });
      setGrantResults(grantResultRows(raw));
      await refreshCardDetail(grantCard.id);
    } catch (e) {
      setGrantResults([{ buildingNo: '—', status: '失败', ok: false, detail: e instanceof Error && e.message ? e.message : '楼栋授权失败' }]);
    } finally { setGrantBusy(false); }
  };
  const pickRecentHouse = (row: CardRecent) => {
    if (!row.communityId || !row.houseId || !row.buildingNo || !row.roomNo) { toast('该记录缺少房号信息，无法跳转'); return; }
    const lane = row.lane ?? null;
    const buildingText = row.buildingText || [row.communityName, lane ? lane + '弄' : '', row.buildingNo + '号'].filter(Boolean).join('');
    const shortText = row.roomLabel || [row.communityName, lane ? lane + '弄' : '', row.buildingNo + '号', row.roomNo].filter(Boolean).join('/');
    setPicked({
      communityId: row.communityId, communityName: row.communityName || '', lane, buildingId: row.buildingId || 0,
      buildingNo: row.buildingNo, buildingText, houseId: row.houseId, roomNo: row.roomNo,
      ownerName: row.ownerName || null, ownerPhone: row.ownerPhone || null, ownerId: row.ownerId || null,
      text: [buildingText, row.roomNo + '室'].filter(Boolean).join(''), shortText,
    });
    setBatch(null);
    setHistoryRetry((value) => value + 1);
  };

  useEffect(() => {
    if (!batch) return undefined;
    const done = batch.items.every((i) => i.cardStatus === 'card_completed' || i.cardStatus === 'card_failed');
    if (done) return undefined;
    timer.current = window.setTimeout(() => {
      accessCardIssuance.batch(batch.id).then(setBatch).catch(() => undefined);
    }, 3000);
    return () => { if (timer.current) window.clearTimeout(timer.current); };
  }, [batch]);

  const startBatch = async () => {
    if (!can('business', 'edit')) return;
    if (!picked?.houseId) { toast('先选一户'); return; }
    setBusy('create');
    try {
      const r = await accessCardIssuance.createBatch({
        houseId: picked.houseId,
        quantity: qty,
        extraBuildingIds: [],
        workstationId: issuer?.id,
        idempotencyKey: crypto.randomUUID ? crypto.randomUUID() : String(Date.now()),
      });
      setBatch(r);
      toast('发卡任务已建立，请把第 1 张卡放到读卡器上');
    } catch (e) {
      toast(e instanceof Error ? e.message : '创建发卡任务失败');
    } finally { setBusy(''); }
  };

  const retryAccess = async (item: AccessCardIssueItem) => {
    if (!can('business', 'edit')) return;
    if (!batch) return;
    setBusy(`retry-${item.id}`);
    try { setBatch(await accessCardIssuance.retryAccessUpload(batch.id, item.id)); toast('已重新下发'); }
    catch (e) { toast(e instanceof Error ? e.message : '重试失败'); }
    finally { setBusy(''); }
  };

  const cur = batch?.items.find((i) => i.cardStatus !== 'card_completed');

  const historyRows = history?.rows ?? [];
  const fieldsIncomplete = !!history?.fieldsIncomplete || historyRows.some((row) => !row.personNo || !row.personCreatedAt || !row.icCardNo || !row.wgCardNo || !row.lastSwipeAt || !row.lastDevice);
  const buildingOptions = useMemo(() => {
    const community = tree.find((item) => item.id === picked?.communityId);
    const list = (community?.buildings ?? []).map((building) => ({ no: building.buildingNo, label: (building.lane ? building.lane + '弄' : '') + building.buildingNo + '号' }));
    for (const no of grantSelected) if (!list.some((item) => item.no === no)) list.push({ no, label: no + '号' });
    return list;
  }, [tree, picked?.communityId, grantSelected]);
  const visibleBuildings = buildingOptions.filter((item) => !grantSearch.trim() || item.label.includes(grantSearch.trim()) || item.no.includes(grantSearch.trim()));

  return (
    <>
      <div className="ph" style={{ marginBottom: 14 }}>
        <div>
          <div className="h1row"><ToneIcon kind="cards" /><h1 style={{ fontSize: 22 }}>门禁卡管理</h1></div>
          <p>按户发卡、查卡与发卡历史；写卡由装了读卡器的工作站自动完成</p>
        </div>
        <div className="act">
          <span className={`tag ${issuer ? 'ok' : 'warn'}`}><Icon name={issuer ? 'check' : 'alert'} />{issuer ? '发卡工作站在线' : '发卡工作站离线'}</span>
        </div>
      </div>

      <DoorControlPanel communities={communities} canEdit={canEdit} />

      <div className="findBar" style={{ marginBottom: 14 }}>
        <HousePicker communities={communities} value={picked}
          onPick={(p) => { setPicked(p); setBatch(null); }}
          onClear={() => { setPicked(null); setBatch(null); }}
          onIncomplete={() => toast('请再点一下具体室号：发卡要落到具体一户')} />
      </div>

      {err ? <div className="note2" style={{ background: 'var(--dang-w)', color: 'var(--dang)', marginBottom: 12 }}><Icon name="alert" />{err}</div> : null}

      {!picked ? (
        <div className="card" style={{ padding: '56px 20px', textAlign: 'center' }}>
          <Icon name="key" size={42} style={{ color: 'var(--ink4)', marginBottom: 10 }} />
          <div className="muted" style={{ fontSize: 15 }}>选一户，发卡或查看这一户的门禁卡</div>
        </div>
      ) : (
        <>
          <div className="card" style={{ padding: '14px 16px', marginBottom: 14 }}>
            <div className="panelHd" style={{ marginBottom: 12 }}>
              <b>发门禁卡</b>
              <span className="muted" style={{ marginLeft: 8 }}>{picked.communityName} {picked.buildingNo}/{picked.roomNo}</span>
            </div>
            {!batch ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                <button className="btn" onClick={() => setQty((n) => Math.max(1, n - 1))}>−</button>
                <b style={{ fontSize: 20, minWidth: 28, textAlign: 'center' }}>{qty}</b>
                <button className="btn" onClick={() => setQty((n) => Math.min(20, n + 1))}>＋</button>
                <span className="muted">张</span>
                <button className="btn p" style={{ marginLeft: 'auto' }} disabled={!canEdit || busy === 'create'} onClick={() => void startBatch()}>
                  <Icon name="key" size={16} />{busy === 'create' ? '建立中…' : '开始发卡'}
                </button>
              </div>
            ) : (
              <>
                <div className="note" style={{ marginBottom: 10 }}>
                  任务 #{batch.id} · 共 {batch.quantity} 张{batch.currentSequence ? ` · 当前第 ${batch.currentSequence} 张` : ''}
                  {cur && cur.cardStatus !== 'card_completed' ? '：请把这张卡放到读卡器上' : ''}
                </div>
                <div className="t-scroll">
                  <table className="t" style={{ minWidth: 760 }}>
                    <thead><tr><th style={{ width: 60 }}>序号</th><th>卡号</th><th>写卡</th><th>门禁授权</th><th>旧库同步</th><th style={{ width: 96 }}>操作</th></tr></thead>
                    <tbody>
                      {batch.items.map((it) => {
                        const cs = cardStatusLabel(it.cardStatus);
                        const as = accessStatusLabel(it.accessStatus);
                        const ls = legacyStatusLabel(it.legacySyncStatus);
                        const canRetry = !!it.icCardNo && /^(waiting_retry|needs_operator|permission_check_failed|not_uploaded)$/.test(it.accessStatus || '');
                        return (
                          <tr key={it.id}>
                            <td className="nw muted">{it.sequence}</td>
                            <td className="nw"><b>{it.icCardNo || '—'}</b>{it.wgCardNo ? <span className="muted"> · WG {it.wgCardNo}</span> : null}</td>
                            <td className="nw"><span className={`tag ${cs.tone}`}>{cs.text}</span></td>
                            <td className="nw"><span className={`tag ${as.tone}`} title={rawTitle(it.accessStatus)}>{as.text}</span></td>
                            <td className="nw"><span className={`tag ${ls.tone}`} title={rawTitle(it.legacySyncStatus)}>{ls.text}</span></td>
                            <td className="nw">
                              {canEdit && canRetry ? <button className="btn g sm" disabled={busy === `retry-${it.id}`} onClick={() => void retryAccess(it)}><Icon name="refresh" size={15} />重试下发</button> : null}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                {batch.items.some((i) => i.lastErrorMessage) ? (
                  <div className="note2" style={{ marginTop: 8, color: 'var(--dang)' }}>{batch.items.filter((i) => i.lastErrorMessage).map((i) => `第 ${i.sequence} 张：${i.lastErrorMessage}`).join('；')}</div>
                ) : null}
                <div style={{ marginTop: 12 }}>
                  <button className="btn" onClick={() => { setBatch(null); if (picked) loadHouse(picked.houseId); }}>结束 / 看结果</button>
                </div>
              </>
            )}
            <div className="note2" style={{ marginTop: 10 }}>
              <Icon name="alert" />写卡要读卡器，由{issuer ? `在线工作站「${issuer.name}」` : '工作站'}自动完成；本页负责建任务、看进度、下发失败单张重试。
            </div>
          </div>

          <div className="card" style={{ padding: '14px 16px', marginBottom: 14 }}>
            <div className="panelHd" style={{ marginBottom: 10 }}>
              <b>在用门禁卡</b>
              <span className="tag mute" style={{ marginLeft: 8 }}>{cards?.length ?? 0} 张</span>
            </div>
            {cards === null ? <Loading text="读门禁卡…" /> : cards.length === 0 ? (
              <div className="muted">这一户还没有在用门禁卡</div>
            ) : cards.map((c) => (
              <div key={c.id} className="cardItem">
                <div className="ci"><Icon name="key" /></div>
                <div className="bt" style={{ flex: 1 }}><b>卡号 {c.cardNo}</b><small className="muted">{c.status === 'active' || !c.status ? '正常' : c.status}</small></div>
                <span className="tag ok"><Icon name="check" />有效</span>
              </div>
            ))}
          </div>

          <div className="card" style={{ padding: '14px 16px', marginBottom: 14 }}>
            <div className="panelHd" style={{ marginBottom: 10 }}>
              <b>发卡历史</b>
              {historyRows.length ? <span className="tag mute" style={{ marginLeft: 8 }}>{historyRows.length} 张</span> : null}
              {historyRetrying ? <span className="tag warn" style={{ marginLeft: 8 }}>助手回传中，3 秒后重试…</span> : null}
              {history?.refreshedAt ? <span className="muted" style={{ marginLeft: 8, fontSize: 12 }}>更新于 {fmtCardTime(history.refreshedAt)}</span> : null}
            </div>
            <div className="note2" style={{ marginBottom: 10 }}>
              <Icon name="alert" />数据来自捷顺系统；字段由现场助手回传。
              {fieldsIncomplete ? <span className="ac-field-hint">部分字段需升级现场助手后显示</span> : null}
            </div>
            {historyError ? (
              <div className="note2" role="alert" style={{ color: 'var(--dang)' }}>
                <Icon name="alert" />{historyError}
                <button className="btn sm" style={{ marginLeft: 10 }} onClick={() => setHistoryRetry((value) => value + 1)}>重试</button>
              </div>
            ) : history === null ? <Loading text="读发卡记录…" /> : historyRows.length === 0 ? (
              <div className="muted">该户在捷顺系统里没有发卡记录</div>
            ) : (
              <div className="t-scroll">
                <table className="t ac-history-table">
                  <thead><tr><th>序号</th><th>编号</th><th>房号</th><th>人事资料添加时间</th><th>IC卡号</th><th>WG卡号</th><th>发卡时间</th><th>最后刷卡时间</th><th>出入口</th><th>状态</th><th>操作</th></tr></thead>
                  <tbody>
                    {historyRows.map((row) => {
                      const detail = cardDetails[row.id];
                      const hidden = !!row.hidden;
                      const room = String(row.roomLabel || '').replace(/已隐藏/g, '').replace(/^[\s·\-]+/, '') || '—';
                      const statusText = hidden ? '已隐藏' : (row.status || '—');
                      return (
                        <Fragment key={row.id}>
                          <tr className={hidden ? 'ac-hidden-row' : undefined}>
                            <td className="nw muted">{row.sequence ?? '—'}</td>
                            <td className="nw">{row.personNo || '—'}</td>
                            <td className="nw"><b>{room}</b>{hidden ? <span className="tag mute" style={{ marginLeft: 6 }}>已隐藏</span> : null}</td>
                            <td className="nw">{fmtCardTime(row.personCreatedAt)}</td>
                            <td className="nw">{row.icCardNo || '—'}</td>
                            <td className="nw">{row.wgCardNo || '—'}</td>
                            <td className="nw">{fmtCardTime(row.issuedAt)}</td>
                            <td className="nw">{fmtCardTime(row.lastSwipeAt)}</td>
                            <td className="nw">{row.lastDevice || '—'}</td>
                            <td className="nw"><span className={'tag ' + (hidden ? 'mute' : 'ok')}>{statusText}</span></td>
                            <td className="nw ac-actions">
                              {canEdit ? <>
                                <button className="btn sm" onClick={() => openApply(row)}>写入 Access</button>
                                <button className="btn sm" onClick={() => openGrant(row)}>授权楼栋</button>
                              </> : '—'}
                            </td>
                          </tr>
                          {detail ? (
                            <tr className="ac-detail-row">
                              <td colSpan={11}>
                                <div className="ac-card-detail">
                                  <span><b>已应用系统：</b>{(detail.appliedSystems ?? []).length ? (detail.appliedSystems ?? []).join('、') : '—'}</span>
                                  <span><b>已授权楼栋：</b>{(detail.grantedBuildings ?? []).length ? (detail.grantedBuildings ?? []).join('、') : '—'}</span>
                                  <span><b>最新任务：</b>{(detail.latestTasks ?? []).length ? (detail.latestTasks as any[]).map((task) => task?.status ?? task?.type ?? '—').join('、') : '—'}</span>
                                </div>
                              </td>
                            </tr>
                          ) : null}
                        </Fragment>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <div className="card" style={{ padding: '14px 16px', marginBottom: 14 }}>
            <div className="panelHd" style={{ marginBottom: 10 }}>
              <b>最近 30 笔做卡记录</b>
              {recent?.length ? <span className="tag mute" style={{ marginLeft: 8 }}>{recent.length} 笔</span> : null}
            </div>
            {recentError ? (
              <div className="note2" role="alert" style={{ color: 'var(--dang)' }}><Icon name="alert" />{recentError}<button className="btn sm" style={{ marginLeft: 10 }} onClick={() => setRecentRetry((value) => value + 1)}>重试</button></div>
            ) : recent === null ? <Loading text="读最近做卡记录…" /> : recent.length === 0 ? (
              <div className="muted">暂无最近做卡记录</div>
            ) : (
              <div className="t-scroll">
                <table className="t ac-recent-table">
                  <thead><tr><th>卡号(IC/WG)</th><th>房号</th><th>发卡时间</th><th>操作</th></tr></thead>
                  <tbody>
                    {recent.map((row) => (
                      <tr key={row.id} className="ac-recent-row" onClick={() => pickRecentHouse(row)}>
                        <td className="nw"><b>{row.icCardNo || '—'}</b>{row.wgCardNo ? <span className="muted"> / WG {row.wgCardNo}</span> : null}</td>
                        <td className="nw">{String(row.roomLabel || '').replace(/已隐藏/g, '').trim() || '—'}</td>
                        <td className="nw">{fmtCardTime(row.issuedAt)}</td>
                        <td className="nw"><button className="btn sm" onClick={(event) => { event.stopPropagation(); pickRecentHouse(row); }}>查看该户历史</button></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

      <Sheet open={!!applyCard} onClose={() => { if (!applyBusy) setApplyCard(null); }} width={560} title="写入 Access 系统" subtitle={applyCard ? '卡 ' + (applyCard.icCardNo || applyCard.wgCardNo || '—') + ' · ' + (applyCard.roomLabel || '') : ''}>
        {applyCard ? (
          <>
            <div className="note2" style={{ marginBottom: 12 }}>将把 IC 卡写入现场 .88 Access 系统，确认后执行。</div>
            {applyResults ? (
              <div className="ac-results">
                {applyResults.map((result) => <div key={result.name} className={result.ok ? 'ok' : 'dang'}><b>{result.name}</b><span>{result.ok ? '成功' : '失败'} · {result.detail}</span></div>)}
              </div>
            ) : null}
            <div className="ac-dialog-foot">
              <button className="btn" disabled={applyBusy} onClick={() => setApplyCard(null)}>取消</button>
              <button className="btn p" disabled={applyBusy} onClick={() => void submitApply()}>{applyBusy ? '写入中…' : applyResults ? '再次写入' : '确认写入'}</button>
            </div>
          </>
        ) : null}
      </Sheet>

      <Sheet open={!!grantCard} onClose={() => { if (!grantBusy) setGrantCard(null); }} width={640} title="授权楼栋" subtitle={grantCard ? '卡 ' + (grantCard.icCardNo || grantCard.wgCardNo || '—') + ' · ' + (grantCard.roomLabel || '') : ''}>
        {grantCard ? (
          <>
            <div className="ac-grant-tools">
              <input className="in" placeholder="搜索楼栋" value={grantSearch} onChange={(event) => setGrantSearch(event.target.value)} />
              <div className="chips">
                <button className={'chip ' + (grantMode === 'add' ? 'on' : '')} onClick={() => setGrantMode('add')}>添加权限</button>
                <button className={'chip ' + (grantMode === 'remove' ? 'on' : '')} onClick={() => setGrantMode('remove')}>撤销权限</button>
              </div>
            </div>
            <div className="ac-building-list">
              {visibleBuildings.map((building) => (
                <label key={building.no} className="ac-building-item">
                  <input type="checkbox" checked={grantSelected.includes(building.no)} onChange={(event) => setGrantSelected((prev) => event.target.checked ? [...prev, building.no] : prev.filter((no) => no !== building.no))} />
                  <span>{building.label}</span>
                </label>
              ))}
              {!visibleBuildings.length ? <div className="muted">没有匹配楼栋</div> : null}
            </div>
            {grantResults ? (
              <div className="ac-results">
                {grantResults.map((result, index) => <div key={result.buildingNo + index} className={result.ok ? 'ok' : result.status === '离线' ? 'warn' : 'dang'}><b>{result.buildingNo} 号</b><span>{result.status}{result.detail && result.detail !== result.status ? ' · ' + result.detail : ''}</span></div>)}
              </div>
            ) : null}
            <div className="ac-dialog-foot">
              <button className="btn" disabled={grantBusy} onClick={() => setGrantCard(null)}>取消</button>
              <button className="btn p" disabled={grantBusy} onClick={() => void submitGrant()}>{grantBusy ? '提交中…' : (grantMode === 'add' ? '确认授权' : '确认撤销')}</button>
            </div>
          </>
        ) : null}
      </Sheet>

        </>
      )}
    </>
  );
}

// ───────────────────────── 远程门禁（立即开门 / 常开） ─────────────────────────
const MIN_GATEWAY_VERSION = '2.5.46';

type DoorOperation = 'remote_open' | 'temporary_open';
type DoorStatus = 'online' | 'offline' | 'pending' | 'unknown';
interface DoorController {
  communityId: number; communityName?: string | null;
  controllerId: number; buildingNo: string; doorNo: number | null; doorName: string;
  controllerName: string | null; accessSystem: string; routeReady?: boolean;
  status: DoorStatus; supportRemoteOpen: boolean; supportTemporaryOpen: boolean;
  lastOperation?: string | null; lastCheckedAt: string | null; lastError: string | null;
}
interface DoorControllers { agentOnline: boolean; gatewayVersion: string | null; checkedAt: string; controllers: DoorController[] }
interface DoorTask {
  taskId: number; operation: string; status: 'pending' | 'sent' | 'succeeded' | 'failed'; rawStatus?: string;
  controllerId?: number | null; doorNo?: number | null; buildingNo?: string | null;
  accessSystem?: string | null; minutes?: number | null; controller?: string | null; door?: string | null;
  protocol?: string | null; acknowledgement?: string | null; receipt?: Record<string, unknown> | null;
  error?: string | null; attempt?: number; requestedAt?: string; completedAt?: string | null;
}

const DOOR_STATUS: Record<DoorStatus, { text: string; tone: string }> = {
  online: { text: '在线', tone: 'ok' },
  offline: { text: '离线', tone: 'mute' },
  pending: { text: '未探测', tone: 'warn' },
  unknown: { text: '未探测', tone: 'warn' },
};
const DOOR_TASK: Record<DoorTask['status'], { text: string; tone: string; hint: string }> = {
  pending: { text: '已提交', tone: 'warn', hint: '已入队，等待网关领取' },
  sent: { text: '发送中', tone: 'blue', hint: '网关已领取，正在发往控制器' },
  succeeded: { text: '成功', tone: 'ok', hint: '控制器已回执确认' },
  failed: { text: '失败', tone: 'dang', hint: '控制器明确失败，请查看错误信息' },
};
const SYSTEM_LABEL: Record<string, string> = { iccard: 'IC 卡', mjsystem: 'MjSystem' };
const operationLabel = (op: DoorOperation) => (op === 'remote_open' ? '立即开门' : '常开');

/** 网关版本是否 ≥ 2.5.46；解析失败按不满足处理，避免误开。 */
function gatewayAtLeast(version: string | null, min: string) {
  if (!version) return false;
  const parse = (v: string) => (v.split(/[.+-]/).slice(0, 3).map((part) => Number(part)).map((n) => (Number.isFinite(n) ? n : 0)));
  const a = parse(version), b = parse(min);
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return true;
}
function newIdempotencyKey() {
  try { return crypto.randomUUID(); } catch { return 'door-' + Date.now() + '-' + Math.random().toString(16).slice(2); }
}
const fmtDoorTime = (value: string | null | undefined) => (value ? dayjs(value).format('YYYY-MM-DD HH:mm:ss') : '—');

function DoorControlPanel({ communities, canEdit }: { communities: AddressCommunity[]; canEdit: boolean }) {
  const [communityId, setCommunityId] = useState<number | null>(communities[0]?.id ?? null);
  const [data, setData] = useState<DoorControllers | null>(null);
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);
  const [dialog, setDialog] = useState<{ controller: DoorController; operation: DoorOperation } | null>(null);
  const [phase, setPhase] = useState<'form' | 'confirm' | 'task'>('form');
  const [minutes, setMinutes] = useState(5);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [submitError, setSubmitError] = useState('');
  const [task, setTask] = useState<DoorTask | null>(null);
  const [taskError, setTaskError] = useState('');
  const idemKey = useRef('');
  const checkSeq = useRef(0);
  const [collapsed, setCollapsed] = useState(false);
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    setCommunityId((prev) => (prev != null && communities.some((c) => c.id === prev) ? prev : communities[0]?.id ?? null));
  }, [communities]);

  useEffect(() => {
    try {
      if (localStorage.getItem('accessDoor.collapsed') === '1') setCollapsed(true);
    } catch { /* 隐私模式不可用时保持默认展开 */ }
  }, []);

  // 小区切换/卸载时中止正在进行的在线检查轮询
  useEffect(() => () => { checkSeq.current += 1; }, [communityId]);

  const toggleCollapsed = () => {
    setCollapsed((prev) => {
      const next = !prev;
      try { localStorage.setItem('accessDoor.collapsed', next ? '1' : '0'); } catch { /* 忽略 */ }
      return next;
    });
  };

  useEffect(() => {
    if (communityId == null) { setData({ agentOnline: false, gatewayVersion: null, checkedAt: new Date().toISOString(), controllers: [] }); return undefined; }
    let alive = true;
    setData(null); setError('');
    request<DoorControllers>({ url: '/access-card-issuance/door/controllers', query: { communityId } })
      .then((r) => { if (alive) setData(r); })
      .catch((e) => { if (alive) { setData(null); setError(e instanceof Error ? e.message : '控制器列表读取失败'); } });
    return () => { alive = false; };
  }, [communityId, reload]);

  // 任务轮询：pending/sent 时每 1.2s 查一次，成功后停止。
  useEffect(() => {
    if (!task || (task.status !== 'pending' && task.status !== 'sent')) return undefined;
    let alive = true;
    const timer = window.setTimeout(() => {
      request<DoorTask>({ url: '/access-card-issuance/door/task/' + task.taskId })
        .then((next) => { if (alive) { setTaskError(''); setTask(next); } })
        .catch(() => { if (alive) setTaskError('任务状态读取失败，可点击“重新查询”继续。'); });
    }, 1200);
    return () => { alive = false; window.clearTimeout(timer); };
  }, [task]);

  const gatewayReady = !!data && data.agentOnline && gatewayAtLeast(data.gatewayVersion, MIN_GATEWAY_VERSION);
  const gatewayHint = !data
    ? ''
    : !data.agentOnline ? '门禁助手离线，远程开门已禁用。请检查助手运行状态后刷新。'
      : !gatewayAtLeast(data.gatewayVersion, MIN_GATEWAY_VERSION) ? `网关版本 ${data.gatewayVersion || '未知'} 低于 ${MIN_GATEWAY_VERSION}，远程开门已禁用，请升级助手。`
        : '';

  const openDialog = (controller: DoorController, operation: DoorOperation) => {
    if (!canEdit || !gatewayReady) return;
    setDialog({ controller, operation });
    setPhase('form');
    setMinutes(5);
    setReason('');
    setSubmitError('');
    setTask(null);
    setTaskError('');
    idemKey.current = '';
  };
  const closeDialog = () => {
    setDialog(null); setPhase('form'); setTask(null); setTaskError(''); setSubmitError(''); idemKey.current = '';
  };
  const submit = async () => {
    if (!dialog) return;
    if (!reason.trim()) { toast('请填写开门原因'); return; }
    if (dialog.operation === 'temporary_open' && (!Number.isInteger(minutes) || minutes < 1 || minutes > 60)) { toast('常开分钟数需在 1–60 之间'); return; }
    setBusy(true); setSubmitError('');
    if (!idemKey.current) idemKey.current = newIdempotencyKey();
    try {
      const r = await request<DoorTask>({
        method: 'POST', url: '/access-card-issuance/door/open',
        data: {
          communityId: dialog.controller.communityId,
          controllerId: dialog.controller.controllerId,
          doorNo: dialog.controller.doorNo ?? undefined,
          operation: dialog.operation,
          minutes: dialog.operation === 'temporary_open' ? minutes : undefined,
          reason: reason.trim(),
          idempotencyKey: idemKey.current,
        },
      });
      setTask(r); setPhase('task');
    } catch (e) {
      // 超时/网络失败：保留 idempotencyKey，重试复用同一把钥匙，避免重复开门。
      setSubmitError(e instanceof Error ? e.message : '提交失败，请稍后重试');
    } finally { setBusy(false); }
  };
  const repoll = () => {
    if (!task) return;
    setTaskError('');
    request<DoorTask>({ url: '/access-card-issuance/door/task/' + task.taskId })
      .then((next) => setTask(next))
      .catch(() => setTaskError('任务状态读取失败，请稍后再试。'));
  };

  const controllers = data?.controllers ?? [];
  const sleep = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms));
  /** 下发在线检查后每 2s 拉一次控制器列表，最多 15 次。 */
  const checkOnline = async () => {
    if (checking || communityId == null || !data?.agentOnline) return;
    const run = ++checkSeq.current;
    setChecking(true);
    try {
      const res = await request<{ controllerCount?: number; count?: number; controllers?: unknown[] }>({
        method: 'POST', url: '/access-card-issuance/door/check-online', data: { communityId },
      });
      const count = Number(res?.controllerCount ?? res?.count ?? (Array.isArray(res?.controllers) ? res.controllers.length : controllers.length)) || controllers.length;
      toast('已下发检查，' + count + ' 个控制器');
    } catch (e) {
      if (checkSeq.current === run) {
        setChecking(false);
        toast(e instanceof Error ? e.message : '下发检查失败，请稍后重试');
      }
      return;
    }
    let latest = controllers;
    for (let attempt = 0; attempt < 15; attempt += 1) {
      await sleep(2000);
      if (checkSeq.current !== run) return;
      try {
        const next = await request<DoorControllers>({ url: '/access-card-issuance/door/controllers', query: { communityId } });
        if (checkSeq.current !== run) return;
        latest = next.controllers;
        setData(next);
        setError('');
      } catch { /* 单次失败继续下一轮 */ }
    }
    if (checkSeq.current !== run) return;
    setChecking(false);
    toast('已更新 ' + latest.length + ' 个控制器状态');
  };
  const taskMeta = task ? DOOR_TASK[task.status] : null;

  return (
    <div className="card door-panel">
      <div className="panelHd door-head">
        <div className="door-title">
          <button type="button" className={`door-collapse${collapsed ? ' is-collapsed' : ''}`} aria-expanded={!collapsed} aria-label={collapsed ? '展开远程门禁' : '折叠远程门禁'} title={collapsed ? '展开' : '折叠'} onClick={toggleCollapsed}>
            <span className="door-chevron" aria-hidden="true">{collapsed ? '▸' : '▾'}</span>
          </button>
          <b><Icon name="lock" size={17} /> 远程门禁</b>
          {!collapsed ? <span className="muted door-sub">现场开门前置控制 · 立即开门 / 常开</span> : null}
        </div>
        <div className="door-head-actions">
          {data ? (
            <span className={`tag ${data.agentOnline ? 'ok' : 'dang'}`} title={gatewayHint || undefined}>
              <Icon name={data.agentOnline ? 'check' : 'alert'} />助手{data.agentOnline ? '在线' : '离线'}
            </span>
          ) : null}
          {!collapsed && data?.gatewayVersion ? <span className="tag mute">网关 {data.gatewayVersion}</span> : null}
          {!collapsed && data?.checkedAt ? <span className="muted" style={{ fontSize: 12.5 }}>检测 {fmtDoorTime(data.checkedAt)}</span> : null}
          {!collapsed ? (
            <select className="in" style={{ width: 180 }} value={communityId ?? ''} onChange={(e) => setCommunityId(e.target.value ? Number(e.target.value) : null)} aria-label="远程门禁小区">
              {communities.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          ) : null}
          <button className="btn sm door-check" disabled={checking || !data?.agentOnline} title={!data?.agentOnline ? '门禁助手离线，无法检查' : '重新检查控制器在线状态'} onClick={() => void checkOnline()}>
            {checking ? <><Icon name="refresh" size={15} />检查中…</> : '重新检查在线状态'}
          </button>
          {!collapsed ? <button className="btn sm" onClick={() => setReload((v) => v + 1)}><Icon name="refresh" size={15} />刷新</button> : null}
        </div>
      </div>

      {!collapsed ? (
      <div className="door-body">
      {!canEdit ? <div className="note2" style={{ marginTop: 8 }}><Icon name="alert" />当前账号只有「业务查看」权限，远程开门按钮不可用。</div> : null}
      {error ? <div className="note2" style={{ background: 'var(--dang-w)', color: 'var(--dang)', marginTop: 10 }}><Icon name="alert" />{error}<button className="btn sm" style={{ marginLeft: 10 }} onClick={() => setReload((v) => v + 1)}>重试</button></div> : null}
      {data && !gatewayReady ? (
        <div className="note2 door-disabled" style={{ marginTop: 10 }}>
          <Icon name="alert" />{gatewayHint || '网关未就绪（需要助手在线且版本 ≥ ' + MIN_GATEWAY_VERSION + '），远程开门已禁用。'}
        </div>
      ) : null}

      {data === null && !error ? <Loading text="读取门禁控制器…" /> : data && controllers.length === 0 ? (
        <div className="muted" style={{ padding: '18px 4px' }}>当前小区没有可远程控制的门禁控制器（仅二期联网门禁支持）。</div>
      ) : data ? (
        <div className="t-scroll door-table">
          <table className="t" style={{ minWidth: 880 }}>
            <thead>
              <tr><th className="nw">楼栋</th><th className="nw">门名</th><th className="nw">系统</th><th className="nw">在线状态</th><th className="nw">最后检测</th><th className="nw" style={{ width: 210 }}>操作</th></tr>
            </thead>
            <tbody>
              {controllers.map((row) => {
                const st = DOOR_STATUS[row.status] || DOOR_STATUS.unknown;
                const disabled = !canEdit || !gatewayReady;
                return (
                  <tr key={row.controllerId}>
                    <td className="nw"><b>{row.buildingNo}</b>{row.doorNo != null ? <span className="muted"> 号楼 / 门{row.doorNo}</span> : null}</td>
                    <td className="nw">{row.doorName || '—'}{row.controllerName ? <small className="muted"> · {row.controllerName}</small> : null}</td>
                    <td className="nw"><span className="tag mute">{SYSTEM_LABEL[row.accessSystem] || row.accessSystem}</span></td>
                    <td className="nw"><span className={`tag ${st.tone}`}>{st.text}</span>{row.lastError ? <small className="door-row-err" title={row.lastError}>{row.lastError}</small> : null}</td>
                    <td className="nw">{fmtDoorTime(row.lastCheckedAt)}</td>
                    <td className="nw door-actions">
                      <button
                        className="btn sm"
                        disabled={disabled || !row.supportRemoteOpen}
                        title={!canEdit ? '需要业务编辑权限' : !gatewayReady ? '助手离线或网关版本过低' : '立即开门'}
                        onClick={() => openDialog(row, 'remote_open')}
                      ><Icon name="key" size={15} />立即开门</button>
                      <button
                        className="btn sm"
                        disabled={disabled || !row.supportTemporaryOpen}
                        title={!row.supportTemporaryOpen ? '该控制器仅支持立即开门' : !canEdit ? '需要业务编辑权限' : !gatewayReady ? '助手离线或网关版本过低' : '常开（1–60 分钟）'}
                        onClick={() => openDialog(row, 'temporary_open')}
                      ><Icon name="clock" size={15} />常开</button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}
      </div>
      ) : null}

      {dialog ? (
        <div className="door-mask" role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget) closeDialog(); }}>
          <div className="door-dialog" role="dialog" aria-modal="true" aria-label="远程开门确认">
            <div className="door-dialog-head">
              <b>{phase === 'task' ? '开门任务' : (phase === 'confirm' ? '确认远程开门' : operationLabel(dialog.operation))}</b>
              <button className="btn sm g" onClick={closeDialog}>关闭</button>
            </div>

            {phase !== 'task' ? (
              <>
                <div className="door-summary">
                  <div><span>楼栋</span><b>{dialog.controller.buildingNo} 号楼</b></div>
                  <div><span>门</span><b>{dialog.controller.doorName}{dialog.controller.doorNo != null ? `（门${dialog.controller.doorNo}）` : ''}</b></div>
                  <div><span>系统</span><b>{SYSTEM_LABEL[dialog.controller.accessSystem] || dialog.controller.accessSystem}</b></div>
                  <div><span>操作</span><b>{operationLabel(dialog.operation)}{dialog.operation === 'temporary_open' ? ` · ${minutes} 分钟` : ''}</b></div>
                </div>

                {phase === 'form' ? (
                  <>
                    {dialog.operation === 'temporary_open' ? (
                      <div className="door-form">
                        <label>常开分钟数（1–60，默认 5）
                          <div className="door-quick">
                            {[5, 10, 30].map((m) => <button key={m} type="button" className={`chip ${minutes === m ? 'on' : ''}`} onClick={() => setMinutes(m)}>{m} 分钟</button>)}
                            <input className="in" style={{ width: 90 }} type="number" min={1} max={60} value={minutes} onChange={(e) => setMinutes(Math.max(1, Math.min(60, Number(e.target.value) || 1)))} aria-label="常开分钟数" />
                          </div>
                        </label>
                      </div>
                    ) : null}
                    <label className="door-form">开门原因（必填）
                      <textarea className="in" rows={3} value={reason} maxLength={200} placeholder="例如：业主忘带卡，已电话核实身份，门边有人" onChange={(e) => setReason(e.target.value)} aria-label="开门原因" />
                    </label>
                    {submitError ? <div className="note2" style={{ background: 'var(--dang-w)', color: 'var(--dang)' }}><Icon name="alert" />{submitError}<button className="btn sm" style={{ marginLeft: 10 }} disabled={busy} onClick={() => void submit()}>重试（复用同一请求）</button></div> : null}
                    <div className="door-dialog-foot">
                      <button className="btn" onClick={closeDialog}>取消</button>
                      <button className="btn p" disabled={busy} onClick={() => {
                        if (!reason.trim()) { toast('请填写开门原因'); return; }
                        if (dialog.operation === 'temporary_open' && (minutes < 1 || minutes > 60)) { toast('常开分钟数需在 1–60 之间'); return; }
                        setPhase('confirm');
                      }}>下一步</button>
                    </div>
                  </>
                ) : (
                  <>
                    <div className="door-warn" role="alert"><Icon name="alert" size={20} /><b>将现场开门，确认门边有人</b></div>
                    <div className="door-summary" style={{ marginTop: 10 }}>
                      <div><span>原因</span><b>{reason}</b></div>
                    </div>
                    {submitError ? <div className="note2" style={{ background: 'var(--dang-w)', color: 'var(--dang)' }}><Icon name="alert" />{submitError}<button className="btn sm" style={{ marginLeft: 10 }} disabled={busy} onClick={() => void submit()}>重试（复用同一请求）</button></div> : null}
                    <div className="door-dialog-foot">
                      <button className="btn" disabled={busy} onClick={() => setPhase('form')}>返回修改</button>
                      <button className="btn p" disabled={busy} onClick={() => void submit()}>{busy ? '提交中…' : '确认开门'}</button>
                    </div>
                  </>
                )}
              </>
            ) : task && taskMeta ? (
              <>
                <div className="door-task-status">
                  <span className={`tag ${taskMeta.tone}`}>{taskMeta.text}</span>
                  <b>{taskMeta.hint}</b>
                  {task.attempt ? <span className="muted">第 {task.attempt} 次尝试</span> : null}
                </div>
                <div className="door-summary">
                  <div><span>任务</span><b>#{task.taskId}</b></div>
                  <div><span>楼栋/门</span><b>{task.buildingNo || dialog.controller.buildingNo} 号楼{task.door ? ` · ${task.door}` : ''}</b></div>
                  <div><span>操作</span><b>{operationLabel(dialog.operation)}{task.minutes ? ` · ${task.minutes} 分钟` : ''}</b></div>
                  <div><span>提交时间</span><b>{fmtDoorTime(task.requestedAt)}</b></div>
                  {task.completedAt ? <div><span>完成时间</span><b>{fmtDoorTime(task.completedAt)}</b></div> : null}
                  {task.controller ? <div><span>控制器</span><b>{task.controller}</b></div> : null}
                  {task.protocol ? <div><span>协议</span><b>{task.protocol}</b></div> : null}
                  {task.acknowledgement ? <div><span>回执</span><b>{task.acknowledgement}</b></div> : null}
                </div>
                {task.error ? <div className="note2" style={{ background: 'var(--dang-w)', color: 'var(--dang)' }}><Icon name="alert" />{task.error}</div> : null}
                {taskError ? <div className="note2"><Icon name="alert" />{taskError}</div> : null}
                {task.status === 'pending' || task.status === 'sent' ? <div className="muted" style={{ marginTop: 8 }}><Icon name="refresh" size={14} /> 正在轮询任务状态…</div> : null}
                {task.receipt ? <pre className="door-receipt">{JSON.stringify(task.receipt, null, 2)}</pre> : null}
                <div className="door-dialog-foot">
                  {(task.status === 'pending' || task.status === 'sent') ? <button className="btn" onClick={repoll}>重新查询</button> : null}
                  <button className="btn p" onClick={closeDialog}>完成</button>
                </div>
              </>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
