import { Fragment, useCallback, useEffect, useState } from 'react';
import { request } from '@pms/api-client';
import Icon from '@/components/Icon';
import { Loading, toast } from '@/components/ui';
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
  const [q, setQ] = useState('');
  const [kw, setKw] = useState('');
  if (!canIntake) return null;
  return (
    <>
      <div className="ph" style={{ marginBottom: 14 }}>
        <div><div className="h1row"><ToneIcon kind="plates" /><h1 style={{ fontSize: 22 }}>车牌登记审核</h1></div><p>新办车牌、亲情车：业主扫码登记 → 资料审核 → 自动办理；有效期 · 授权车库 · 失败重试</p></div>
        <form style={{ display: 'flex', gap: 8 }} onSubmit={(e) => { e.preventDefault(); setKw(q.trim()); }}>
          <input className="in" style={{ width: 260 }} value={q} onChange={(e) => setQ(e.target.value)} placeholder="车牌 / 房号 / 姓名 / 电话" />
          <button className="btn p"><Icon name="search" size={16} />查询</button>
        </form>
      </div>
      <IntakeList kw={kw} />
    </>
  );
}

function IntakeList({ kw }: { kw: string }) {
  const [status, setStatus] = useState('submitted');
  const [rows, setRows] = useState<Intake[] | null>(null);
  const [open, setOpen] = useState<Intake | null>(null);
  const load = useCallback(() => {
    request<Intake[]>({ url: '/vehicle-intakes', query: { ...(status ? { status } : {}), ...(kw ? { q: kw } : {}) } }).then(setRows).catch(() => setRows([]));
  }, [status, kw]);
  useEffect(() => { setRows(null); load(); const t = window.setInterval(load, 10000); return () => window.clearInterval(t); }, [load]);
  const expand = async (r: Intake) => {
    if (open?.id === r.id) { setOpen(null); return; }
    try { setOpen(await request<Intake>({ url: `/vehicle-intakes/${r.id}` })); } catch (e) { toast(e instanceof Error ? e.message : '读取失败'); }
  };
  const laneOf = (label: string) => (label.match(/(\d+)弄/) || [])[1] || '';

  return (
    <>
      <div className="quickMonths" style={{ marginTop: 0, marginBottom: 10 }}>
        {INTAKE_FILTERS.map(([k, l]) => <button key={k} className={`chip ${status === k ? 'on' : ''}`} onClick={() => setStatus(k)}>{l}</button>)}
      </div>
      {rows === null ? <Loading /> : (
        <div className="card" style={{ overflow: 'hidden' }}>
          <table className="tbl">
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
                      <NewPlateCard manage intake={open} rules={[]} targets={[]} house={{ id: open.houseId, communityId: null, lane: laneOf(open.houseLabel), buildingNo: '', roomNo: '' }}
                        onChange={(x) => { setOpen(x); setRows((l) => (l ? l.map((y) => (y.id === x.id ? x : y)) : l)); }}
                        onDrop={() => setOpen(null)} onCart={() => undefined} renewal={() => null} />
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
