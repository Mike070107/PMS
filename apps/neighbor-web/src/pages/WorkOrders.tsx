import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { WorkOrderListItem } from '@pms/shared-types';
import { WorkOrderStatus } from '@pms/shared-types';
import { repairs } from '@pms/api-client';
import { Card, ErrorNote, Loading, Pill, toast } from '@/components/ui';
import NewOrderSheet from '@/components/NewOrderSheet';
import WorkOrderSheet from '@/components/WorkOrderSheet';
import HousePicker, { type PickedHouse } from '@/components/HousePicker';
import { useAddressTree } from '@/lib/address-tree';
import { ago, BOARD_COLUMNS, dueText, isActive, isOverdue, maskPhone } from '@/lib/format';

type Filter = 'active' | 'overdue' | 'all' | WorkOrderStatus;

const FILTERS: Array<[Filter, string]> = [
  ['active', '进行中'],
  ['overdue', '紧急/超时'],
  [WorkOrderStatus.CREATED, '待派单'],
  [WorkOrderStatus.DISPATCHED, '待接单'],
  [WorkOrderStatus.IN_PROGRESS, '维修中'],
  [WorkOrderStatus.WAITING_MATERIAL, '等材料'],
  [WorkOrderStatus.DONE_PENDING_REVIEW, '待验收'],
  [WorkOrderStatus.COMPLETED, '已完成'],
  [WorkOrderStatus.CANCELLED, '已关闭'],
  ['all', '全部'],
];

const COLUMN_OF: Record<string, WorkOrderStatus> = {
  created: WorkOrderStatus.CREATED,
  dispatched: WorkOrderStatus.DISPATCHED,
  in_progress: WorkOrderStatus.IN_PROGRESS,
  waiting_material: WorkOrderStatus.WAITING_MATERIAL,
  done_pending_review: WorkOrderStatus.DONE_PENDING_REVIEW,
};

