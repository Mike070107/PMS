import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { WorkOrderListItem } from '@pms/shared-types';
import { WorkOrderStatus } from '@pms/shared-types';
import { repairs } from '@pms/api-client';
import { Card, ErrorNote, Loading, Pill, toast } from '@/components/ui';
import NewOrderSheet from '@/components/NewOrderSheet';
import WorkOrderSheet from '@/components/WorkOrderSheet';
import AddressSearch from '@/components/AddressSearch';
import { useAddressTree } from '@/lib/address-tree';
import { ago, BOARD_COLUMNS, dueText, isActive, isOverdue, maskPhone, stageOf } from '@/lib/format';
import ToneIcon from '@/components/ToneIcon';

type Filter = 'active' | 'overdue' | 'all' | 'pending_accept' | WorkOrderStatus;

const FILTERS: Array<[Filter, string]> = [
  ['active', '进行中'],
  ['overdue', '紧急/超时'],
  [WorkOrderStatus.CREATED, '待派单'],
  ['pending_accept', '待接单'],
  [WorkOrderStatus.IN_PROGRESS, '维修中'],
  [WorkOrderStatus.WAITING_MATERIAL, '等材料'],
  [WorkOrderStatus.DONE_PENDING_REVIEW, '待验收'],
  [WorkOrderStatus.COMPLETED, '已完成'],
  [WorkOrderStatus.CANCELLED, '已关闭'],
  [WorkOrderStatus.VOIDED, '已作废'],
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
  const { communities } = useAddressTree();
  const sel = params.get('sel') ? Number(params.get('sel')) : null;
  const creating = params.get('new') === '1';

  const [orders, setOrders] = useState<WorkOrderListItem[] | null>(null);
  const [err, setErr] = useState('');

  const load = useCallback(async () => {
    try {
      // all = 进行中 + 已完结要分开拿：done 单独一个 scope
      // 搜索交给服务端：地址模糊输入精准命中（198/20 = 一期20 = 枫桦景苑一期20号楼），还能搜到列表 100 条以外的老单
      const kw = q.trim() || undefined;
      // 作废单服务端默认不返回，单独拉一次给「已作废」用（不算进「全部」）
      const [active, done, voided] = await Promise.all([
        repairs.list({ scope: 'all', q: kw, sort: 'repair_time_desc' }),
        repairs.list({ scope: 'done', q: kw, sort: 'repair_time_desc' }).catch(() => [] as WorkOrderListItem[]),
        repairs.list({ scope: 'all', status: WorkOrderStatus.VOIDED, q: kw, sort: 'repair_time_desc' }).catch(() => [] as WorkOrderListItem[]),
      ]);
      const map = new Map<number, WorkOrderListItem>();
      [...active, ...done, ...voided].forEach((o) => map.set(o.id, o));
      setOrders([...map.values()]);
      setErr('');
    } catch (e) {
      setErr(e instanceof Error ? e.message : '工单加载失败');
    }
  }, [q]);

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
    return list
      .filter((o) => {
        if (filter === 'all') return o.status !== WorkOrderStatus.VOIDED;
        if (filter === 'active') return isActive(o.status);
        if (filter === 'overdue') return isActive(o.status) && (isOverdue(o) || o.urgent);
        return stageOf(o) === filter;
      })
      .sort((a, b) => {
        // 维修时间取完工时间，未完工取接单开工时间；派单/建单不代表已经维修。
        // 尚未开工的排在有维修记录的后面，同维修时间再按报修时间倒序。
        const time = (v: string | null | undefined) => v ? Date.parse(v) || 0 : 0;
        const repairedAt = (o: WorkOrderListItem) => time(o.completedAt) || time(o.acceptedAt);
        return repairedAt(b) - repairedAt(a) || time(b.createdAt) - time(a.createdAt) || a.id - b.id;
      });
  }, [orders, filter]);

  const countOf = (f: Filter) => {
    const list = orders ?? [];
    if (f === 'active') return list.filter((o) => isActive(o.status)).length;
    if (f === 'overdue') return list.filter((o) => isActive(o.status) && (isOverdue(o) || o.urgent)).length;
    if (f === 'all') return list.filter((o) => o.status !== WorkOrderStatus.VOIDED).length;
    return list.filter((o) => stageOf(o) === f).length;
  };

  const boardable = view === 'board' && (filter === 'active' || filter === 'overdue' || filter === 'all');

  if (orders === null && !err) return <Loading />;

  return (
    <>
      <div className="ph wo-page-head">
        <div>
          <div className="h1row"><ToneIcon kind="workorders" /><h1>工单调度</h1></div>
          <p>看板按处理环节排列；点任意一张卡片在右侧处理，不离开当前页</p>
        </div>
        <div className="act">
          <AddressSearch communities={communities} value={q} width={300} onChange={(text) => setParam({ q: text, sel: null })}
            placeholder="198/20、电话、单号、维修工" />
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
      </div>

      {!boardable && view === 'board' ? (
        <div className="note" style={{ marginBottom: 10 }}>单一状态下以列表展示；看板用于「进行中 / 紧急超时 / 全部」。</div>
      ) : null}

      {boardable ? (
        <div className="board">
          {BOARD_COLUMNS.map((col) => {
            const items = filtered.filter((o) => stageOf(o) === col);
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
                      <span className="r">{o.assigneeName ? (o.status === WorkOrderStatus.DISPATCHED ? `派给 ${o.assigneeName}` : o.assigneeName) : (stageOf(o) === 'pending_accept'
                        ? <span style={{ color: 'var(--info, #2f6fb0)' }} title="按工种自动派单，等其中一人接单">已自动派给 {o.candidateIds?.length} 位维修工</span>
                        : <span style={{ color: 'var(--warn)' }}>未指派</span>)}</span>
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
        <Card style={{ overflowX: 'auto' }}>
          <table className="t wo-list-table">
            <colgroup>
              <col style={{ width: '22%' }} /><col style={{ width: '26%' }} />
              <col style={{ width: 112 }} /><col style={{ width: '12%' }} />
              <col style={{ width: '8%' }} /><col style={{ width: '10%' }} /><col style={{ width: '13%' }} />
            </colgroup>
            <thead>
              <tr><th>地址</th><th>问题</th><th>状态</th><th>负责人</th><th>已用时</th><th>要求完成</th><th>单号</th></tr>
            </thead>
            <tbody>
              {filtered.length ? filtered.map((o) => (
                <tr key={o.id} className={`row ${sel === o.id ? 'sel' : ''}`} onClick={() => setParam({ sel: String(o.id) })}>
                  <td><b>{o.summaryAddress || '—'}</b>{o.urgent ? <span className="pill urg" style={{ marginLeft: 6 }}>紧急</span> : null}</td>
                  <td className="sub"><div className="wo-list-problem" title={o.summaryContent || ''}>{o.summaryContent || '—'}</div></td>
                  <td><Pill status={stageOf(o)} /></td>
                  <td>{o.assigneeName || (stageOf(o) === 'pending_accept' ? <span className="muted">已自动派给 {o.candidateIds?.length} 位</span> : <span className="muted">—</span>)}</td>
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
