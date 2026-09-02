import {
  PrinterOutlined,
  ReloadOutlined,
  ThunderboltOutlined,
  WarningOutlined,
} from '@ant-design/icons';
import {
  Alert,
  App as AntdApp,
  Button,
  Card,
  Empty,
  Modal,
  Progress,
  Segmented,
  Select,
  Space,
  Table,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { BuildingQrRow, QrBackfillResp } from '@pms/shared-types';
import { request } from '../lib/api';
import { usePagePerm } from '../lib/auth';
import { searchableWideSelectProps, withOptionTitles } from '../lib/selectProps';

const { Title, Text, Paragraph } = Typography;

interface Community {
  id: number;
  name: string;
  parentId?: number | null;
}

/** A5 竖版每页张数 → 栅格 class 后缀 */
const PER_PAGE_OPTIONS = [
  { value: 1, label: '每页 1 张（整页大码，贴单元门口）' },
  { value: 2, label: '每页 2 张（上下对开）' },
  { value: 4, label: '每页 4 张（裁开贴信箱）' },
] as const;

type PerPage = (typeof PER_PAGE_OPTIONS)[number]['value'];

/**
 * 把「枫桦景苑二期 228弄3号 · 扫码报修」拆成码上/码下两行。
 * 文案是生成时定好落库的，这里只负责排版，不重新拼。
 */
function splitCaption(row: BuildingQrRow): { title: string; sub: string } {
  const caption = row.qr?.caption?.trim();
  if (caption) {
    const at = caption.lastIndexOf('·');
    if (at > 0) {
      return {
        title: caption.slice(0, at).trim(),
        sub: caption.slice(at + 1).trim(),
      };
    }
    return { title: caption, sub: '扫码报修' };
  }
  return {
    title: `${row.communityName} ${row.buildingText}`.trim(),
    sub: '扫码报修',
  };
}

function chunk<T>(items: T[], size: number): T[][] {
  const pages: T[][] = [];
  for (let i = 0; i < items.length; i += size) pages.push(items.slice(i, i + size));
  return pages;
}

export default function QrPage() {
  const { message, modal } = AntdApp.useApp();
  const { canEdit } = usePagePerm('qr');

  const [communities, setCommunities] = useState<Community[]>([]);
  const [communityId, setCommunityId] = useState<number | undefined>();
  const [rows, setRows] = useState<BuildingQrRow[]>([]);
  const [loading, setLoading] = useState(false);

  const [selectedKeys, setSelectedKeys] = useState<number[]>([]);
  const [backfilling, setBackfilling] = useState(false);
  const [backfillDone, setBackfillDone] = useState(0);
  const [backfillTotal, setBackfillTotal] = useState(0);

  const [printOpen, setPrintOpen] = useState(false);
  const [perPage, setPerPage] = useState<PerPage>(1);
  const cancelBackfill = useRef(false);

  // ---------------- 数据 ----------------

  useEffect(() => {
    request<Community[]>({ url: '/communities' })
      .then(setCommunities)
      .catch((e: any) => message.error(e?.message || '加载小区失败'));
  }, [message]);

  // 分组节点（如「枫桦景苑」）下面不挂楼栋，不出现在筛选里
  const communityOptions = useMemo(() => {
    const parentIds = new Set(
      communities.map((item) => item.parentId).filter((id): id is number => !!id),
    );
    return withOptionTitles(
      communities
        .filter((item) => !parentIds.has(item.id))
        .map((item) => ({ value: item.id, label: item.name })),
    );
  }, [communities]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const list = await request<BuildingQrRow[]>({
        url: '/qr-codes/buildings',
        query: { communityId },
      });
      setRows(list);
      setSelectedKeys((keys) => keys.filter((id) => list.some((r) => r.buildingId === id)));
    } catch (e: any) {
      message.error(e?.message || '加载楼栋码失败');
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [communityId, message]);

  useEffect(() => {
    load();
  }, [load]);

  const stats = useMemo(() => {
    const ready = rows.filter((r) => r.qr?.imageUrl).length;
    const failed = rows.filter((r) => !r.qr?.imageUrl && r.qr?.lastError).length;
    return { total: rows.length, ready, failed, missing: rows.length - ready };
  }, [rows]);

  /** 最近一次失败原因：微信的错误对整批都是同一个，展示一条就够了 */
  const lastError = useMemo(
    () => rows.find((r) => !r.qr?.imageUrl && r.qr?.lastError)?.qr?.lastError ?? '',
    [rows],
  );

  // ---------------- 批量补齐 ----------------

  /** 分批调用直到 remaining = 0，边跑边显示进度，避免单请求打满网关超时 */
  const runBackfill = useCallback(
    async (force: boolean) => {
      cancelBackfill.current = false;
      setBackfilling(true);
      setBackfillDone(0);
      setBackfillTotal(force ? rows.length : stats.missing);

      let generated = 0;
      let created = 0;
      let processed = 0;
      const failures: Array<{ buildingText: string; reason: string }> = [];
      try {
        // 后端一次最多出 40 张，remaining > 0 就接着要下一批
        for (let guard = 0; guard < 200; guard += 1) {
          if (cancelBackfill.current) break;
          const resp = await request<QrBackfillResp>({
            method: 'POST',
            url: '/qr-codes/backfill-buildings',
            data: { communityId, force, limit: 40 },
          });
          created += resp.created;
          generated += resp.generated;
          failures.push(...resp.failed);
          processed += resp.generated + resp.failed.length;
          setBackfillDone(processed);
          setBackfillTotal(processed + resp.remaining);
          // 一张都没成功且还有剩余：多半是配置问题，再循环下去只会一直撞同一个错
          if (resp.remaining === 0 || resp.generated + resp.failed.length === 0) break;
        }

        if (failures.length) {
          modal.error({
            title: `完成 ${generated} 张，失败 ${failures.length} 张`,
            width: 640,
            content: (
              <div>
                <Paragraph type="secondary" style={{ marginTop: 8 }}>
                  以下是微信返回的原始错误，按提示改完再点一次「批量补齐」：
                </Paragraph>
                <div style={{ maxHeight: 260, overflow: 'auto' }}>
                  {failures.slice(0, 20).map((item, i) => (
                    <Paragraph key={i} style={{ marginBottom: 6 }}>
                      <Text strong>{item.buildingText}</Text>：{item.reason}
                    </Paragraph>
                  ))}
                </div>
              </div>
            ),
          });
        } else {
          message.success(`已补齐：新建 ${created} 条，生成 ${generated} 张`);
        }
      } catch (e: any) {
        message.error(e?.message || '批量补齐失败');
      } finally {
        setBackfilling(false);
        load();
      }
    },
    [communityId, load, message, modal, rows.length, stats.missing],
  );

  const regenerate = useCallback(
    async (buildingIds: number[], refreshCaption: boolean) => {
      if (!buildingIds.length) return;
      setLoading(true);
      try {
        const resp = await request<{ generated: number; failed: Array<{ reason: string }> }>({
          method: 'POST',
          url: '/qr-codes/regenerate',
          data: { buildingIds, refreshCaption },
        });
        if (resp.failed.length) {
          message.error(`失败 ${resp.failed.length} 张：${resp.failed[0].reason}`);
        } else {
          message.success(`已重新生成 ${resp.generated} 张`);
        }
      } catch (e: any) {
        message.error(e?.message || '重新生成失败');
      } finally {
        await load();
      }
    },
    [load, message],
  );

  // ---------------- 打印 ----------------

  const selectedRows = useMemo(
    () => rows.filter((r) => selectedKeys.includes(r.buildingId)),
    [rows, selectedKeys],
  );
  const printableRows = useMemo(
    () => selectedRows.filter((r) => !!r.qr?.imageUrl),
    [selectedRows],
  );
  const pages = useMemo(() => chunk(printableRows, perPage), [printableRows, perPage]);

  const openPrint = () => {
    if (!selectedRows.length) return message.warning('先勾选要打印的楼栋');
    if (!printableRows.length) {
      return message.warning('勾选的楼栋还没有生成二维码，先点「批量补齐」');
    }
    setPrintOpen(true);
  };

  // ---------------- 表格 ----------------

  const columns: ColumnsType<BuildingQrRow> = [
    {
      title: '小区',
      dataIndex: 'communityName',
      width: 180,
      ellipsis: true,
    },
    {
      title: '楼栋',
      dataIndex: 'buildingText',
      width: 130,
    },
    {
      title: '印刷文案',
      key: 'caption',
      ellipsis: true,
      render: (_, row) => row.qr?.caption || <Text type="secondary">—</Text>,
    },
    {
      title: '状态',
      key: 'status',
      width: 150,
      filters: [
        { text: '已生成', value: 'ready' },
        { text: '未生成', value: 'missing' },
        { text: '生成失败', value: 'failed' },
      ],
      onFilter: (value, row) => {
        if (value === 'ready') return !!row.qr?.imageUrl;
        if (value === 'failed') return !row.qr?.imageUrl && !!row.qr?.lastError;
        return !row.qr?.imageUrl;
      },
      render: (_, row) => {
        if (row.qr?.imageUrl) {
          return (
            <Space size={4}>
              <Tag color="green">已生成</Tag>
              {row.qr.envVersion && row.qr.envVersion !== 'release' && (
                <Tooltip title="这张码只有开发者/体验者能扫开，正式贴码前要切回 release 重新生成">
                  <Tag color="orange">{row.qr.envVersion}</Tag>
                </Tooltip>
              )}
            </Space>
          );
        }
        if (row.qr?.lastError) {
          return (
            <Tooltip title={row.qr.lastError}>
              <Tag color="red" icon={<WarningOutlined />}>
                生成失败
              </Tag>
            </Tooltip>
          );
        }
        return <Tag>未生成</Tag>;
      },
    },
    {
      title: '二维码',
      key: 'image',
      width: 92,
      align: 'center',
      render: (_, row) =>
        row.qr?.imageUrl ? (
          <img
            src={row.qr.imageUrl}
            alt={row.qr.caption || row.buildingText}
            style={{ width: 56, height: 56, objectFit: 'contain' }}
          />
        ) : (
          <Text type="secondary">—</Text>
        ),
    },
    {
      title: '操作',
      key: 'action',
      width: 120,
      align: 'right',
      render: (_, row) =>
        canEdit ? (
          <Button size="small" onClick={() => regenerate([row.buildingId], true)}>
            重新生成
          </Button>
        ) : (
          <Text type="secondary">—</Text>
        ),
    },
  ];

  return (
    <div>
      <Paragraph className="pms-page-note" type="secondary">
        每个楼栋一张小程序码，微信「扫一扫」直接进报修页并带出小区/弄/号；
        未入驻的业主会被引导到入驻页，同样预填好位置。新建楼栋时自动生成。
      </Paragraph>

      {!!lastError && (
        <Alert
          type="error"
          showIcon
          style={{ marginBottom: 16 }}
          message="有二维码生成失败"
          description={lastError}
        />
      )}

      <Card
        styles={{ body: { paddingTop: 16 } }}
        title={
          <Space wrap size={12}>
            <Select
              placeholder="全部小区"
              allowClear
              value={communityId}
              onChange={(value) => setCommunityId(value)}
              options={communityOptions}
              style={{ minWidth: 240 }}
              {...searchableWideSelectProps}
            />
            <Text type="secondary">
              共 {stats.total} 栋 · 已生成 {stats.ready}
              {stats.missing > 0 ? ` · 待生成 ${stats.missing}` : ''}
              {stats.failed > 0 ? ` · 失败 ${stats.failed}` : ''}
            </Text>
          </Space>
        }
        extra={
          <Space wrap>
            <Button icon={<ReloadOutlined />} onClick={load} disabled={loading || backfilling}>
              刷新
            </Button>
            {canEdit && (
              <Tooltip title="连已生成的也重画一遍。改了落地页或小程序版本后用">
                <Button
                  onClick={() =>
                    modal.confirm({
                      title: '全部重新生成？',
                      content: `会重画当前范围内 ${rows.length} 张码，图片地址不变，已印出去的码依然有效。`,
                      okText: '开始',
                      cancelText: '取消',
                      onOk: () => runBackfill(true),
                    })
                  }
                  disabled={loading || backfilling || !rows.length}
                >
                  全部重新生成
                </Button>
              </Tooltip>
            )}
            {canEdit && (
              <Button
                type="primary"
                ghost
                icon={<ThunderboltOutlined />}
                loading={backfilling}
                disabled={loading || stats.missing === 0}
                onClick={() => runBackfill(false)}
              >
                批量补齐{stats.missing > 0 ? `（${stats.missing}）` : ''}
              </Button>
            )}
            <Button
              type="primary"
              icon={<PrinterOutlined />}
              onClick={openPrint}
              disabled={!selectedKeys.length}
            >
              预览并打印{selectedKeys.length ? `（${selectedKeys.length}）` : ''}
            </Button>
          </Space>
        }
      >
        {backfilling && (
          <div style={{ marginBottom: 16 }}>
            <Progress
              percent={
                backfillTotal ? Math.round((backfillDone / backfillTotal) * 100) : 0
              }
              status="active"
              format={() => `${backfillDone}/${backfillTotal}`}
            />
            <Space style={{ marginTop: 4 }}>
              <Text type="secondary">正在向微信逐张申请小程序码，请勿关闭页面</Text>
              <Button size="small" onClick={() => (cancelBackfill.current = true)}>
                停止
              </Button>
            </Space>
          </div>
        )}

        <Table<BuildingQrRow>
          rowKey="buildingId"
          size="middle"
          loading={loading}
          dataSource={rows}
          columns={columns}
          pagination={{ pageSize: 20, showSizeChanger: true, showTotal: (t) => `共 ${t} 栋` }}
          rowSelection={{
            selectedRowKeys: selectedKeys,
            onChange: (keys) => setSelectedKeys(keys as number[]),
            getCheckboxProps: (row) => ({ name: row.buildingText }),
          }}
          locale={{
            emptyText: (
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description={communityId ? '该小区还没有楼栋' : '还没有楼栋'}
              />
            ),
          }}
        />
      </Card>

      <Modal
        open={printOpen}
        onCancel={() => setPrintOpen(false)}
        width="min(1040px, 96vw)"
        style={{ top: 24 }}
        title={
          <Space wrap size={16}>
            <span>打印预览</span>
            <Segmented
              className="qr-no-print"
              value={perPage}
              onChange={(value) => setPerPage(value as PerPage)}
              options={PER_PAGE_OPTIONS.map((item) => ({
                value: item.value,
                label: item.label,
              }))}
            />
            <Text type="secondary" style={{ fontWeight: 400 }}>
              {printableRows.length} 张 · {pages.length} 页 A5
            </Text>
          </Space>
        }
        footer={
          <Space>
            {selectedRows.length !== printableRows.length && (
              <Text type="warning">
                已跳过 {selectedRows.length - printableRows.length} 个未生成的楼栋
              </Text>
            )}
            <Button onClick={() => setPrintOpen(false)}>关闭</Button>
            <Button type="primary" icon={<PrinterOutlined />} onClick={() => window.print()}>
              打印
            </Button>
          </Space>
        }
      >
        <Paragraph type="secondary" className="qr-no-print">
          浏览器打印时纸张选 A5、方向竖版、边距设为「无」，效果与下面一致。虚线是裁切线，不会印出来。
        </Paragraph>
        {/* 屏幕预览：和打印用的是同一套 .qr-sheet 盒模型，所见即所印 */}
        <div style={{ maxHeight: '66vh', overflow: 'auto', background: '#e9efee', padding: 12 }}>
          <QrSheets pages={pages} perPage={perPage} />
        </div>
      </Modal>

      {/*
        打印实体挂在 body 下（而不是 Modal 里）：
        Modal 内容外面套着 overflow:auto 的滚动容器，打印时会把超出一屏的页面裁掉。
        平时靠 .qr-print-offscreen 移出屏幕（不用行内样式，否则会压过 @media print 的规则），
        打印时由 #qr-print-root 的规则挪回可视区域。
      */}
      {printOpen &&
        createPortal(
          <div id="qr-print-root" className="qr-print-offscreen">
            <QrSheets pages={pages} perPage={perPage} />
          </div>,
          document.body,
        )}
    </div>
  );
}

function QrSheets({ pages, perPage }: { pages: BuildingQrRow[][]; perPage: PerPage }) {
  return (
    <>
      {pages.map((page, pageIndex) => (
        <div key={pageIndex} className={`qr-sheet qr-sheet--${perPage}`}>
          {page.map((row) => {
            const { title, sub } = splitCaption(row);
            return (
              <div key={row.buildingId} className="qr-card">
                <div className="qr-card__title">{title}</div>
                <img className="qr-card__img" src={row.qr?.imageUrl ?? ''} alt={title} />
                <div className="qr-card__sub">{sub}</div>
                <div className="qr-card__hint">微信扫一扫，报修直达</div>
              </div>
            );
          })}
        </div>
      ))}
    </>
  );
}
