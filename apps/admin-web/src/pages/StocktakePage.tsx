import { App as AntdApp, Spin } from 'antd';
import { useEffect, useState } from 'react';
import type { WarehouseView } from '@pms/shared-types';
import StocktakePanel from '../components/StocktakePanel';
import { request } from '../lib/api';
import { usePagePerm } from '../lib/auth';

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
    <div className="stocktake-page">
      <Spin spinning={loading}>
        <StocktakePanel warehouses={warehouses} canEdit={canEdit} />
      </Spin>
    </div>
  );
}
