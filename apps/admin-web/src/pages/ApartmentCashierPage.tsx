import {
  ApartmentOutlined,
  CarOutlined,
  CreditCardOutlined,
  DeleteOutlined,
  DownOutlined,
  EyeOutlined,
  HistoryOutlined,
  HomeOutlined,
  MobileOutlined,
  PhoneOutlined,
  PrinterOutlined,
  ReloadOutlined,
  RightOutlined,
  RollbackOutlined,
  ThunderboltOutlined,
  UserOutlined,
  WalletOutlined,
} from '@ant-design/icons';
import { App, Button, DatePicker, Empty, Input, InputNumber, Modal, Pagination, Select, Spin, Tag } from 'antd';
import { FEE_PAYMENT_METHOD_LABELS, formatFeeMoney } from '@pms/shared-types';
import dayjs from 'dayjs';
import { useEffect, useMemo, useState } from 'react';
import { usePagePerm } from '../lib/auth';
import { request } from '../lib/api';
import './ApartmentCashierPage.css';

type Owner = { id: number; name: string | null; phone: string | null };
type Building = { id: number; communityId: number; communityName?: string; buildingNo: string; lane?: string | null };
type House = {
  id: number; communityId: number; communityName: string; buildingId: number; buildingNo: string;
  roomNo: string; fullAddress: string | null; owner: Owner | null; owners: Owner[];
};
type FeeItem = {
  feeCode: string; feeName: string; unit: string; quantity: number; unitPriceCents: number;
  amountCents: number; serviceFrom?: string; serviceTo?: string; vehiclePlate?: string;
};
type ReceiptItem = {
  feeCode: string; feeName: string; quantity: number | null; unit: string | null;
  unitPriceCents: number | null; amountCents: number;
};
type HistoryRow = {
  receiptNo: string; paidAt: string; paymentMethod: string; cashier: string | null;
  amountCents: number; status: string; items: Array<{ feeName: string }>;
};
type TodayRow = {
  receiptNo: string; buildingNo: string; roomNo: string; ownerName: string | null;
  paidAt: string; paymentMethod: string; cashier: string | null;
  amountCents: number; status: string; items: Array<{ feeName: string }>;
};
type ReceiptPaperData = {
  receiptNo: string | null; communityName: string | null; place: string;
  ownerName: string | null; paidAt: string | null; paymentMethod: string | null;
  remark: string | null; amountCents: number; refunded: boolean;
  items: Array<{ feeCode: string; feeName: string; quantity: number | null; unit: string | null; amountCents: number }>;
};

const FEE_TYPES = [
  { code: 'electricity', name: '电费', unit: '度', icon: <ThunderboltOutlined />, tone: 'electricity' },
  { code: 'cold_water', name: '冷水费', unit: '吨', icon: <WaterDropIcon />, tone: 'cold-water' },
  { code: 'hot_water', name: '热水费', unit: '吨', icon: <WaterDropIcon />, tone: 'hot-water' },
  { code: 'network', name: '网费', unit: '月', icon: <MobileOutlined />, tone: 'network' },
  { code: 'parking', name: '停车费', unit: '月', icon: <CarOutlined />, tone: 'parking' },
  { code: 'rent', name: '房租', unit: '月', icon: <HomeOutlined />, tone: 'rent' },
  { code: 'management', name: '管理费', unit: '月', icon: <ApartmentOutlined />, tone: 'management' },
  { code: 'deposit', name: '押金', unit: '次', icon: <CreditCardOutlined />, tone: 'deposit' },
] as const;

const PAYMENT_METHODS = [
  { value: 'wechat', label: '微信', type: 'wechat' as const },
  { value: 'alipay', label: '支付宝', type: 'alipay' as const },
  { value: 'cash', label: '现金', type: 'cash' as const },
];

