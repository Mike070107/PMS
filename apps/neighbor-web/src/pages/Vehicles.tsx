import { useCallback, useEffect, useRef, useState } from 'react';
import { accessCardIssuance, request } from '@pms/api-client';
import type { ParkingQuery } from '@pms/api-client/src/endpoints/access-card-issuance';
import { legacyUrl } from '@/lib/legacy';
import HousePicker, { type PickedHouse } from '@/components/HousePicker';
import { useAddressTree } from '@/lib/address-tree';
import { Btn, Card, ErrorNote, Loading, toast } from '@/components/ui';

interface Card { id: number; cardNo: string; houseId: number; status: string }

const FIELD_LABEL: Array<[RegExp, string]> = [
  [/plate|car.?no/i, '车牌'],
  [/owner|name/i, '车主'],
  [/phone|tel|mobile/i, '电话'],
  [/garage|park|area|space/i, '车库 / 车位'],
  [/end|valid|expire|due/i, '有效期'],
  [/begin|start/i, '开始'],
  [/card/i, '卡号'],
  [/addr|room|house/i, '地址'],
  [/type/i, '类型'],
];

function labelOf(key: string) {
  return FIELD_LABEL.find(([re]) => re.test(key))?.[1] || key;
}

/**
 * 住户车辆与门禁：一个房号 / 车牌的完整档案。
 *
 * 停车库查询是「提交任务 → 轮询结果」的异步接口（本地网关去读现场库），
 * 所以这里按那个节奏做：提交后每 1.5 秒问一次，最多 20 次。
 * 续期、改车牌、发卡等写操作仍在现有停车管理 / 发卡页——它们各自有确认流程和回执。
 */
