import { useCallback, useEffect, useMemo, useState } from 'react';
import { maintenance } from '@pms/api-client';
import type { MaintenanceListItem } from '@pms/api-client/src/endpoints/maintenance';
import { legacyUrl } from '@/lib/legacy';
import HousePicker, { type PickedHouse } from '@/components/HousePicker';
import { useAddressTree } from '@/lib/address-tree';
import { Card, ErrorNote, Loading, toast } from '@/components/ui';
import { dayjs, money } from '@/lib/format';

type MStatus = MaintenanceListItem['status'];

const STATUS: Record<MStatus, { text: string; cls: string }> = {
  filling: { text: '填单中', cls: 's-wait' },
  waiting_filler: { text: '待填单人签', cls: 's-pend' },
  waiting_repairer: { text: '待修理人签', cls: 's-pend' },
  waiting_inspector: { text: '待查验员签', cls: 's-acc' },
  pending_print: { text: '待打印', cls: 's-work' },
  completed: { text: '已完成', cls: 's-done' },
  void: { text: '已作废', cls: 's-off' },
};

/** 签字进度只取「走到第几步」，细节在旧页的整单预览里看 */
const STEP_OF: Record<MStatus, number> = {
  filling: 1,
  waiting_filler: 1,
  waiting_repairer: 2,
  waiting_inspector: 3,
  pending_print: 4,
  completed: 4,
  void: 0,
};

const STEPS = ['填单', '修理人签', '查验员签', '打印归档'];

const FILTERS: Array<{ key: string; label: string; match: (s: MStatus) => boolean }> = [
  { key: 'active', label: '进行中', match: (s) => s !== 'completed' && s !== 'void' },
  { key: 'filling', label: '填单中', match: (s) => s === 'filling' || s === 'waiting_filler' },
  { key: 'signing', label: '签字中', match: (s) => s === 'waiting_repairer' || s === 'waiting_inspector' },
  { key: 'print', label: '待打印', match: (s) => s === 'pending_print' },
  { key: 'completed', label: '已完成', match: (s) => s === 'completed' },
  { key: 'all', label: '全部', match: (s) => s !== 'void' },
];

/**
 * 养护单：房屋修理养护任务单。
 *
 * 新版这里做「看清楚走到哪一步」；开单、定额、四个签字位、套打仍在现有养护单页，
 * 那些依赖打印定位与手写体，搬过来之前先不动。
 */
