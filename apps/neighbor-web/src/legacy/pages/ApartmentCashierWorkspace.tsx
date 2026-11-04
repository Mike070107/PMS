import { useState } from 'react';
import { Alert, Tabs } from 'antd';
import { BarChartOutlined, CreditCardOutlined, FileTextOutlined, SwapOutlined } from '@ant-design/icons';
import ApartmentCashierPage from './ApartmentCashierPage';
import { BillsTab, HouseDetailModal, ReconTab, ReportTab } from './FeesPage';

/** 复用收费账簿与统计口径；收款草稿保留，查询 tab 每次进入刷新。 */
export default function ApartmentCashierWorkspace({ preview = false }: { preview?: boolean }) {
  const [tab, setTab] = useState('cashier');
  const [houseId, setHouseId] = useState<number | null>(null);
  const previewNotice = <Alert type="info" showIcon message="当前为样式预览，请从正式公寓收费台查询收费数据。" />;
  return (
    <div className="apartment-cashier-workspace">
      <Tabs activeKey={tab} onChange={setTab} items={[
        { key: 'cashier', label: <span><CreditCardOutlined /> 收费工作台</span> },
        { key: 'bills', label: <span><FileTextOutlined /> 收费明细</span> },
        { key: 'reports', label: <span><BarChartOutlined /> 收费报表</span> },
        { key: 'recon', label: <span><SwapOutlined /> 财务对账</span> },
      ]} />
      <div hidden={tab !== 'cashier'}><ApartmentCashierPage preview={preview} /></div>
      {tab !== 'cashier' && preview ? previewNotice : <>
        {tab === 'bills' && <BillsTab readOnly onOpenHouse={setHouseId} />}
        {tab === 'reports' && <ReportTab />}
        {tab === 'recon' && <ReconTab />}
      </>}
      <HouseDetailModal houseId={houseId} onClose={() => setHouseId(null)} />
    </div>
  );
}
