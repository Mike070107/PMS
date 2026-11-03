import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { accessCardIssuance, address, request } from '@pms/api-client';
import type { AccessCardIssueBatch, AccessCardIssueItem } from '@pms/api-client/src/endpoints/access-card-issuance';
import type { AddressCommunity } from '@pms/shared-types';
import { useSession } from '@/lib/auth';
import { dayjs } from '@/lib/format';
import Icon from '@/components/Icon';
import { Loading, toast } from '@/components/ui';
import HousePicker, { type PickedHouse } from '@/components/HousePicker';
import { accessStatusLabel, legacyStatusLabel, rawTitle } from '@/lib/access-card-status';
import ToneIcon from '@/components/ToneIcon';

interface CardRow { id: number; cardNo: string; houseId: number; status?: string }
interface HistRow {
  id: number; sequence: number; roomLabel: string; icCardNo: string | null; wgCardNo: string | null;
  issuedAt: string | null; accessStatus: string; legacySyncStatus: string;
}

const CARD_STATUS: Record<string, { text: string; tone: string }> = {
  pending: { text: '等放卡', tone: 'mute' },
  card_completed: { text: '已写卡', tone: 'ok' },
  card_failed: { text: '写卡失败', tone: 'dang' },
};
const cardStatusLabel = (v?: string | null) => CARD_STATUS[v || ''] ?? { text: v ? '处理中' : '—', tone: 'mute' };

/**
 * 门禁管理：按户发卡 + 查卡 + 发卡历史，全部在本页完成（不再跳旧发卡台）。
 * 发卡走 /access-card-issuance/batches：建批次 → 装读卡器的工作站逐张写卡 →
 * 下发楼栋控制器 / 写旧物业库；页面轮询批次进度，允许单张重试下发。
 */
export default function AccessCards() {
  const session = useSession();
  const [tree, setTree] = useState<AddressCommunity[]>([]);
  const [picked, setPicked] = useState<PickedHouse | null>(null);
  const [cards, setCards] = useState<CardRow[] | null>(null);
  const [history, setHistory] = useState<HistRow[] | null>(null);
  const [err, setErr] = useState('');

  const [issuer, setIssuer] = useState<{ id: string; name: string } | null>(null);
  const [qty, setQty] = useState(1);
  const [batch, setBatch] = useState<AccessCardIssueBatch | null>(null);
  const [busy, setBusy] = useState('');
  const timer = useRef<number | null>(null);

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
    setCards(null); setHistory(null); setErr('');
    request<{ accessCards: CardRow[] }>({ url: '/business/search', query: { q: '', serviceType: 'access_card' } })
      .then((r) => setCards((r?.accessCards ?? []).filter((c) => c.houseId === houseId)))
      .catch(() => setCards([]));
    accessCardIssuance.houseContext(houseId)
      .then((c) => setHistory((c?.history ?? []) as never))
      .catch(() => setHistory([]));
  }, []);

  useEffect(() => {
    if (!picked?.houseId) { setCards(null); setHistory(null); setBatch(null); return; }
    loadHouse(picked.houseId);
  }, [picked?.houseId, loadHouse]);

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
    if (!batch) return;
    setBusy(`retry-${item.id}`);
    try { setBatch(await accessCardIssuance.retryAccessUpload(batch.id, item.id)); toast('已重新下发'); }
    catch (e) { toast(e instanceof Error ? e.message : '重试失败'); }
    finally { setBusy(''); }
  };

  const cur = batch?.items.find((i) => i.cardStatus !== 'card_completed');

  return (
    <>
      <div className="ph" style={{ marginBottom: 14 }}>
        <div>
          <div className="h1row"><ToneIcon kind="cards" /><h1 style={{ fontSize: 22 }}>门禁管理</h1></div>
          <p>按户发卡、查卡与发卡历史；写卡由装了读卡器的工作站自动完成</p>
        </div>
        <div className="act">
          <span className={`tag ${issuer ? 'ok' : 'warn'}`}><Icon name={issuer ? 'check' : 'alert'} />{issuer ? '发卡工作站在线' : '发卡工作站离线'}</span>
        </div>
      </div>

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
                <button className="btn p" style={{ marginLeft: 'auto' }} disabled={busy === 'create'} onClick={() => void startBatch()}>
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
                              {canRetry ? <button className="btn g sm" disabled={busy === `retry-${it.id}`} onClick={() => void retryAccess(it)}><Icon name="refresh" size={15} />重试下发</button> : null}
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

          <div className="card" style={{ padding: '14px 16px' }}>
            <div className="panelHd" style={{ marginBottom: 10 }}>
              <b>发卡历史</b>
              {history?.length ? <span className="tag mute" style={{ marginLeft: 8 }}>{history.length} 张</span> : null}
            </div>
            {history === null ? <Loading text="读发卡记录…" /> : history.length === 0 ? (
              <div className="muted">这一户还没有发卡记录</div>
            ) : (
              <div className="t-scroll">
                <table className="t" style={{ minWidth: 720 }}>
                  <thead><tr><th style={{ width: 70 }}>序号</th><th>卡号</th><th>发卡时间</th><th>门禁授权</th><th>旧库同步</th></tr></thead>
                  <tbody>
                    {history.map((h) => {
                      const as = accessStatusLabel(h.accessStatus);
                      const ls = legacyStatusLabel(h.legacySyncStatus);
                      return (
                        <tr key={h.id}>
                          <td className="nw muted">{h.sequence}</td>
                          <td className="nw"><b>{h.icCardNo || h.wgCardNo || '—'}</b>{h.icCardNo && h.wgCardNo ? <span className="muted"> · WG {h.wgCardNo}</span> : null}</td>
                          <td className="nw">{h.issuedAt ? dayjs(h.issuedAt).format('YYYY-MM-DD HH:mm') : '—'}</td>
                          <td className="nw"><span className={`tag ${as.tone}`} title={rawTitle(h.accessStatus)}>{as.text}</span></td>
                          <td className="nw"><span className={`tag ${ls.tone}`} title={rawTitle(h.legacySyncStatus)}>{ls.text}</span></td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}
    </>
  );
}