export default function Maintenance() {
  const [rows, setRows] = useState<MaintenanceListItem[] | null>(null);
  const [filter, setFilter] = useState('active');
  const [q, setQ] = useState('');
  const [pickedHouse, setPickedHouse] = useState<PickedHouse | null>(null);
  const { communities } = useAddressTree();
  const [err, setErr] = useState('');

  const load = useCallback(async () => {
    try {
      setRows(await maintenance.list({ status: 'all' }));
      setErr('');
    } catch (e) {
      setErr(e instanceof Error ? e.message : '养护单加载失败');
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const visible = useMemo(() => {
    const f = FILTERS.find((item) => item.key === filter) || FILTERS[0];
    const kw = q.trim();
    return (rows ?? [])
      .filter((row) => f.match(row.status))
      .filter((row) => (kw
        ? `${row.orderNo}${row.paperNo || ''}${row.workOrderNo || ''}${row.addressText}${row.repairItem || ''}${row.repairerName || ''}`.includes(kw)
        : true))
      .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  }, [rows, filter, q]);

  const countOf = (key: string) => {
    const f = FILTERS.find((item) => item.key === key);
    return f ? (rows ?? []).filter((row) => f.match(row.status)).length : 0;
  };

  if (rows === null && !err) return <Loading />;

  return (
    <>
      <div className="ph">
        <div>
          <h1>养护单</h1>
          <p>完工后自动生成；这里看签字走到哪一步，开单与套打在现有养护单页</p>
        </div>
        <div className="act">
          <button className="btn" onClick={() => { void load(); toast('已刷新'); }}>刷新</button>
          <button className="btn p" onClick={() => { window.location.href = legacyUrl('/maintenance-orders'); }}>开单 / 打印</button>
        </div>
      </div>

      {err ? <ErrorNote>{err}</ErrorNote> : null}

      <div className="wo-bar">
        <div className="chips">
          {FILTERS.map((item) => (
            <button key={item.key} className={`chip ${filter === item.key ? 'on' : ''}`} onClick={() => setFilter(item.key)}>
              {item.label}<span className="c">{countOf(item.key)}</span>
            </button>
          ))}
        </div>
        <div style={{ width: 340, marginLeft: 'auto' }}>
          <HousePicker
            communities={communities}
            value={pickedHouse}
            placeholder="输入 228/6/502 或点选小区→楼栋→室号；也可搜单号/修理人"
            onPick={(p) => { setPickedHouse(p); setQ(p.text); }}
            onTextChange={(text) => setQ(text)}
            onClear={() => { setPickedHouse(null); setQ(''); }}
          />
        </div>
      </div>

      <Card style={{ overflow: 'hidden' }}>
        <table className="t">
          <thead>
            <tr>
              <th>养护单号</th><th>地址</th><th>报修项目</th>
              <th>报修人 / 修理人</th>
              <th style={{ textAlign: 'right' }}>工料费</th>
              <th style={{ width: 260 }}>签字进度</th>
              <th>状态</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {visible.length ? visible.map((row) => {
              const step = STEP_OF[row.status] ?? 0;
              return (
                <tr key={row.id} className="row" onClick={() => { window.location.href = legacyUrl('/maintenance-orders'); }}>
                  <td>
                    <b>{row.orderNo}</b>
                    {row.workOrderNo ? <div className="muted" style={{ fontSize: 13.5 }}>工单 {row.workOrderNo}</div> : null}
                  </td>
                  <td className="sub">{row.addressText}</td>
                  <td className="sub" style={{ maxWidth: 240 }}>{row.repairItem || '—'}</td>
                  <td className="sub">
                    {row.reporterName || '—'}
                    <div className="muted" style={{ fontSize: 13.5 }}>{row.repairerName || '未指派修理人'}</div>
                  </td>
                  <td style={{ textAlign: 'right', fontWeight: 600 }}>{money((row.totalCents || 0) / 100)}</td>
                  <td>
                    <div style={{ display: 'flex', gap: 4 }}>
                      {STEPS.map((label, index) => {
                        const done = index < step;
                        const current = index === step - 1 && row.status !== 'completed';
                        return (
                          <span key={label} title={label}
                            style={{
                              flex: 1, textAlign: 'center', fontSize: 12, paddingTop: 6,
                              borderTop: `4px solid ${done ? 'var(--acc)' : 'var(--line)'}`,
                              color: current ? 'var(--ink)' : 'var(--ink3)',
                              fontWeight: current ? 650 : 400,
                              whiteSpace: 'nowrap',
                            }}>
                            {label}
                          </span>
                        );
                      })}
                    </div>
                  </td>
                  <td><span className={`pill ${STATUS[row.status]?.cls || 's-off'}`}>{STATUS[row.status]?.text || row.status}</span></td>
                  <td style={{ textAlign: 'right' }} className="muted">{row.createdAt ? dayjs(row.createdAt).format('MM-DD') : ''}</td>
                </tr>
              );
            }) : <tr><td colSpan={8} className="empty">没有符合条件的养护单</td></tr>}
          </tbody>
        </table>
      </Card>

      <div className="note" style={{ marginTop: 14 }}>
        养护单挂在工单下面：工单完工后自动生成，签字位分别是填单人、修理人、查验员、打印归档。
        四段进度条只表示走到第几步，具体签字时间与签名图在现有养护单页的整单预览里。
        手机签字链接、定额工料费与套打也在那边，这一版没有搬过来。
      </div>
    </>
  );
}
