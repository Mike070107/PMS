/**
 * 表格列偏好：拖动列宽、拖动调整列顺序，按「登录用户 + 表格」自动存到 localStorage。
 *
 * 为什么做成公共实现：列宽/列序是每张后台大表都会被提的需求（库存清单先提的），
 * 各页面各写一套必然一份改一份漏。新表接入只要两步：
 *   1. 给每列写上稳定的 key（不能省，dataIndex 在这些表里会重复，比如三列都取 materialId）
 *   2. const { columns, components, customized, reset } = useTableColumnPrefs('inventory.stock', cols)
 *      <Table columns={columns} components={components} />
 *
 * 约定与边界：
 * - fixed 列（左右吸边，通常是「操作」）不参与拖动排序，避免拖到中间后 fixed 布局错乱；
 *   列宽仍可拖。
 * - 存的是「key → 宽度」和「key 顺序」。以后代码里增删列不会让偏好失效：
 *   存档里没有的新列按代码里的位置插回去，代码里已删除的列自动忽略。
 * - 每个用户一份（key 带 userId），公用电脑上不会互相串。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { TableProps } from 'antd';
import type { ColumnType } from 'antd/es/table';
import { auth } from '../lib/auth';

/** 接入本 hook 的列必须有稳定 key —— 它是宽度和顺序的存档标识 */
export type PrefsColumn<T> = ColumnType<T> & { key: string };

interface StoredPrefs {
  v: 1;
  order?: string[];
  widths?: Record<string, number>;
}

const MIN_WIDTH = 60;
const MAX_WIDTH = 900;

function storageKeyOf(tableKey: string) {
  const userId = auth.getUser()?.id ?? 'anon';
  return `pms.table.${tableKey}.u${userId}`;
}

function loadPrefs(tableKey: string): StoredPrefs {
  try {
    const raw = localStorage.getItem(storageKeyOf(tableKey));
    if (!raw) return { v: 1 };
    const parsed = JSON.parse(raw) as StoredPrefs;
    if (!parsed || parsed.v !== 1) return { v: 1 };
    return parsed;
  } catch {
    return { v: 1 };
  }
}

function savePrefs(tableKey: string, prefs: StoredPrefs) {
  try {
    localStorage.setItem(storageKeyOf(tableKey), JSON.stringify(prefs));
  } catch {
    // 隐私模式 / 配额满：偏好存不下就算了，不能影响表格本身
  }
}

/**
 * 把存档顺序合到代码顺序上：
 * 存档里有的按存档排，存档里没有的（新加的列）回到它在代码里的相邻位置，
 * 这样以后加列不会「新列不见了」，也不用给存档做迁移。
 */
function mergeOrder(baseKeys: string[], savedOrder?: string[]) {
  if (!savedOrder?.length) return baseKeys;
  const known = new Set(baseKeys);
  const result = savedOrder.filter((key) => known.has(key));
  const placed = new Set(result);
  baseKeys.forEach((key, index) => {
    if (placed.has(key)) return;
    // 找它在代码里的前一个已落位的列，插到那之后；找不到就放最前
    let at = 0;
    for (let i = index - 1; i >= 0; i -= 1) {
      const prev = result.indexOf(baseKeys[i]);
      if (prev >= 0) { at = prev + 1; break; }
    }
    result.splice(at, 0, key);
    placed.add(key);
  });
  return result;
}

type DropSide = 'left' | 'right';

interface HeaderCellProps extends React.ThHTMLAttributes<HTMLTableCellElement> {
  pmsColKey?: string;
  pmsResizable?: boolean;
  pmsMovable?: boolean;
  pmsDragging?: boolean;
  pmsDropSide?: DropSide | null;
  pmsOnResizeStart?: (key: string, event: React.MouseEvent<HTMLElement>) => void;
  pmsOnDragStart?: (key: string) => void;
  pmsOnDragOver?: (key: string, side: DropSide) => void;
  pmsOnDrop?: (key: string) => void;
  pmsOnDragEnd?: () => void;
}

/**
 * 表头单元格。必须定义在模块顶层：
 * 组件标识每次渲染都变的话，React 会在拖动过程中把 th 卸载重建，dragstart 之后立刻 dragend，
 * 表现就是「按住拖不动」。所有回调通过 onHeaderCell 以 props 传进来。
 */
