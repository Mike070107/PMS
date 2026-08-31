/**
 * 表格序号列 + 与它配套的受控分页。
 *
 * 为什么做成公共实现：序号是每张后台大表都会被提的需求，各页面各写一套的结果一定是
 * `render: (_v, _row, index) => index + 1` —— 那是**当前页内**的下标，翻到第 2 页
 * 序号又从 1 开始（「基础资料 → 材料SKU」那张表原来就是这样）。序号要连续就必须知道
 * 当前页码，页码只有受控分页才拿得到，所以两件事绑在一起给：
 *
 *   const seq = useTableSeq(filtered.length, { defaultPageSize: 20 });
 *   <Table pagination={seq.pagination} columns={[seq.column, ...其它列]} />
 *
 * 列的 key 固定是 'seq'，可以直接丢进 useTableColumnPrefs（那个 hook 要求每列有稳定 key）。
 * 新表要序号一律用这里，别再手写 index + 1。
 */
import { useEffect, useMemo, useState } from 'react';
import type { TablePaginationConfig } from 'antd';
import type { ColumnType } from 'antd/es/table';

export interface TableSeqOptions {
  defaultPageSize?: number;
  pageSizeOptions?: Array<string | number>;
  showSizeChanger?: boolean;
  size?: TablePaginationConfig['size'];
  /** 序号列宽；行数上万时可以调宽一点 */
  width?: number;
}

export interface TableSeq<T> {
  pagination: TablePaginationConfig;
  column: ColumnType<T> & { key: string };
  /** 当前页第一行的序号减一。自己拼列时用得上 */
  offset: number;
}

export function useTableSeq<T>(total: number, options: TableSeqOptions = {}): TableSeq<T> {
  const {
    defaultPageSize = 20,
    pageSizeOptions,
    showSizeChanger = true,
    size,
    width = 64,
  } = options;
  const [current, setCurrent] = useState(1);
  const [pageSize, setPageSize] = useState(defaultPageSize);

  /* 筛选后条数变少时把页码拉回合法范围。
     受控分页不会自己修正，停在第 5 页而数据只剩一页的话，用户看到的是一张空表。 */
  useEffect(() => {
    const maxPage = Math.max(1, Math.ceil(total / pageSize));
    if (current > maxPage) setCurrent(maxPage);
  }, [total, pageSize, current]);

  const offset = (current - 1) * pageSize;

  const pagination = useMemo<TablePaginationConfig>(
    () => ({
      current,
      pageSize,
      showSizeChanger,
      pageSizeOptions,
      size,
      onChange: (page: number, nextPageSize: number) => {
        setCurrent(page);
        setPageSize(nextPageSize);
      },
    }),
    [current, pageSize, showSizeChanger, pageSizeOptions, size],
  );

  const column = useMemo<ColumnType<T> & { key: string }>(
    () => ({
      key: 'seq',
      title: '序号',
      width,
      align: 'center',
      // 等宽数字，翻页时序号不会左右跳
      render: (_value: unknown, _row: T, index: number) => (
        <span style={{ fontVariantNumeric: 'tabular-nums' }}>{offset + index + 1}</span>
      ),
    }),
    [offset, width],
  );

  return { pagination, column, offset };
}
