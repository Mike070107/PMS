import { App as AntdApp, Spin } from 'antd';
import { useEffect, useState } from 'react';
import type { WarehouseView } from '@pms/shared-types';
import StocktakePanel from '../components/StocktakePanel';
import { request } from '../lib/api';
import { usePagePerm } from '../lib/auth';

/**
 * Web 端独立盘点入口。与「库存与采购」分开授权，
 * 办公室、经理和盘点人员可以按业务角色单独分配。
 */
export default function StocktakePage() {
  const { message } = AntdApp.useApp();
  const { canEdit } = usePagePerm('stocktakes');
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