function PrefsHeaderCell(props: HeaderCellProps) {
  const {
    pmsColKey,
    pmsResizable,
    pmsMovable,
    pmsDragging,
    pmsDropSide,
    pmsOnResizeStart,
    pmsOnDragStart,
    pmsOnDragOver,
    pmsOnDrop,
    pmsOnDragEnd,
    children,
    className,
    ...rest
  } = props;

  if (!pmsColKey) return <th className={className} {...rest}>{children}</th>;

  const classes = [
    className,
    'pms-th',
    pmsDragging ? 'pms-th--dragging' : '',
    pmsDropSide === 'left' ? 'pms-th--drop-left' : '',
    pmsDropSide === 'right' ? 'pms-th--drop-right' : '',
  ].filter(Boolean).join(' ');

  return (
    <th
      {...rest}
      className={classes}
      draggable={pmsMovable ? true : undefined}
      onDragStart={pmsMovable ? (event) => {
        // Firefox 不设 data 不触发拖动
        event.dataTransfer.setData('text/plain', pmsColKey);
        event.dataTransfer.effectAllowed = 'move';
        pmsOnDragStart?.(pmsColKey);
      } : undefined}
      onDragOver={pmsMovable ? (event) => {
        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';
        const rect = event.currentTarget.getBoundingClientRect();
        pmsOnDragOver?.(pmsColKey, event.clientX < rect.left + rect.width / 2 ? 'left' : 'right');
      } : undefined}
      onDrop={pmsMovable ? (event) => {
        event.preventDefault();
        pmsOnDrop?.(pmsColKey);
      } : undefined}
      onDragEnd={pmsMovable ? () => pmsOnDragEnd?.() : undefined}
    >
      {children}
      {pmsResizable && (
        <span
          className="pms-th__resizer"
          // 拖宽度时不能同时触发列拖动：按下就把 th 的 draggable 关掉
          onMouseDown={(event) => {
            event.stopPropagation();
            event.preventDefault();
            pmsOnResizeStart?.(pmsColKey, event);
          }}
          onClick={(event) => event.stopPropagation()}
        />
      )}
    </th>
  );
}

export interface TableColumnPrefs<T> {
  columns: ColumnType<T>[];
  components: TableProps<T>['components'];
  /** 用户是否改过（用来决定要不要显示「恢复默认列」） */
  customized: boolean;
  reset: () => void;
}

