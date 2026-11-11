import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { request } from '@pms/api-client';
import Icon from '@/components/Icon';
import { ErrorNote, Loading } from '@/components/ui';
import { dayjs } from '@/lib/format';
import { can } from '@/lib/perm';
import { useSession } from '@/lib/auth';
import NewPlateCard, { INTAKE_STATUS, TXN_STATUS, type Intake } from '@/components/cashier/NewPlateCard';
import ToneIcon from '@/components/ToneIcon';

const INTAKE_FILTERS: Array<[string, string]> = [['submitted', '待审核资料'], ['waiting,reupload', '等业主填写'], ['approved', '已通过'], ['void', '已作废'], ['', '全部']];

/**
 * 车牌登记审核：新办车牌 / 亲情车的扫码登记、资料、审核进度、有效期、授权车库，失败可重试。
 * 每条都有操作日志（谁、何时、做了什么），供审计。
 */
export default function Plates() {
  useSession();
  const canIntake = ['business', 'family-cars', 'app:approve-business-manager', 'app:approve-manager'].some(key => can(key, 'view'));
  const [params] = useSearchParams();
  const intakeId = params.get('intakeId') ?? params.get('id');
  const [q, setQ] = useState('');
  const [kw, setKw] = useState('');
  if (!canIntake) return null;
  return (
    <>
      <div className="ph" style={{ marginBottom: 14, flexWrap: 'wrap', gap: 12 }}>
        <div style={{ flex: '1 1 300px', minWidth: 0 }}><div className="h1row"><ToneIcon kind="plates" /><h1 style={{ fontSize: 22 }}>车牌登记审核</h1></div><p>新办车牌、亲情车：业主扫码登记 → 资料审核 → 自动办理；有效期 · 授权车库 · 失败重试</p></div>
        <form style={{ display: 'flex', flexWrap: 'nowrap', flex: '0 1 360px', gap: 8, maxWidth: '100%' }} onSubmit={(e) => { e.preventDefault(); setKw(q.trim()); }}>
          <input className="in" style={{ width: 260, minWidth: 0 }} value={q} onChange={(e) => setQ(e.target.value)} placeholder="车牌 / 房号 / 姓名 / 电话" />
          <button className="btn p"><Icon name="search" size={16} />查询</button>
        </form>
      </div>
      <IntakeList kw={kw} intakeId={intakeId} />
    </>
  );
}