export default function ApartmentCashierPage({ preview = false }: { preview?: boolean }) {
  const { message } = App.useApp();
  const permission = usePagePerm('fees');
  const canEdit = preview || permission.canEdit;
  const [buildings, setBuildings] = useState<Building[]>([]);
  const [houses, setHouses] = useState<House[]>([]);
  const [buildingId, setBuildingId] = useState<number>();
  const [houseId, setHouseId] = useState<number>();
  const [ownerName, setOwnerName] = useState('');
  const [ownerPhone, setOwnerPhone] = useState('');
  const [items, setItems] = useState<FeeItem[]>([]);
  const [paymentMethod, setPaymentMethod] = useState<string>();
  const [remark, setRemark] = useState('');
  const [history, setHistory] = useState<HistoryRow[]>([]);
  const [historyTotal, setHistoryTotal] = useState(0);
  const [historyPage, setHistoryPage] = useState(1);
  const [historyOpen, setHistoryOpen] = useState(true);
  const [loadingHouses, setLoadingHouses] = useState(false);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [receiptOpen, setReceiptOpen] = useState(false);
  const [receiptNo, setReceiptNo] = useState<string>();
  const [historyVersion, setHistoryVersion] = useState(0);
  const [rates, setRates] = useState<Record<string, number>>({});
  const [todayRows, setTodayRows] = useState<TodayRow[]>([]);
  const [todayTotal, setTodayTotal] = useState(0);
  const [todayCents, setTodayCents] = useState(0);
  const [todayPage, setTodayPage] = useState(1);
  const [loadingToday, setLoadingToday] = useState(false);
  const [openingReceipt, setOpeningReceipt] = useState<string>();
  const [receiptDetail, setReceiptDetail] = useState<(ReceiptPaperData & { items: ReceiptItem[] }) | null>(null);
  const [refundTarget, setRefundTarget] = useState<{ receiptNo: string; amountCents: number }>();
  const [refundReason, setRefundReason] = useState('');
  const [refunding, setRefunding] = useState(false);

  const house = houses.find((item) => item.id === houseId);
  const total = items.reduce((sum, item) => sum + item.amountCents, 0);

  useEffect(() => {
    if (preview) {
      setBuildings([{ id: 34, communityId: 20, communityName: '馨香臣寓吴泾店', buildingNo: 'A栋34号' }, { id: 35, communityId: 20, communityName: '馨香臣寓吴泾店', buildingNo: 'B栋35号' }, { id: 39, communityId: 20, communityName: '馨香臣寓吴泾店', buildingNo: 'C栋39号' }]);
      setBuildingId(34);
      return;
    }
    request<Building[]>({ url: '/buildings' })
      .then((rows) => {
        setBuildings(rows);
        if (rows.length === 1) setBuildingId(rows[0].id);
      })
      .catch((error) => message.error(error?.message || '楼栋加载失败'));
  }, [message, preview]);

  useEffect(() => {
    setHouses([]);
    setHouseId(undefined);
    setOwnerName('');
    setOwnerPhone('');
    if (!buildingId) return;
    if (preview) {
      setHouses([{ id: 101, communityId: 20, communityName: '馨香臣寓吴泾店', buildingId, buildingNo: buildings.find((item) => item.id === buildingId)?.buildingNo || 'A栋34号', roomNo: '101', fullAddress: '龙吴路4787弄34号101室', owner: { id: 1, name: '示例住户', phone: '138****8000' }, owners: [] }, { id: 102, communityId: 20, communityName: '馨香臣寓吴泾店', buildingId, buildingNo: buildings.find((item) => item.id === buildingId)?.buildingNo || 'A栋34号', roomNo: '102', fullAddress: '龙吴路4787弄34号102室', owner: null, owners: [] }]);
      setHouseId(101);
      return;
    }
    setLoadingHouses(true);
    request<House[]>({ url: '/houses', query: { buildingId } })
      .then(setHouses)
      .catch((error) => message.error(error?.message || '房号加载失败'))
      .finally(() => setLoadingHouses(false));
  }, [buildingId, buildings, message, preview]);

  useEffect(() => {
    const selected = houses.find((item) => item.id === houseId);
    setOwnerName(selected?.owner?.name || '');
    setOwnerPhone(selected?.owner?.phone || '');
    setItems([]);
    setPaymentMethod(undefined);
    setHistoryPage(1);
  }, [houseId, houses]);

  useEffect(() => {
    if (!houseId) { setRates({}); return; }
    if (preview) {
      setRates({ electricity: 80, cold_water: 500, hot_water: 800, network: 5000, parking: 30000, rent: 150000, management: 5000, deposit: 3000 });
      return;
    }
    setRates({});
    request<{ standards: Array<{ feeCode: string; amountCents: number; status: string }> }>({ url: `/fees/houses/${houseId}` })
      .then((data) => setRates(Object.fromEntries(data.standards.filter((item) => item.status === 'active').map((item) => [item.feeCode, item.amountCents]))))
      .catch(() => setRates({}));
  }, [houseId, preview]);

  useEffect(() => {
    if (!houseId) {
      setHistory([]);
      setHistoryTotal(0);
      return;
    }
    if (preview) {
      setHistory([{ receiptNo: 'SJ202610100001', paidAt: '2026-10-10T09:20:00+08:00', paymentMethod: 'wechat', cashier: '收费员', amountCents: 150000, status: 'paid', items: [{ feeName: '房租' }] }]);
      setHistoryTotal(1);
      return;
    }
    setLoadingHistory(true);
    request<{ rows: HistoryRow[]; total: number }>({
      url: `/fees/cashier/houses/${houseId}/history`, query: { page: historyPage },
    })
      .then((data) => { setHistory(data.rows); setHistoryTotal(data.total); })
      .catch((error) => message.error(error?.message || '历史收费记录加载失败'))
      .finally(() => setLoadingHistory(false));
  }, [historyPage, historyVersion, houseId, message, preview]);

  useEffect(() => {
    if (preview) {
      setTodayRows([
        { receiptNo: 'SJ202610100002', buildingNo: 'A栋34号', roomNo: '101', ownerName: '示例住户', paidAt: '2026-10-10T10:05:00+08:00', paymentMethod: 'cash', cashier: '收费员', amountCents: 150000, status: 'paid', items: [{ feeName: '房租' }] },
        { receiptNo: 'SJ202610100001', buildingNo: 'B栋35号', roomNo: '207', ownerName: '张三', paidAt: '2026-10-10T09:20:00+08:00', paymentMethod: 'wechat', cashier: '收费员', amountCents: 8600, status: 'refunded', items: [{ feeName: '电费' }, { feeName: '冷水费' }] },
      ]);
      setTodayTotal(2);
      setTodayCents(158600);
      return;
    }
    setLoadingToday(true);
    request<{ rows: TodayRow[]; total: number; totalCents: number }>({
      url: '/fees/cashier/today', query: { page: todayPage },
    })
      .then((data) => { setTodayRows(data.rows); setTodayTotal(data.total); setTodayCents(data.totalCents); })
      .catch((error) => message.error(error?.message || '今日收费流水加载失败'))
      .finally(() => setLoadingToday(false));
  }, [historyVersion, message, preview, todayPage]);

  const reload = () => { setHistoryVersion((value) => value + 1); };

  /** 补打：先记一条补打日志再出票面，小票是凭证，重复打印必须查得到。 */
  const reprint = async (no: string) => {
    if (preview) {
      const row = todayRows.find((item) => item.receiptNo === no);
      setReceiptDetail({
        receiptNo: no, communityName: '馨香臣寓吴泾店', place: `${row?.buildingNo || 'A栋34号'} ${row?.roomNo || '101'}室`,
        ownerName: row?.ownerName || '示例住户', paidAt: row?.paidAt || null, paymentMethod: row?.paymentMethod || 'cash',
        remark: null, amountCents: row?.amountCents ?? 150000, refunded: row?.status === 'refunded',
        items: [{ feeCode: 'rent', feeName: '房租', quantity: 1, unit: '月', unitPriceCents: 150000, amountCents: row?.amountCents ?? 150000 }],
      });
      setReceiptOpen(true);
      return;
    }
    setOpeningReceipt(no);
    try {
      await request({ method: 'POST', url: `/fees/cashier/receipts/${encodeURIComponent(no)}/reprint` });
      const detail = await request<any>({ url: `/fees/cashier/receipts/${encodeURIComponent(no)}` });
      setReceiptDetail({
        receiptNo: detail.receiptNo,
        communityName: detail.communityName,
        place: `${detail.buildingNo || ''} ${detail.roomNo || ''}室`.trim(),
        ownerName: detail.ownerName,
        paidAt: detail.paidAt,
        paymentMethod: detail.paymentMethod,
        remark: detail.remark,
        amountCents: detail.amountCents,
        refunded: detail.status === 'refunded',
        items: detail.items,
      });
      setReceiptOpen(true);
    } catch (error: any) {
      message.error(error?.message || '小票取数失败');
    } finally {
      setOpeningReceipt(undefined);
    }
  };

  const submitRefund = async () => {
    if (!refundTarget) return;
    if (preview) {
      setTodayRows((rows) => rows.map((row) => (row.receiptNo === refundTarget.receiptNo ? { ...row, status: 'refunded' } : row)));
      setRefundTarget(undefined);
      setRefundReason('');
      message.success(`已红冲 ${refundTarget.receiptNo}（预览模式）`);
      return;
    }
    setRefunding(true);
    try {
      const result = await request<{ receiptNo: string }>({
        method: 'POST',
        url: `/fees/cashier/receipts/${encodeURIComponent(refundTarget.receiptNo)}/refund`,
        data: { reason: refundReason || undefined },
      });
      message.success(`已红冲 ${refundTarget.receiptNo}，红冲收据号 ${result.receiptNo}`);
      setRefundTarget(undefined);
      setRefundReason('');
      reload();
    } catch (error: any) {
      message.error(error?.message || '红冲失败');
    } finally {
      setRefunding(false);
    }
  };

  const addFee = (code: string) => {
    if (items.some((item) => item.feeCode === code)) return;
    const definition = FEE_TYPES.find((item) => item.code === code)!;
    const unitPriceCents = rates[code] || 0;
    setItems((current) => [...current, {
      feeCode: definition.code,
      feeName: definition.name,
      unit: definition.unit,
      quantity: 1,
      unitPriceCents,
      amountCents: unitPriceCents,
    }]);
  };

  const updateItem = (code: string, patch: Partial<FeeItem>) => {
    setItems((current) => current.map((item) => {
      if (item.feeCode !== code) return item;
      const next = { ...item, ...patch };
      if ('quantity' in patch || 'unitPriceCents' in patch) {
        next.amountCents = Math.round(next.quantity * next.unitPriceCents);
      }
      return next;
    }));
  };

  const reset = () => {
    setItems([]); setPaymentMethod(undefined); setRemark(''); setReceiptNo(undefined);
  };

  const submit = async () => {
    if (!house || !paymentMethod || !items.length) return;
    if (items.some((item) => item.amountCents <= 0)) {
      message.error('请填写每个收费项目的数量、单价或实收金额');
      return;
    }
    setSubmitting(true);
    try {
      const result = await request<{ receiptNo: string }>({
        method: 'POST', url: '/fees/cashier/charges', data: {
          houseId: house.id,
          ownerId: house.owner?.id,
          ownerName,
          ownerPhone,
          paymentMethod,
          remark,
          items: items.map((item) => ({
            feeCode: item.feeCode,
            quantity: item.quantity,
            unit: item.unit,
            unitPriceCents: item.unitPriceCents,
            amountCents: item.amountCents,
            serviceFrom: item.serviceFrom,
            serviceTo: item.serviceTo,
            vehiclePlate: item.vehiclePlate,
          })),
        },
      });
      setReceiptNo(result.receiptNo);
      setReceiptOpen(true);
      setHistoryPage(1);
      setHistoryVersion((value) => value + 1);
      message.success(`收费成功，收据号 ${result.receiptNo}`);
    } catch (error: any) {
      message.error(error?.message || '收费提交失败，已保留当前输入');
    } finally {
      setSubmitting(false);
    }
  };

  const closeReceipt = () => { setReceiptOpen(false); setReceiptDetail(null); };

  /** 票面只有一个来源：补打时用后端取回的收据，否则用当前表单。 */
  const receiptPaper: ReceiptPaperData | null = receiptDetail ?? (house ? {
    receiptNo: receiptNo || null,
    communityName: house.communityName,
    place: `${house.buildingNo} ${house.roomNo}室`,
    ownerName: ownerName || null,
    paidAt: receiptNo ? new Date().toISOString() : null,
    paymentMethod: paymentMethod || null,
    remark: remark || null,
    amountCents: total,
    refunded: false,
    items: items.map((item) => ({
      feeCode: item.feeCode, feeName: item.feeName, quantity: item.quantity, unit: item.unit, amountCents: item.amountCents,
    })),
  } : null);

  const buildingOptions = useMemo(() => buildings.map((item) => ({
    value: item.id,
    label: buildings.some((other) => other.communityId !== item.communityId)
      ? `${item.communityName ? `${item.communityName} · ` : ''}${item.buildingNo}`
      : item.buildingNo,
  })), [buildings]);

  return (
    <div className="apartment-cashier">
      <div className="apartment-cashier__grid">
        <div className="apartment-cashier__main">
          <section className="cashier-card">
            <header className="cashier-card__heading"><span>1</span><h2>选择收费房间</h2><small>来自 PMS 房产资料</small></header>
            <div className="cashier-room-form">
              <label><b>楼栋</b><Select value={buildingId} onChange={setBuildingId} options={buildingOptions} placeholder="选择楼栋" showSearch optionFilterProp="label" /></label>
              <label><b>房号</b><Select loading={loadingHouses} value={houseId} onChange={setHouseId} options={houses.map((item) => ({ value: item.id, label: item.roomNo }))} placeholder={buildingId ? '选择房号' : '请先选择楼栋'} disabled={!buildingId} showSearch optionFilterProp="label" /></label>
              <label><b>姓名</b><Input value={ownerName} onChange={(event) => setOwnerName(event.target.value)} prefix={<UserOutlined />} placeholder="PMS 暂无姓名，可在此补录" /></label>
              <label><b>手机号</b><Input value={ownerPhone} onChange={(event) => setOwnerPhone(event.target.value)} prefix={<PhoneOutlined />} placeholder="PMS 暂无手机号，可在此补录" maxLength={30} /></label>
            </div>
            <p className="cashier-owner-hint"><UserOutlined />提交收费时，新增或修改的姓名、手机号会同步到 PMS 业主资料。</p>

            {house && <div className="cashier-selected-room">
              <HomeOutlined /><div><small>当前房间</small><strong>{house.buildingNo} {house.roomNo}室</strong></div>
              <span>{house.communityName}{house.fullAddress ? ` · ${house.fullAddress}` : ''}</span>
              <button type="button" onClick={() => setHistoryOpen((value) => !value)}>{historyOpen ? <DownOutlined /> : <RightOutlined />}历史缴费</button>
            </div>}

            {house && historyOpen && <div className="cashier-history">
              <header><span><HistoryOutlined /> 此房间历史缴费</span><Tag color="blue">收费时间倒序 · 10条/页</Tag></header>
              <Spin spinning={loadingHistory}>
                {history.length ? <div className="cashier-history__table">
                  <div className="cashier-history__head"><span>收费时间</span><span>账单号</span><span>收费项目</span><span>金额</span><span>方式</span><span>操作</span></div>
                  {history.map((row) => <div className="cashier-history__row" key={row.receiptNo}>
                    <span>{dayjs(row.paidAt).format('YYYY-MM-DD HH:mm')}</span><span>{row.receiptNo}</span>
                    <span>{row.items.map((item) => item.feeName).join('、')}</span><strong>{money(row.amountCents)}</strong>
                    <span>{FEE_PAYMENT_METHOD_LABELS[row.paymentMethod] || row.paymentMethod}</span>
                    <ReceiptActions
                      row={row}
                      canEdit={canEdit}
                      loading={openingReceipt === row.receiptNo}
                      onReprint={() => reprint(row.receiptNo)}
                      onRefund={() => { setRefundTarget({ receiptNo: row.receiptNo, amountCents: row.amountCents }); setRefundReason(''); }}
                    />
                  </div>)}
                </div> : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无历史收费" />}
              </Spin>
              {historyTotal > 10 && <Pagination size="small" current={historyPage} pageSize={10} total={historyTotal} showSizeChanger={false} onChange={setHistoryPage} />}
            </div>}
          </section>

          <section className="cashier-card">
            <header className="cashier-card__heading"><span>2</span><h2>添加收费项目</h2></header>
            <div className="cashier-fee-picker">
              {FEE_TYPES.map((fee) => <button className={`${fee.tone} ${items.some((item) => item.feeCode === fee.code) ? 'active' : ''}`} type="button" key={fee.code} onClick={() => addFee(fee.code)}>
                <i>{fee.icon}</i><b>{fee.name}</b><small>{items.some((item) => item.feeCode === fee.code) ? '已添加' : '+'}</small>
              </button>)}
            </div>
            <div className="cashier-fee-table">
              <div className="cashier-fee-table__head"><span>收费项目</span><span>数量</span><span>单位</span><span>单价（元）</span><span>实收金额</span><span /></div>
              {items.length ? items.map((item) => <div className="cashier-fee-row-wrap" key={item.feeCode}>
                <div className="cashier-fee-table__row">
                  <strong>{item.feeName}</strong>
                  <InputNumber min={0} precision={3} value={item.quantity} onChange={(value) => updateItem(item.feeCode, { quantity: Number(value) || 0 })} />
                  <span>{item.unit}</span>
                  <InputNumber min={0} precision={2} value={item.unitPriceCents / 100} onChange={(value) => updateItem(item.feeCode, { unitPriceCents: Math.round((Number(value) || 0) * 100) })} />
                  <InputNumber min={0} precision={2} value={item.amountCents / 100} onChange={(value) => updateItem(item.feeCode, { amountCents: Math.round((Number(value) || 0) * 100) })} />
                  <Button type="text" danger icon={<DeleteOutlined />} aria-label={`删除${item.feeName}`} onClick={() => setItems((current) => current.filter((row) => row.feeCode !== item.feeCode))} />
                </div>
                {(item.feeCode === 'network' || item.feeCode === 'parking') && <div className="cashier-fee-extra">
                  <label>开始日期<DatePicker value={item.serviceFrom ? dayjs(item.serviceFrom) : null} onChange={(value) => updateItem(item.feeCode, { serviceFrom: value?.format('YYYY-MM-DD') })} /></label>
                  <label>结束日期<DatePicker value={item.serviceTo ? dayjs(item.serviceTo) : null} onChange={(value) => updateItem(item.feeCode, { serviceTo: value?.format('YYYY-MM-DD') })} /></label>
                  {item.feeCode === 'parking' && <label>车牌号<Input value={item.vehiclePlate} onChange={(event) => updateItem(item.feeCode, { vehiclePlate: event.target.value })} /></label>}
                </div>}
              </div>) : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="点击上方图标添加收费项目" />}
            </div>
          </section>

          <section className="cashier-card">
            <header className="cashier-card__heading">
              <span><WalletOutlined /></span><h2>今日收费流水</h2>
              <small>交班对账 · 含红冲抵消</small>
            </header>
            <div className="cashier-today__summary">
              <div><small>今日收款合计</small><strong>{money(todayCents)}</strong></div>
              <div><small>今日收据</small><b>{todayTotal} 张</b></div>
              <Button size="small" icon={<ReloadOutlined />} loading={loadingToday} onClick={reload}>刷新</Button>
            </div>
            <Spin spinning={loadingToday}>
              {todayRows.length ? <div className="cashier-today__scroll"><div className="cashier-history__table cashier-today__table">
                <div className="cashier-history__head"><span>收费时间</span><span>收据号</span><span>房号</span><span>姓名</span><span>收费项目</span><span>金额</span><span>方式</span><span>操作</span></div>
                {todayRows.map((row) => <div className="cashier-history__row" key={row.receiptNo}>
                  <span>{dayjs(row.paidAt).format('HH:mm')}</span><span>{row.receiptNo}</span>
                  <span>{row.buildingNo} {row.roomNo}室</span><span>{row.ownerName || '-'}</span>
                  <span>{row.items.map((item) => item.feeName).join('、')}</span>
                  <strong className={row.amountCents < 0 ? 'is-negative' : undefined}>{money(row.amountCents)}</strong>
                  <span>{FEE_PAYMENT_METHOD_LABELS[row.paymentMethod] || row.paymentMethod}</span>
                  <ReceiptActions
                    row={row}
                    canEdit={canEdit}
                    loading={openingReceipt === row.receiptNo}
                    onReprint={() => reprint(row.receiptNo)}
                    onRefund={() => { setRefundTarget({ receiptNo: row.receiptNo, amountCents: row.amountCents }); setRefundReason(''); }}
                  />
                </div>)}
              </div></div> : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="今天还没有收费记录" />}
            </Spin>
            {todayTotal > 20 && <Pagination size="small" current={todayPage} pageSize={20} total={todayTotal} showSizeChanger={false} onChange={setTodayPage} />}
          </section>
        </div>

        <aside className="cashier-checkout">
          <header className="cashier-card__heading"><span>3</span><h2>确认收款</h2></header>
          <div className="cashier-checkout__address"><small>收费对象</small><strong>{house ? `${house.buildingNo} ${house.roomNo}室` : '尚未选择房间'}</strong><span>{ownerName || ownerPhone || '住户信息待填写'}</span></div>
          <dl><div><dt>收费项目</dt><dd>{items.length} 项</dd></div><div><dt>收费时间</dt><dd>提交时自动记录</dd></div></dl>
          <fieldset className="cashier-payment"><legend>收款方式</legend>{PAYMENT_METHODS.map((item) => <button type="button" className={`${item.type} ${paymentMethod === item.value ? 'active' : ''}`} key={item.value} onClick={() => setPaymentMethod(item.value)}><LegacyPaymentIcon type={item.type} /><span>{item.label}</span></button>)}</fieldset>
          <label className="cashier-remark"><span>备注</span><Input.TextArea rows={3} value={remark} onChange={(event) => setRemark(event.target.value)} placeholder="选填" maxLength={255} showCount /></label>
          <div className="cashier-total"><span>收款合计</span><strong>{formatFeeMoney(total)}</strong></div>
          <Button block type="primary" size="large" icon={<PrinterOutlined />} loading={submitting} disabled={!canEdit || !house || !items.length || !paymentMethod} onClick={submit}>收费并生成小票</Button>
          <Button block icon={<EyeOutlined />} disabled={!house || !items.length} onClick={() => setReceiptOpen(true)}>打印预览</Button>
          <Button block onClick={reset}>清空重填</Button>
        </aside>
      </div>

      <Modal open={receiptOpen} onCancel={closeReceipt} width={520} title={<span><PrinterOutlined /> {receiptDetail ? `补打小票 · ${receiptDetail.receiptNo}` : '打印预览 · 热敏小票'}</span>} footer={<><Button onClick={closeReceipt}>关闭</Button><Button type="primary" icon={<PrinterOutlined />} onClick={() => window.print()}>打印</Button></>} centered className="cashier-receipt-modal">
        <div className="cashier-receipt-stage">
          <ReceiptPaper data={receiptPaper} />
          <p>兼容 60–72mm 热敏小票；打印时只输出白色票面。</p>
        </div>
      </Modal>

      <Modal
        open={!!refundTarget}
        onCancel={() => setRefundTarget(undefined)}
        title={<span><RollbackOutlined /> 红冲收据 {refundTarget?.receiptNo}</span>}
        okText="确认红冲"
        okButtonProps={{ danger: true, loading: refunding }}
        onOk={submitRefund}
        centered
      >
        <p className="cashier-refund-hint">
          原收据 <b>{refundTarget?.receiptNo}</b>（{money(refundTarget?.amountCents || 0)}）全部明细将标记为红冲，
          并自动生成一张金额为 <b>{money(-(refundTarget?.amountCents || 0))}</b> 的红冲收据。原收据不会删除，仍可查询和补打。
        </p>
        <label className="cashier-remark">
          <span>红冲原因（选填，会记入操作日志）</span>
          <Input.TextArea rows={3} value={refundReason} onChange={(event) => setRefundReason(event.target.value)} maxLength={200} showCount placeholder="例如：住户付款方式填错，重新开票" />
        </label>
      </Modal>
    </div>
  );
}

/** 负数金额按中文习惯写成 -¥1,500.00，别写成 ¥-1,500.00。 */
function money(cents: number) {
  return cents < 0 ? `-${formatFeeMoney(-cents)}` : formatFeeMoney(cents);
}

function ReceiptActions({ row, canEdit, loading, onReprint, onRefund }: {
  row: { receiptNo: string; status: string; amountCents: number };
  canEdit: boolean; loading: boolean; onReprint: () => void; onRefund: () => void;
}) {
  const refunded = row.status === 'refunded';
  return (
    <span className="cashier-row-actions">
      <Button type="link" size="small" icon={<PrinterOutlined />} loading={loading} onClick={onReprint}>补打</Button>
      {refunded
        ? <Tag color="red">已红冲</Tag>
        : <Button type="link" size="small" danger icon={<RollbackOutlined />} disabled={!canEdit || row.amountCents <= 0} onClick={onRefund}>红冲</Button>}
    </span>
  );
}

function ReceiptPaper({ data }: { data: ReceiptPaperData | null }) {
  if (!data) return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="尚未选择房间" />;
  return (
    <article className="cashier-receipt">
      <header><h2>物业收费凭证</h2><strong>{data.communityName || '公寓收费'}</strong>{data.refunded && <em>（已红冲）</em>}</header>
      <section>
        <div><span>收费时间</span><b>{data.paidAt ? dayjs(data.paidAt).format('YYYY-MM-DD HH:mm') : '提交时自动记录'}</b></div>
        <div><span>地址</span><b>{data.place || '-'}</b></div>
        <div><span>姓名</span><b>{data.ownerName || '-'}</b></div>
        <div><span>收款方式</span><b>{data.paymentMethod ? FEE_PAYMENT_METHOD_LABELS[data.paymentMethod] || data.paymentMethod : '待选择'}</b></div>
      </section>
      <section className="cashier-receipt__items">
        <h3>收费项目</h3>
        {data.items.map((item) => <div key={item.feeCode}>
          <span>{item.feeName}{item.quantity ? ` × ${item.quantity}${item.unit || ''}` : ''}</span>
          <b>{money(item.amountCents)}</b>
        </div>)}
      </section>
      <div className="cashier-receipt__total"><span>合计</span><strong>{money(data.amountCents)}</strong></div>
      <section>
        <div><span>账单号</span><b>{data.receiptNo || '提交后自动生成'}</b></div>
        <div><span>备注</span><b>{data.remark || '-'}</b></div>
      </section>
      <footer>— 谢谢 —</footer>
    </article>
  );
}

function WaterDropIcon() { return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.5S5.5 9.7 5.5 14.2a6.5 6.5 0 0 0 13 0C18.5 9.7 12 2.5 12 2.5Z" fill="currentColor" /></svg>; }

const LEGACY_PAYMENT_PATHS = {
  wechat: 'M385 280Q395 280 404 279Q390 339 335 377Q281 415 208 416Q125 414 70 368Q15 322 13 251Q15 170 91 119L72 60L140 94Q145 93 151 92Q179 86 208 85Q217 85 226 86Q220 105 220 126Q222 192 268 235Q314 279 385 280ZM281 333Q304 332 305 309Q304 286 281 285Q269 285 261 291Q252 298 251 309Q252 320 261 327Q269 333 281 333ZM144 285Q133 285 124 291Q115 298 115 309Q115 320 124 327Q133 333 144 333Q168 332 169 309Q168 286 144 285ZM563 129Q561 189 513 228Q465 268 398 270Q326 268 280 228Q234 189 232 129Q234 69 280 29Q326 -11 398 -13Q425 -12 453 -4Q454 -3 456 -3L510 -32L495 16Q525 39 544 67Q562 96 563 129ZM344 153Q336 153 331 159Q325 165 325 173Q325 180 331 186Q336 192 344 192Q367 190 368 173Q367 155 344 153ZM451 153Q443 153 438 159Q432 165 432 173Q432 180 438 186Q443 192 451 192Q474 190 475 173Q474 155 451 153Z',
  alipay: 'M378 416H70Q40 415 21 395Q1 376 0 346V38Q1 8 21 -11Q40 -31 70 -32H378Q407 -31 427 -12Q447 8 448 38Q413 57 368 81Q323 104 276 126Q252 92 214 69Q176 46 128 45Q76 47 54 72Q32 96 31 121Q26 152 47 177Q68 201 130 203Q185 201 257 178Q270 201 277 219Q284 237 284 238H106V255H198V286H88V305H198V356H249V305H358V286H249V255H337Q337 253 327 226Q317 199 299 164Q337 151 376 137Q412 124 448 111V346Q447 376 427 395Q408 415 378 416ZM47 125Q47 108 60 91Q74 73 117 71Q156 73 186 95Q216 118 235 144Q166 174 126 176Q76 174 61 157Q45 140 47 125Z',
  cash: 'M0 335V26Q1 -4 27 -16Q92 -38 158 -30Q223 -22 288 -4Q348 13 408 22Q468 30 527 15Q545 11 560 21Q575 30 576 49V358Q575 388 549 400Q484 422 419 414Q353 406 288 388Q228 371 168 363Q108 354 49 369Q30 373 16 364Q1 354 0 335ZM288 96Q254 97 231 124Q209 151 208 192Q209 233 231 260Q254 287 288 288Q322 287 345 260Q367 233 368 192Q367 151 345 124Q322 97 288 96ZM64 96Q91 95 109 77Q127 59 128 32H64V96ZM128 304Q127 277 109 259Q91 241 64 240V304H128ZM512 144V80H448Q449 107 467 125Q485 143 512 144ZM448 352H512V288Q485 289 467 307Q449 325 448 352Z',
} as const;

function LegacyPaymentIcon({ type }: { type: keyof typeof LEGACY_PAYMENT_PATHS }) {
  const width = type === 'alipay' ? 448 : 576;
  return <svg viewBox={`0 0 ${width} 448`} aria-hidden="true"><path d={LEGACY_PAYMENT_PATHS[type]} transform="translate(0 416) scale(1 -1)" fill="currentColor" /></svg>;
}
