/**
 * 工单「看一眼」抽屉。
 *
 * 采购申请 / 采购单里点来源工单号，只是想顺便看看这张单是什么，不是要去处理它。
 * 以前直接跳到工单管理页，看完还得回来找刚才点的位置（2026-09-05 Mike）。
 * 这里只读、不带任何业务操作；真要处理，右上角「去工单管理处理」再跳。
 * 表单里凡是「顺便看一眼工单」的链接都用它，别再各写一个跳转。
 */
import { useEffect, useState } from 'react';
import { Alert, Button, Descriptions, Drawer, Image, Space, Spin, Tag, Typography } from 'antd';
import { useNavigate } from 'react-router-dom';
import { REPAIR_TYPE_LABELS, WORK_ORDER_STATUS_LABELS, formatDateTimeCn } from '@pms/shared-types';
import type { WorkOrderStatus } from '@pms/shared-types';
import { request } from '../lib/api';
import { nameOr } from '../lib/displayName';
import { imageSrc } from './MaterialPhotos';

const { Text } = Typography;

interface PeekWorkOrder {
  id: number;
  orderNo: string;
  status: WorkOrderStatus;
  urgent?: boolean;
  repairType?: string | null;
  repairTypeLabel?: string | null;
  summaryAddress?: string | null;
  summaryContent?: string | null;
  faultLocation?: string | null;
  faultSymptom?: string | null;
  repairContent?: string | null;
  assigneeName?: string | null;
  contactName?: string | null;
  photos?: string[];
  missingMaterials?: Array<{ name: string; qty: number; unit?: string; spec?: string }>;
  createdAt?: string;
  dispatchedAt?: string | null;
  completedAt?: string | null;
  slaDueAt?: string | null;
}

interface PeekDetail {
  workOrder: PeekWorkOrder;
  /** 报修单原文：工单摘要为空时退回这里拿内容 / 类型 */
  request?: {
    addressText?: string | null;
    contactName?: string | null;
    contactPhone?: string | null;
    content?: string | null;
    description?: string | null;
    repairType?: string | null;
  } | null;
}

interface Props {
  workOrderId: number | null;
  onClose: () => void;
}

const when = (value?: string | null) => (value ? formatDateTimeCn(value) : '—');

export default function WorkOrderPeekDrawer({ workOrderId, onClose }: Props) {
  const navigate = useNavigate();
  const [detail, setDetail] = useState<PeekDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!workOrderId) {
      setDetail(null);
      setError('');
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError('');
    request<PeekDetail>({ url: `/work-orders/${workOrderId}` })
      .then((r) => { if (!cancelled) setDetail(r); })
      .catch((e: any) => { if (!cancelled) setError(e?.message || '工单加载失败'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [workOrderId]);

  const wo = detail?.workOrder;
  const req = detail?.request;
  const photos = wo?.photos || [];
  const content = wo?.summaryContent
    || [wo?.faultLocation, wo?.faultSymptom].filter(Boolean).join(' · ')
    || req?.content
    || req?.description
    || '';
  // 详情接口不一定带中文类型名：先用后端给的，再查内置类型表，最后才露编码
  const typeCode = wo?.repairType || req?.repairType || '';
  const typeLabel = wo?.repairTypeLabel || (typeCode ? REPAIR_TYPE_LABELS[typeCode] || typeCode : '');

  return (
    <Drawer
      open={!!workOrderId}
      onClose={onClose}
      width="min(560px, 96vw)"
      // 采购申请详情本身就是一个抽屉，这个要叠在它上面
      zIndex={1100}
      title={wo ? (
        <Space size={8} wrap>
          <span>工单 {wo.orderNo}</span>
          <Tag>{WORK_ORDER_STATUS_LABELS[wo.status] || wo.status}</Tag>
          {wo.urgent && <Tag color="red">紧急</Tag>}
        </Space>
      ) : '工单'}
      extra={wo ? (
        <Button size="small" onClick={() => navigate(`/work-orders?id=${wo.id}`)}>去工单管理处理</Button>
      ) : null}
    >
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 12 }}
        message="只是看一眼：这里不做任何操作，关掉就回到刚才的位置。"
      />
      {loading && <Spin />}
      {error && <Alert type="error" showIcon message={error} />}
      {wo && (
        <Space direction="vertical" size={16} style={{ width: '100%' }}>
          <Descriptions
            column={1}
            size="small"
            bordered
            items={[
              { key: 'address', label: '地址', children: wo.summaryAddress || req?.addressText || <Text type="secondary">地址待补充</Text> },
              { key: 'content', label: '报修内容', children: content || <Text type="secondary">—</Text> },
              { key: 'type', label: '报修类型', children: typeLabel || '—' },
              { key: 'assignee', label: '维修工', children: wo.assigneeName || <Text type="secondary">未派单</Text> },
              {
                key: 'contact',
                label: '报修人',
                children: [nameOr(wo.contactName || req?.contactName, '报修人'), req?.contactPhone].filter(Boolean).join(' · '),
              },
              { key: 'created', label: '报修时间', children: when(wo.createdAt) },
              { key: 'dispatched', label: '派单时间', children: when(wo.dispatchedAt) },
              { key: 'completed', label: '完工时间', children: when(wo.completedAt) },
              ...(wo.repairContent ? [{ key: 'repair', label: '维修记录', children: wo.repairContent }] : []),
            ]}
          />
          {!!wo.missingMaterials?.length && (
            <div>
              <Text strong>缺料清单</Text>
              <div style={{ marginTop: 6 }}>
                <Space size={[6, 6]} wrap>
                  {wo.missingMaterials.map((item, index) => (
                    <Tag key={`${item.name}-${index}`}>
                      {item.name}{item.spec ? ` · ${item.spec}` : ''} × {item.qty}{item.unit || ''}
                    </Tag>
                  ))}
                </Space>
              </div>
            </div>
          )}
          {!!photos.length && (
            <div>
              <Text strong>现场照片</Text>
              <div style={{ marginTop: 6 }}>
                <Image.PreviewGroup>
                  <Space size={[8, 8]} wrap>
                    {photos.map((url) => (
                      <Image
                        key={url}
                        src={imageSrc(url)}
                        width={88}
                        height={88}
                        style={{ objectFit: 'cover', borderRadius: 8 }}
                      />
                    ))}
                  </Space>
                </Image.PreviewGroup>
              </div>
            </div>
          )}
        </Space>
      )}
    </Drawer>
  );
}