function IntakeList({ kw, intakeId }: { kw: string; intakeId: string | null }) {
  const validId = intakeId !== null && /^[1-9]\d*$/.test(intakeId) && Number.isSafeInteger(Number(intakeId));
  const [status, setStatus] = useState(intakeId === null ? 'submitted' : '');
  const [rows, setRows] = useState<Intake[] | null>(null);
  const [listError, setListError] = useState('');
  const [open, setOpen] = useState<Intake | null>(null);
  const [detailError, setDetailError] = useState('');
  const expandRevision = useRef(0);
  const [focused, setFocused] = useState<{ query: string; row?: Intake; error?: string } | null>(null);
  // Exact GET is server tenant/scope checked. Never resolve a deep link by a filtered list.
  useEffect(() => {
    setFocused(null);
    if (intakeId === null || !validId) return;
    let alive = true;
    request<Intake>({ url: `/vehicle-intakes/${intakeId}` })
      .then(row => { if (alive) setFocused({ query: intakeId, row }); })
      .catch(e => { if (alive) setFocused({ query: intakeId, error: e instanceof Error ? e.message : '读取本次登记失败' }); });
    return () => { alive = false; };
  }, [intakeId, validId]);
  useEffect(() => {
    let alive = true;
    let revision = 0;
    const load = async () => {
      const current = ++revision;
      try {
        const list = await request<Intake[]>({ url: '/vehicle-intakes', query: { ...(status ? { status } : {}), ...(kw ? { q: kw } : {}) } });
        if (alive && current === revision) { setRows(list); setListError(''); }
      } catch (e) {
        if (alive && current === revision) setListError(e instanceof Error ? e.message : '登记列表读取失败');
      }
    };
    setRows(null); setListError(''); void load();
    const timer = window.setInterval(() => void load(), 10000);
    return () => { alive = false; window.clearInterval(timer); };
  }, [status, kw]);
  useEffect(() => {
    expandRevision.current += 1; setOpen(null); setDetailError('');
    return () => { expandRevision.current += 1; };
  }, [intakeId]);
  const expand = async (r: Intake) => {
    const revision = ++expandRevision.current;
    setDetailError('');
    if (open?.id === r.id) { setOpen(null); return; }
    try {
      const row = await request<Intake>({ url: `/vehicle-intakes/${r.id}` });
      if (revision === expandRevision.current) setOpen(row);
    } catch (e) { if (revision === expandRevision.current) setDetailError(e instanceof Error ? e.message : '读取失败'); }
  };
  const update = useCallback((x: Intake) => {
    setOpen(prev => prev?.id === x.id ? x : prev);
    setFocused(prev => prev?.row?.id === x.id ? { ...prev, row: x } : prev);
    setRows(prev => prev ? prev.map(y => y.id === x.id ? x : y) : prev);
  }, []);
  // Retain the existing review-only garage default; never use this display label for navigation or house lookup.
  const laneOf = (label: string) => (label.match(/(\d+)弄/) || [])[1] || '';
  const card = (row: Intake) => <NewPlateCard key={row.id} manage intake={row} rules={[]} targets={[]} house={{ id: row.houseId, communityId: null, lane: laneOf(row.houseLabel), buildingNo: '', roomNo: '' }}
    onChange={update} onDrop={() => { setOpen(prev => prev?.id === row.id ? null : prev); }} onCart={() => undefined} renewal={() => null} />;

  return (
    <>
      {intakeId !== null ? <section role="region" aria-label={`本次登记 #${intakeId}`} style={{ marginBottom: 16 }}>
        <h2 style={{ fontSize: 18, marginBottom: 10 }}>本次登记 #{intakeId}</h2>
        {!validId ? <ErrorNote>登记编号必须是正整数</ErrorNote>
          : focused?.query !== intakeId ? <Loading text="正在读取本次登记…" />
            : focused.error ? <ErrorNote>{focused.error}</ErrorNote>
              : focused.row ? card(focused.row) : null}
      </section> : null}
      <div className="quickMonths" style={{ marginTop: 0, marginBottom: 10 }}>
        {INTAKE_FILTERS.map(([k, l]) => <button key={k} className={`chip ${status === k ? 'on' : ''}`} onClick={() => setStatus(k)}>{l}</button>)}
      </div>
      {detailError ? <ErrorNote>{detailError}</ErrorNote> : null}
      {listError ? <ErrorNote>登记列表：{listError}</ErrorNote> : null}
      {rows === null ? (listError ? null : <Loading />) : (
        <div className="card" role="region" aria-label="登记列表，可左右滚动查看" tabIndex={0} style={{ overflowX: 'auto' }}>
          <table className="tbl" style={{ minWidth: 940 }}>
            <thead><tr><th>登记时间</th><th>房号</th><th>类型</th><th>车牌</th><th>车主 · 电话</th><th>资料</th><th>状态</th><th>收款 / 办理</th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <Fragment key={r.id}>
                  <tr key={r.id} className={open?.id === r.id ? 'sel' : ''} onClick={() => void expand(r)}>
                    <td>{dayjs(r.createdAt).format('MM-DD HH:mm')}</td>
                    <td>{r.houseLabel}</td>
                    <td>{r.kind === 'family' ? '亲情车' : <>付费{r.vehicleClass ? <span className="tag acc" style={{ marginLeft: 4 }}>{r.vehicleClass}</span> : null}</>}</td>
                    <td>{r.plate ? <b className="plate">{r.plate}</b> : <span className="muted">未填</span>}</td>
                    <td>{r.contactName ? `${r.contactName} · ${r.contactPhone}` : <span className="muted">—</span>}</td>
                    <td>{r.files.length ? `${r.files.length} 份` : <span className="muted">—</span>}</td>
                    <td><span className={`tag ${INTAKE_STATUS[r.status][1]}`}>{INTAKE_STATUS[r.status][0]}</span></td>
                    <td>{r.kind === 'family' ? (r.familyCarId ? '已转亲情车登记' : '免费') : r.transaction ? TXN_STATUS[r.transaction.externalSyncStatus] || r.transaction.externalSyncStatus : <span className="muted">未收款</span>}</td>
                  </tr>
                  {open?.id === r.id ? (
                    <tr key={`d${r.id}`} style={{ cursor: 'default' }}><td colSpan={8} style={{ background: 'var(--sunken)', padding: 12 }}>
                      {card(open)}
                    </td></tr>
                  ) : null}
                </Fragment>
              ))}
              {!rows.length ? <tr style={{ cursor: 'default' }}><td colSpan={8} className="muted" style={{ textAlign: 'center', padding: 26 }}>没有符合条件的登记</td></tr> : null}
            </tbody>
          </table>
        </div>
      )}
      <div className="note2" style={{ marginTop: 12 }}><Icon name="alert" />新办登记在收银台「停车缴费」里生成二维码；业主扫码填写后这里实时出现。付费新车的款可以先收，资料审核通过后自动办理。</div>
    </>
  );
}