export default function WorkOrders() {
  const [params, setParams] = useSearchParams();
  const filter = (params.get('filter') || 'active') as Filter;
  const view = params.get('view') === 'list' ? 'list' : 'board';
  const q = params.get('q') || '';
  const [qInput, setQInput] = useState(q);
  const [pickedHouse, setPickedHouse] = useState<PickedHouse | null>(null);
  const { communities } = useAddressTree();
  const sel = params.get('sel') ? Number(params.get('sel')) : null;
  const creating = params.get('new') === '1';

  const [orders, setOrders] = useState<WorkOrderListItem[] | null>(null);
  const [err, setErr] = useState('');

  const load = useCallback(async () => {
    try {
      // all = 进行中 + 已完结要分开拿：done 单独一个 scope
      const [active, done] = await Promise.all([
        repairs.list({ scope: 'all' }),
        repairs.list({ scope: 'done' }).catch(() => [] as WorkOrderListItem[]),
      ]);
      const map = new Map<number, WorkOrderListItem>();
      [...active, ...done].forEach((o) => map.set(o.id, o));
      setOrders([...map.values()]);
      setErr('');
    } catch (e) {
      setErr(e instanceof Error ? e.message : '工单加载失败');
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const setParam = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(params);
    Object.entries(patch).forEach(([k, v]) => {
      if (v === null || v === '') next.delete(k); else next.set(k, v);
    });
    setParams(next, { replace: true });
  };

  const filtered = useMemo(() => {
    const list = orders ?? [];
    const kw = q.trim();
    return list
      .filter((o) => {
        if (kw && !(`${o.summaryAddress || ''}${o.summaryContent || ''}${o.orderNo}${o.assigneeName || ''}${o.contactName || ''}`.includes(kw))) return false;
        if (filter === 'all') return true;
        if (filter === 'active') return isActive(o.status);
        if (filter === 'overdue') return isActive(o.status) && (isOverdue(o) || o.urgent);
        return o.status === filter;
      })
      .sort((a, b) => {
        // 紧急、超时优先，其次新建的在前
        const rank = (o: WorkOrderListItem) => (isOverdue(o) ? 0 : o.urgent ? 1 : 2);
        const d = rank(a) - rank(b);
        return d !== 0 ? d : (b.createdAt || '').localeCompare(a.createdAt || '');
      });
  }, [orders, filter, q]);

  const countOf = (f: Filter) => {
    const list = orders ?? [];
    if (f === 'active') return list.filter((o) => isActive(o.status)).length;
    if (f === 'overdue') return list.filter((o) => isActive(o.status) && (isOverdue(o) || o.urgent)).length;
    if (f === 'all') return list.length;
    return list.filter((o) => o.status === f).length;
  };

  const boardable = view === 'board' && (filter === 'active' || filter === 'overdue' || filter === 'all');

  if (orders === null && !err) return <Loading />;

  return (
    <>
      <div className="ph">
        <div>
          <h1>工单调度</h1>
          <p>看板按处理环节排列；点任意一张卡片在右侧处理，不离开当前页</p>
        </div>
        <div className="act">
          <button className="btn" onClick={() => setParam({ view: view === 'board' ? 'list' : 'board' })}>
            {view === 'board' ? '列表视图' : '看板视图'}
          </button>
          <button className="btn p" onClick={() => setParam({ new: '1' })}>＋ 登记报修</button>
        </div>
      </div>

      {err ? <ErrorNote>{err}</ErrorNote> : null}

      <div className="wo-bar">
        <div className="chips">
          {FILTERS.map(([k, name]) => (
            <button key={k} className={`chip ${filter === k ? 'on' : ''}`} onClick={() => setParam({ filter: k, sel: null })}>
              {name}<span className="c">{orders ? countOf(k) : ''}</span>
            </button>
          ))}
        </div>
        <div style={{ width: 340, marginLeft: 'auto' }}>
          <HousePicker
            communities={communities}
            value={pickedHouse}
            placeholder="输入 228/6/502 或点选小区→楼栋→室号；也可搜电话/维修工"
            onPick={(p) => { setPickedHouse(p); setParam({ q: p.text }); }}
            onTextChange={(text) => setQInput(text)}
            onClear={() => { setPickedHouse(null); setQInput(''); setParam({ q: '' }); }}
          />
        </div>
        <div className="seg">
          <button className={view === 'board' ? 'on' : ''} onClick={() => setParam({ view: 'board' })}>看板</button>
          <button className={view === 'list' ? 'on' : ''} onClick={() => setParam({ view: 'list' })}>列表</button>
        </div>
      </div>

      {!boardable && view === 'board' ? (
        <div className="note" style={{ marginBottom: 10 }}>单一状态下以列表展示；看板用于「进行中 / 紧急超时 / 全部」。</div>
      ) : null}

      {boardable ? (
        <div className="board">
          {BOARD_COLUMNS.map((col) => {
            const items = filtered.filter((o) => o.status === col);
            return (
              <div className="col" key={col}>
                <h4 style={{ display: 'flex', alignItems: 'center', gap: 6, margin: '0 0 8px' }}>
                  <Pill status={col} /><span className="c muted" style={{ fontSize: 13.5 }}>{items.length}</span>
                </h4>
                {items.length ? items.map((o) => (
                  <div key={o.id} className={`wc ${sel === o.id ? 'sel' : ''}`} onClick={() => setParam({ sel: String(o.id) })}>
                    {isOverdue(o) || o.urgent ? (
                      <div className="flag">
                        {o.urgent ? <span className="pill urg plain">紧急</span> : null}
                        {isOverdue(o) ? <span className="pill urg plain">已超时</span> : null}
                      </div>
                    ) : null}
                    <div className="a">{o.summaryAddress || '—'}</div>
                    <div className="q">{o.summaryContent || '—'}</div>
                    <div className="m">
                      {o.photoCount ? <span>▣ {o.photoCount}</span> : null}
                      <span>{ago(o.createdAt)}</span>
                      <span className="r">{o.assigneeName || <span style={{ color: 'var(--warn)' }}>未指派</span>}</span>
                    </div>
                    {o.missingMaterials?.length ? (
                      <div className="m" style={{ marginTop: 6, color: '#7a3e8f' }}>
                        ⧗ {o.missingMaterials.map((m) => `${m.name} ×${m.qty}`).join('、')}
                      </div>
                    ) : null}
                  </div>
                )) : <div className="empty" style={{ padding: 20 }}>暂无</div>}
              </div>
            );
          })}
        </div>
      ) : (
        <Card style={{ overflow: 'hidden' }}>
          <table className="t">
            <thead>
              <tr><th>地址</th><th>问题</th><th>状态</th><th>负责人</th><th>已用时</th><th>要求完成</th><th>单号</th></tr>
            </thead>
            <tbody>
              {filtered.length ? filtered.map((o) => (
                <tr key={o.id} className={`row ${sel === o.id ? 'sel' : ''}`} onClick={() => setParam({ sel: String(o.id) })}>
                  <td><b>{o.summaryAddress || '—'}</b>{o.urgent ? <span className="pill urg" style={{ marginLeft: 6 }}>紧急</span> : null}</td>
                  <td className="sub" style={{ maxWidth: 300 }}>{o.summaryContent || '—'}</td>
                  <td><Pill status={o.status} /></td>
                  <td>{o.assigneeName || <span className="muted">—</span>}</td>
                  <td>{ago(o.createdAt).replace('前', '')}</td>
                  <td className={isOverdue(o) ? 'over' : ''}>{dueText(o.slaDueAt)}</td>
                  <td className="muted">{o.orderNo}</td>
                </tr>
              )) : <tr><td colSpan={7} className="empty">没有符合条件的工单</td></tr>}
            </tbody>
          </table>
        </Card>
      )}

      <WorkOrderSheet
        id={sel}
        onClose={() => setParam({ sel: null })}
        onChanged={() => { void load(); }}
      />

      <NewOrderSheet
        open={creating}
        onClose={() => setParam({ new: null })}
        onCreated={(id) => {
          setParam({ new: null, sel: String(id) });
          void load();
          toast('报修已登记');
        }}
      />

      <div className="note" style={{ marginTop: 14 }}>
        列表里电话按脱敏显示；照片附件上传、养护单签字和打印这一版还没接，需要时走左侧标「旧」的入口。
        <span className="muted"> 共 {orders?.length ?? 0} 单，当前筛选 {filtered.length} 单。</span>
      </div>
    </>
  );
}