export default function Vehicles() {
  const [term, setTerm] = useState('');
  const [pickedHouse, setPickedHouse] = useState<PickedHouse | null>(null);
  const { communities } = useAddressTree();
  const [query, setQuery] = useState<ParkingQuery | null>(null);
  const [polling, setPolling] = useState(false);
  const [err, setErr] = useState('');
  const [cards, setCards] = useState<Card[] | null>(null);
  const [cardErr, setCardErr] = useState('');
  const timer = useRef<number | null>(null);

  useEffect(() => () => { if (timer.current) window.clearTimeout(timer.current); }, []);

  const loadCards = useCallback(async (kw: string) => {
    setCards(null);
    setCardErr('');
    try {
      const r = await request<{ accessCards: Card[] }>({
        url: '/business/search',
        query: { q: kw, serviceType: 'access_card' },
      });
      setCards(r.accessCards ?? []);
    } catch (e) {
      setCardErr(e instanceof Error ? e.message : '门禁卡读取失败');
      setCards([]);
    }
  }, []);

  const poll = useCallback(async (id: number, left: number) => {
    if (left <= 0) { setPolling(false); setErr('停车库查询超时，现场网关可能不在线'); return; }
    try {
      const q = await accessCardIssuance.parkingQuery(id);
      setQuery(q);
      if (q.status === 'completed' || q.status === 'failed') {
        setPolling(false);
        if (q.status === 'failed') setErr(q.error || '查询失败');
        return;
      }
      timer.current = window.setTimeout(() => void poll(id, left - 1), 1500);
    } catch (e) {
      setPolling(false);
      setErr(e instanceof Error ? e.message : '查询失败');
    }
  }, []);

  const search = async (kwOverride?: string) => {
    const kw = (kwOverride ?? term).trim();
    if (!kw) return;
    setErr('');
    setQuery(null);
    setPolling(true);
    void loadCards(kw);
    try {
      const created = await accessCardIssuance.createParkingQuery(kw);
      setQuery(created);
      if (created.status === 'completed' || created.status === 'failed') {
        setPolling(false);
        if (created.status === 'failed') setErr(created.error || '查询失败');
        return;
      }
      timer.current = window.setTimeout(() => void poll(created.id, 20), 1200);
    } catch (e) {
      setPolling(false);
      setErr(e instanceof Error ? e.message : '提交查询失败');
    }
  };

  const rows = query?.rows ?? [];

  return (
    <>
      <div className="ph">
        <div>
          <h1>住户车辆与门禁</h1>
          <p>停车管理与门禁发卡合并：同一个房号下看车辆授权和门禁卡</p>
        </div>
        <div className="act">
          <button className="btn" onClick={() => { window.location.href = legacyUrl('/parking'); }}>登记新车 / 续期</button>
          <button className="btn p" onClick={() => { window.location.href = legacyUrl('/access-cards'); }}>＋ 发门禁卡</button>
        </div>
      </div>

      {err ? <ErrorNote>{err}</ErrorNote> : null}

      <div className="hsearch" style={{ display: 'flex', gap: 10, marginBottom: 16 }}>
        <HousePicker
          communities={communities}
          value={pickedHouse}
          placeholder="输入 228/6/502 或点选 小区→楼栋→室号；也可搜姓名、电话、车牌"
          onPick={(p) => { setPickedHouse(p); setTerm(p.text); void search(p.text); }}
          onTextChange={(text) => setTerm(text)}
          onClear={() => { setPickedHouse(null); setTerm(''); }}
        />
        <Btn kind="p" size="lg" disabled={polling} onClick={() => void search()}>{polling ? '现场库查询中…' : '查询'}</Btn>
      </div>

      {!query && !polling ? (
        <Card style={{ padding: '52px 20px' }}>
          <div className="empty">输入房号或车牌，从现场停车库读出这个房号的车辆档案</div>
        </Card>
      ) : null}

      {polling && !rows.length ? (
        <Card style={{ padding: 40 }}><Loading text="已提交查询，等待停车网关回读现场库…" /></Card>
      ) : null}

      {rows.length ? (
        <Card style={{ overflow: 'hidden', marginBottom: 16 }}>
          <div style={{ padding: '12px 14px', borderBottom: '1px solid var(--line)', display: 'flex', alignItems: 'center', gap: 10 }}>
            <b>停车库记录</b>
            <span className="muted">{rows.length} 条 · 查询「{query?.term}」</span>
            <span className="muted" style={{ marginLeft: 'auto', fontSize: 14 }}>
              完成于 {query?.completedAt ? new Date(query.completedAt).toLocaleTimeString('zh-CN') : '—'}
            </span>
          </div>
          <table className="t">
            <thead>
              <tr>
                <th>库</th><th>车牌 / 车主</th><th>电话</th><th>车库 / 车位</th><th>有效期</th><th>PMS 档案</th><th />
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => {
                const f = r.fields || {};
                const pick = (re: RegExp) => {
                  const k = Object.keys(f).find((key) => re.test(key) && f[key] !== null && f[key] !== '');
                  return k ? String(f[k]) : '';
                };
                const plate = pick(/plate|car.?no/i);
                const owner = pick(/owner|name/i);
                const phone = pick(/phone|tel|mobile/i);
                const garage = pick(/garage|park|area|space/i);
                const valid = pick(/end|valid|expire|due/i);
                const m = r.pmsMatch;
                return (
                  <tr key={`${r.database}-${i}`}>
                    <td className="sub" style={{ fontSize: 14 }}>{r.database}</td>
                    <td><b>{plate || '—'}</b>{owner ? <span className="muted"> · {owner}</span> : null}</td>
                    <td>{phone || <span className="muted">缺电话</span>}</td>
                    <td className="sub">{garage || '—'}</td>
                    <td className="sub">{valid || '—'}</td>
                    <td>
                      {m?.house ? (
                        <span className="pill s-done">{m.house.communityName || ''}{m.house.buildingNo}/{m.house.roomNo}</span>
                      ) : <span className="pill s-pend">未匹配房号</span>}
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      <Btn size="sm" onClick={() => { window.location.href = legacyUrl(`/parking?plate=${encodeURIComponent(plate)}`); }}>续期 / 调整</Btn>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Card>
      ) : null}

      {query && !polling && !rows.length ? (
        <Card style={{ padding: 36 }}><div className="empty">停车库里没有查到「{query.term}」的记录</div></Card>
      ) : null}

      {cards !== null ? (
        <Card style={{ overflow: 'hidden' }}>
          <div style={{ padding: '12px 14px', borderBottom: '1px solid var(--line)', display: 'flex', alignItems: 'center', gap: 10 }}>
            <b>门禁卡</b>
            <span className="muted">{cards.length} 张</span>
            {cardErr ? <span className="muted" style={{ color: 'var(--dang)' }}>{cardErr}</span> : null}
            <button className="btn sm" style={{ marginLeft: 'auto' }} onClick={() => { window.location.href = legacyUrl('/access-cards'); }}>去发卡台</button>
          </div>
          {cards.length ? (
            <table className="t">
              <thead><tr><th>卡号</th><th>状态</th></tr></thead>
              <tbody>
                {cards.map((c) => (
                  <tr key={c.id}>
                    <td><b>{c.cardNo}</b></td>
                    <td className="sub">{c.status}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : <div className="empty" style={{ padding: 22 }}>这个搜索下没有门禁卡记录</div>}
        </Card>
      ) : null}

      <div className="note" style={{ marginTop: 16 }}>
        车辆续期、改车牌、同步一期二期资料、发卡写卡这些写操作仍在现有「停车管理」和「门禁发卡」页：
        它们各自要做设备下发并等控制器回执，这一版先把「查得清」做出来，不在这里假装能写。
        <button className="btn g sm" style={{ marginLeft: 8 }} onClick={() => { void search(); toast('已重新查询'); }}>重新查询</button>
      </div>
    </>
  );
}