export function useTableColumnPrefs<T>(tableKey: string, baseColumns: PrefsColumn<T>[]): TableColumnPrefs<T> {
  const [order, setOrder] = useState<string[] | undefined>(() => loadPrefs(tableKey).order);
  const [widths, setWidths] = useState<Record<string, number>>(() => loadPrefs(tableKey).widths || {});
  const [dragKey, setDragKey] = useState<string | null>(null);
  const [dropAt, setDropAt] = useState<{ key: string; side: DropSide } | null>(null);

  // 换表 / 换用户时重新读一次
  useEffect(() => {
    const prefs = loadPrefs(tableKey);
    setOrder(prefs.order);
    setWidths(prefs.widths || {});
  }, [tableKey]);

  const customized = Boolean(order?.length) || Object.keys(widths).length > 0;

  // 存档：拖宽度时 mousemove 会疯狂 setState，这里节流到 200ms 落盘一次
  const persistRef = useRef({ order, widths });
  persistRef.current = { order, widths };
  useEffect(() => {
    if (!customized) return;
    const timer = window.setTimeout(() => {
      savePrefs(tableKey, { v: 1, order: persistRef.current.order, widths: persistRef.current.widths });
    }, 200);
    return () => window.clearTimeout(timer);
  }, [tableKey, order, widths, customized]);

  const reset = useCallback(() => {
    setOrder(undefined);
    setWidths({});
    try {
      localStorage.removeItem(storageKeyOf(tableKey));
    } catch {
      // 同 savePrefs：存不了也不影响当前这次重置
    }
  }, [tableKey]);

  const onResizeStart = useCallback((key: string, event: React.MouseEvent<HTMLElement>, declared?: number) => {
    const th = (event.target as HTMLElement).closest('th');
    const rendered = th?.offsetWidth || 120;
    /* 基准必须取「声明宽」而不是 th.offsetWidth：
       表格总宽小于容器时，浏览器会按比例把每一列撑开（声明 220 可能渲染成 387）。
       拿渲染宽当基准的话，往左拖 120px 会算出 387-120=267 > 220，列反而变宽 —— 拖动方向是反的。
       撑开倍数用来把鼠标位移换算回声明宽；正常情况下（表格比容器宽、走横向滚动）倍数就是 1，
       拖多少就是多少像素。 */
    const startWidth = declared && declared > 0 ? declared : rendered;
    const scale = rendered > 0 && startWidth > 0 ? rendered / startWidth : 1;
    const startX = event.clientX;
    document.body.classList.add('pms-col-resizing');
    const onMove = (moveEvent: MouseEvent) => {
      const delta = (moveEvent.clientX - startX) / scale;
      const next = Math.round(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, startWidth + delta)));
      setWidths((prev) => (prev[key] === next ? prev : { ...prev, [key]: next }));
    };
    const onUp = () => {
      document.body.classList.remove('pms-col-resizing');
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, []);

  /* 排序只在「可移动列」内部进行，fixed 列位置不动。
     拖动过程中的状态用 ref 当权威值、state 只负责画高亮：
     dragstart / dragover / drop 有可能在同一帧内连着到达（比如测试里合成事件、
     或者用户快速甩一下），这时 React 还没重渲染，只在渲染里同步 ref 的话
     drop 拿到的 dragKey 仍是 null，表现就是「拖了没反应」。 */
  const movableKeys = useMemo(
    () => baseColumns.filter((col) => !col.fixed).map((col) => col.key),
    [baseColumns],
  );
  const movableKeysRef = useRef(movableKeys);
  movableKeysRef.current = movableKeys;
  const orderRef = useRef(order);
  orderRef.current = order;
  const dragKeyRef = useRef<string | null>(null);
  const dropAtRef = useRef<{ key: string; side: DropSide } | null>(null);

  const onDragStart = useCallback((key: string) => {
    dragKeyRef.current = key;
    setDragKey(key);
  }, []);

  const onDragOver = useCallback((key: string, side: DropSide) => {
    dropAtRef.current = { key, side };
    setDropAt((prev) => (prev && prev.key === key && prev.side === side ? prev : { key, side }));
  }, []);

  const clearDrag = useCallback(() => {
    dragKeyRef.current = null;
    dropAtRef.current = null;
    setDragKey(null);
    setDropAt(null);
  }, []);

  const onDrop = useCallback((targetKey: string) => {
    const from = dragKeyRef.current;
    const side = dropAtRef.current?.key === targetKey ? dropAtRef.current.side : 'right';
    clearDrag();
    if (!from || from === targetKey) return;
    const current = mergeOrder(movableKeysRef.current, orderRef.current);
    if (current.indexOf(from) < 0) return;
    const rest = current.filter((key) => key !== from);
    const targetIndex = rest.indexOf(targetKey);
    if (targetIndex < 0) return;
    rest.splice(side === 'left' ? targetIndex : targetIndex + 1, 0, from);
    orderRef.current = rest;
    setOrder(rest);
  }, [clearDrag]);

  const columns = useMemo(() => {
    const byKey = new Map(baseColumns.map((col) => [col.key, col]));
    const sortedMovable = mergeOrder(movableKeys, order);
    const queue = [...sortedMovable];
    // fixed 列留在原位（左右吸边），中间的按用户排的顺序回填
    const arranged = baseColumns.map((col) => (col.fixed ? col : byKey.get(queue.shift() as string) || col));

    return arranged.map<ColumnType<T>>((col) => {
      const key = col.key;
      const width = widths[key] ?? col.width;
      const declared = typeof width === 'number' ? width : undefined;
      const movable = !col.fixed;
      return {
        ...col,
        width,
        onHeaderCell: () => ({
          pmsColKey: key,
          pmsResizable: true,
          pmsMovable: movable,
          pmsDragging: dragKey === key,
          pmsDropSide: dragKey && dragKey !== key && dropAt?.key === key ? dropAt.side : null,
          pmsOnResizeStart: (k: string, event: React.MouseEvent<HTMLElement>) => onResizeStart(k, event, declared),
          pmsOnDragStart: onDragStart,
          pmsOnDragOver: onDragOver,
          pmsOnDrop: onDrop,
          pmsOnDragEnd: clearDrag,
        }) as React.HTMLAttributes<HTMLElement>,
      };
    });
  }, [baseColumns, movableKeys, order, widths, dragKey, dropAt, onResizeStart, onDragStart, onDragOver, onDrop, clearDrag]);

  const components = useMemo<TableProps<T>['components']>(() => ({ header: { cell: PrefsHeaderCell } }), []);

  return { columns, components, customized, reset };
}
