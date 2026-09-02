import { App as AntdApp, Spin, Typography } from 'antd';
import { useEffect, useState } from 'react';
import type { WarehouseView } from '@pms/shared-types';
import StocktakePanel from '../components/StocktakePanel';
import { request } from '../lib/api';
import { usePagePerm } from '../lib/auth';

const { Title, Text } = Typography;

/**
 * Web 端独立盘点入口。数据和「库存与采购」里的快捷页签是同一套，
 * 放在左侧「材料与库存」分组下，办公室不用先进采购页再找。
 */
export default function StocktakePage() {
  const { message } = AntdApp.useApp();
  const { canEdit } = usePagePerm('inventory');
  const [warehouses, setWarehouses] = useState<WarehouseView[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    request<WarehouseView[]>({ url: '/warehouses', query: { scope: 'visible' } })
      .then(setWarehouses)
      .catch((e: any) => message.error(e?.message || '加载可盘点仓库失败'))
      .finally(() => setLoading(false));
  }, []);

  return (
    <div>
      <div style={{ marginBottom: 16 }}>
        <Title level={3} style={{ margin: 0 }}>库存盘点</Title>
        <Text type="secondary">发起盘点、录入账实差异、办公室复核过账并查看历史盘点报告。</Text>
      </div>
      <Spin spinning={loading}>
        <StocktakePanel warehouses={warehouses} canEdit={canEdit} />
      </Spin>
    </div>
  );
}
