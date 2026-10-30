import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  App as AntdApp,
  Button,
  Card,
  Col,
  DatePicker,
  Descriptions,
  Drawer,
  Form,
  Image,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Row,
  Select,
  Space,
  Statistic,
  Switch,
  Table,
  Tabs,
  Tag,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
  DeleteOutlined,
  DownloadOutlined,
  EditOutlined,
  EnvironmentOutlined,
  ExperimentOutlined,
  FireOutlined,
  PlusOutlined,
  QrcodeOutlined,
  ReloadOutlined,
  SearchOutlined,
  ThunderboltOutlined,
  DashboardOutlined,
} from '@ant-design/icons';
import { address as addressApi, meters } from '@pms/api-client';
import type {
  ChargeStatus,
  MeterChargeRow,
  MeterDetailResp,
  MeterInput,
  MeterReadingRow,
  MeterRow,
  MeterStatus,
  MeterSummaryResp,
  MeterType,
  OcrSampleRow,
  OcrSampleStatus,
} from '@pms/api-client';
import dayjs, { type Dayjs } from 'dayjs';
import { imageSrc, MaterialPhotosUpload } from '../components/MaterialPhotos';
import { pagePerm, useAuth } from '../lib/auth';
import { exportXlsx } from '../lib/exportXlsx';
import './MeterManagementPage.css';

const { Text } = Typography;
const { RangePicker } = DatePicker;

const TYPE_OPTIONS = [
  { value: 'water', label: '水表' },
  { value: 'electricity', label: '电表' },
  { value: 'gas', label: '燃气表' },
  { value: 'heat', label: '热量表' },
];
const TYPE_LABEL: Record<string, string> = Object.fromEntries(TYPE_OPTIONS.map((item) => [item.value, item.label]));
const TYPE_UNIT: Record<string, string> = { water: 'm³', electricity: 'kWh', gas: 'm³', heat: 'GJ' };
const CHARGE_STATUS: Record<string, { label: string; color: string }> = {
  unpaid: { label: '待收', color: 'orange' },
  partial: { label: '部分收款', color: 'blue' },
  paid: { label: '已结清', color: 'green' },
  void: { label: '已作废', color: 'default' },
};
const PAY_METHODS = [
  { value: 'cash', label: '现金' },
  { value: 'wechat', label: '微信' },
  { value: 'alipay', label: '支付宝' },
  { value: 'bank', label: '银行转账' },
  { value: 'other', label: '其他' },
];

const money = (cents: number | string | null | undefined) => (Number(cents || 0) / 100).toFixed(2);
const timeText = (value: string | null | undefined) => (value ? dayjs(value).format('YYYY-MM-DD HH:mm') : '—');
const confidenceText = (value: string | number | null | undefined) =>
  value === null || value === undefined || value === '' ? '—' : `${Math.round(Number(value))}%`;

/** 浏览器定位是 WGS84，微信/高德用 GCJ-02；存库统一 GCJ-02，导航才不会偏几百米 */
function wgs84ToGcj02(lng: number, lat: number): [number, number] {
  const a = 6378245.0;
  const ee = 0.00669342162296594323;
  if (lng < 72.004 || lng > 137.8347 || lat < 0.8293 || lat > 55.8271) return [lng, lat];
  const transformLat = (x: number, y: number) => {
    let ret = -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
    ret += ((20.0 * Math.sin(6.0 * x * Math.PI) + 20.0 * Math.sin(2.0 * x * Math.PI)) * 2.0) / 3.0;
    ret += ((20.0 * Math.sin(y * Math.PI) + 40.0 * Math.sin((y / 3.0) * Math.PI)) * 2.0) / 3.0;
    ret += ((160.0 * Math.sin((y / 12.0) * Math.PI) + 320 * Math.sin((y * Math.PI) / 30.0)) * 2.0) / 3.0;
    return ret;
  };
  const transformLng = (x: number, y: number) => {
    let ret = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
    ret += ((20.0 * Math.sin(6.0 * x * Math.PI) + 20.0 * Math.sin(2.0 * x * Math.PI)) * 2.0) / 3.0;
    ret += ((20.0 * Math.sin(x * Math.PI) + 40.0 * Math.sin((x / 3.0) * Math.PI)) * 2.0) / 3.0;
    ret += ((150.0 * Math.sin((x / 12.0) * Math.PI) + 300.0 * Math.sin((x / 30.0) * Math.PI)) * 2.0) / 3.0;
    return ret;
  };
  let dLat = transformLat(lng - 105.0, lat - 35.0);
  let dLng = transformLng(lng - 105.0, lat - 35.0);
  const radLat = (lat / 180.0) * Math.PI;
  let magic = Math.sin(radLat);
  magic = 1 - ee * magic * magic;
  const sqrtMagic = Math.sqrt(magic);
  dLat = (dLat * 180.0) / (((a * (1 - ee)) / (magic * sqrtMagic)) * Math.PI);
  dLng = (dLng * 180.0) / ((a / sqrtMagic) * Math.cos(radLat) * Math.PI);
  return [lng + dLng, lat + dLat];
}

interface MeterFormValues {
  meterNo: string;
  meterType: MeterType;
  name?: string;
  spec?: string;
  manufacturer?: string;
  model?: string;
  multiplier?: number;
  integerDigits?: number;
  decimalDigits?: number;
  unit?: string;
  communityId?: number;
  installAddress?: string;
  latitude?: number;
  longitude?: number;
  ownerName?: string;
  ownerPhone?: string;
  unitPriceYuan?: number;
  billingEnabled?: boolean;
  initialReading?: number;
  initialReadingAt?: Dayjs;
  status?: MeterStatus;
  remark?: string;
  photoUrls?: string[];
}

function TypeTag({ type }: { type: string }) {
  const meta =
    type === 'water'
      ? { color: 'blue', icon: <ExperimentOutlined /> }
      : type === 'electricity'
        ? { color: 'gold', icon: <ThunderboltOutlined /> }
        : type === 'gas'
          ? { color: 'volcano', icon: <FireOutlined /> }
          : { color: 'purple', icon: <DashboardOutlined /> };
  return <Tag color={meta.color} icon={meta.icon}>{TYPE_LABEL[type] || type}</Tag>;
}

function ChargeTag({ status }: { status: string }) {
  const meta = CHARGE_STATUS[status] || { label: status, color: 'default' };
  return <Tag color={meta.color}>{meta.label}</Tag>;
}

export default function MeterManagementPage() {
  const { message } = AntdApp.useApp();
  const { access } = useAuth();
  const canEdit = pagePerm(access, 'meters').canEdit;
  const canDelete = pagePerm(access, 'meters').canDelete;

  const [tab, setTab] = useState('records');
  const [period, setPeriod] = useState<Dayjs>(dayjs());
  const [summary, setSummary] = useState<MeterSummaryResp | null>(null);
  const [ocrHealth, setOcrHealth] = useState<{ ok: boolean; provider: string; detail?: string } | null>(null);
  const [communities, setCommunities] = useState<Array<{ id: number; name: string }>>([]);

  const [meterRows, setMeterRows] = useState<MeterRow[]>([]);
  const [meterTotal, setMeterTotal] = useState(0);
  const [meterPage, setMeterPage] = useState(1);
  const [meterLoading, setMeterLoading] = useState(false);
  const [meterKeyword, setMeterKeyword] = useState('');
  const [meterType, setMeterType] = useState<string>('');
  const [meterDue, setMeterDue] = useState(false);

  const [readings, setReadings] = useState<MeterReadingRow[]>([]);
  const [readingTotal, setReadingTotal] = useState(0);
  const [readingPage, setReadingPage] = useState(1);
  const [readingLoading, setReadingLoading] = useState(false);
  const [readingKeyword, setReadingKeyword] = useState('');
  const [readingType, setReadingType] = useState<string>('');
  const [readingAnomalyOnly, setReadingAnomalyOnly] = useState(false);
  const [readingRange, setReadingRange] = useState<[Dayjs, Dayjs]>([dayjs().startOf('month'), dayjs()]);

  const [charges, setCharges] = useState<MeterChargeRow[]>([]);
  const [chargeTotal, setChargeTotal] = useState(0);
  const [chargePage, setChargePage] = useState(1);
  const [chargeLoading, setChargeLoading] = useState(false);
  const [chargeStatus, setChargeStatus] = useState<string>('');
  const [chargeKeyword, setChargeKeyword] = useState('');
  const [chargeType, setChargeType] = useState<string>('');
  const [chargeTotals, setChargeTotals] = useState({ receivable: 0, paid: 0, outstanding: 0 });
  const [samples, setSamples] = useState<OcrSampleRow[]>([]);
  const [sampleTotal, setSampleTotal] = useState(0);
  const [samplePage, setSamplePage] = useState(1);
  const [sampleLoading, setSampleLoading] = useState(false);
  const [sampleStatus, setSampleStatus] = useState<OcrSampleStatus | ''>('candidate');
  const [sampleType, setSampleType] = useState<string>('');
  const [sampleKeyword, setSampleKeyword] = useState('');
  const [samplePreview, setSamplePreview] = useState<OcrSampleRow | null>(null);

  const [meterModal, setMeterModal] = useState<{ open: boolean; row?: MeterRow }>({ open: false });
  const [meterForm] = Form.useForm<MeterFormValues>();
  const [savingMeter, setSavingMeter] = useState(false);

  const [review, setReview] = useState<MeterReadingRow | null>(null);
  const [reviewValue, setReviewValue] = useState<number | null>(null);
  const [reviewNote, setReviewNote] = useState('');
  const [reviewBusy, setReviewBusy] = useState(false);

  const [detail, setDetail] = useState<MeterDetailResp | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const [payTarget, setPayTarget] = useState<MeterChargeRow | null>(null);
  const [payForm] = Form.useForm<{ amount: number; method: string; receiptNo?: string; note?: string }>();
  const [payBusy, setPayBusy] = useState(false);

  const [adjustTarget, setAdjustTarget] = useState<MeterChargeRow | null>(null);
  const [adjustForm] = Form.useForm<{ adjustment: number; note?: string }>();
  const [adjustBusy, setAdjustBusy] = useState(false);

  const [qr, setQr] = useState<{
    dataUrl: string;
    payload: string;
    meterNo: string;
    wxaCodeDataUrl: string;
    wxaCodeEnv: string;
    wxaCodeError: string;
  } | null>(null);

  const communityOptions = useMemo(
    () => communities.map((item) => ({ value: item.id, label: item.name })),
    [communities],
  );

  const loadSummary = useCallback(async (target: Dayjs) => {
    try {
      setSummary(await meters.summary(target.format('YYYY-MM')));
    } catch (e) {
      message.error(e instanceof Error ? e.message : '读取抄表汇总失败');
    }
  }, [message]);

  const loadMeters = useCallback(async (page: number) => {
    setMeterLoading(true);
    try {
      const data = await meters.list({
        keyword: meterKeyword || undefined,
        meterType: (meterType || undefined) as MeterType | undefined,
        due: meterDue,
        page,
        pageSize: 30,
      });
      setMeterRows(data.rows);
      setMeterTotal(data.total);
      setMeterPage(data.page);
    } catch (e) {
      message.error(e instanceof Error ? e.message : '读取仪表档案失败');
    } finally {
      setMeterLoading(false);
    }
  }, [meterKeyword, meterType, meterDue, message]);

  const loadReadings = useCallback(async (page: number) => {
    setReadingLoading(true);
    try {
      const data = await meters.readings({
        keyword: readingKeyword || undefined,
        meterType: (readingType || undefined) as MeterType | undefined,
        anomalyOnly: readingAnomalyOnly,
        dateFrom: readingRange[0].format('YYYY-MM-DD'),
        dateTo: readingRange[1].format('YYYY-MM-DD'),
        page,
        pageSize: 30,
      });
      setReadings(data.rows);
      setReadingTotal(data.total);
      setReadingPage(data.page);
    } catch (e) {
      message.error(e instanceof Error ? e.message : '读取抄表记录失败');
    } finally {
      setReadingLoading(false);
    }
  }, [readingKeyword, readingType, readingAnomalyOnly, readingRange, message]);

  const loadCharges = useCallback(async (page: number) => {
    setChargeLoading(true);
    try {
      const data = await meters.charges({
        keyword: chargeKeyword || undefined,
        meterType: (chargeType || undefined) as MeterType | undefined,
        status: (chargeStatus || undefined) as ChargeStatus | undefined,
        period: period.format('YYYY-MM'),
        page,
        pageSize: 30,
      });
      setCharges(data.rows);
      setChargeTotal(data.total);
      setChargePage(data.page);
      setChargeTotals(data.totals);
    } catch (e) {
      message.error(e instanceof Error ? e.message : '读取账单失败');
    } finally {
      setChargeLoading(false);
    }
  }, [chargeKeyword, chargeType, chargeStatus, period, message]);

  const loadSamples = useCallback(async (page: number) => {
    setSampleLoading(true);
    try {
      const data = await meters.ocrSamples({
        status: sampleStatus || undefined,
        meterType: (sampleType || undefined) as MeterType | undefined,
        keyword: sampleKeyword || undefined,
        page,
        pageSize: 30,
      });
      setSamples(data.rows);
      setSampleTotal(data.total);
      setSamplePage(data.page);
    } catch (e) {
      message.error(e instanceof Error ? e.message : '读取纠错样本失败');
    } finally {
      setSampleLoading(false);
    }
  }, [sampleStatus, sampleType, sampleKeyword, message]);

  const loadOcrHealth = useCallback(async () => {    try {
      setOcrHealth(await meters.ocrHealth());
    } catch (e) {
      setOcrHealth({ ok: false, provider: 'none', detail: e instanceof Error ? e.message : '连接失败' });
    }
  }, []);

  useEffect(() => {
    void loadOcrHealth();
    addressApi.communities()
      .then((list) => setCommunities(list.map((item) => ({ id: item.id, name: item.name }))))
      .catch(() => setCommunities([]));
  }, [loadOcrHealth]);

  useEffect(() => { void loadSummary(period); }, [period, loadSummary]);
  useEffect(() => { void loadMeters(1); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [meterKeyword, meterType, meterDue]);
  useEffect(() => { void loadReadings(1); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [readingKeyword, readingType, readingAnomalyOnly, readingRange]);
  useEffect(() => { void loadCharges(1); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [chargeKeyword, chargeType, chargeStatus, period]);
  useEffect(() => {
    if (tab === 'learning') void loadSamples(1);
    /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, [tab, sampleStatus, sampleType, sampleKeyword]);

  const refreshAll = async () => {
    await Promise.all([loadSummary(period), loadMeters(meterPage), loadReadings(readingPage), loadCharges(chargePage)]);
  };

  const openCreate = () => {
    meterForm.resetFields();
    meterForm.setFieldsValue({
      meterType: 'water',
      integerDigits: 5,
      decimalDigits: 0,
      unit: 'm³',
      multiplier: 1,
      billingEnabled: true,
      status: 'active',
    });
    setMeterModal({ open: true });
  };

  const openEdit = (row: MeterRow) => {
    meterForm.setFieldsValue({
      meterNo: row.meterNo,
      meterType: row.meterType,
      name: row.name,
      spec: row.spec,
      manufacturer: row.manufacturer,
      model: row.model,
      multiplier: row.multiplier,
      integerDigits: row.integerDigits,
      decimalDigits: row.decimalDigits,
      unit: row.unit,
      communityId: row.communityId ?? undefined,
      installAddress: row.installAddress,
      latitude: row.latitude ?? undefined,
      longitude: row.longitude ?? undefined,
      ownerName: row.ownerName,
      ownerPhone: row.ownerPhone,
      unitPriceYuan: row.unitPriceYuan,
      billingEnabled: row.billingEnabled,
      initialReading: row.initialReading === null ? undefined : Number(row.initialReading),
      initialReadingAt: row.initialReadingAt ? dayjs(row.initialReadingAt) : undefined,
      status: row.status,
      remark: row.remark,
      photoUrls: row.photoUrl ? [row.photoUrl] : [],
    });
    setMeterModal({ open: true, row });
  };

  const submitMeter = async () => {
    const values = await meterForm.validateFields().catch(() => null);
    if (!values) return;
    setSavingMeter(true);
    try {
      const payload: MeterInput = {
        meterNo: values.meterNo.trim(),
        meterType: values.meterType,
        name: values.name,
        spec: values.spec,
        manufacturer: values.manufacturer,
        model: values.model,
        multiplier: values.multiplier,
        integerDigits: values.integerDigits,
        decimalDigits: values.decimalDigits,
        unit: values.unit,
        communityId: values.communityId,
        installAddress: values.installAddress,
        latitude: values.latitude,
        longitude: values.longitude,
        ownerName: values.ownerName,
        ownerPhone: values.ownerPhone,
        unitPriceCents: Math.round((values.unitPriceYuan || 0) * 100),
        billingEnabled: values.billingEnabled,
        initialReading: values.initialReading,
        initialReadingAt: values.initialReadingAt?.toISOString(),
        status: values.status,
        remark: values.remark,
        photoUrl: values.photoUrls?.[0],
      };
      if (meterModal.row) {
        await meters.update(meterModal.row.id, payload);
        message.success('仪表档案已更新');
      } else {
        await meters.create(payload);
        message.success('仪表已建档');
      }
      setMeterModal({ open: false });
      await refreshAll();
    } catch (e) {
      if (e instanceof Error && e.message) message.error(e.message);
    } finally {
      setSavingMeter(false);
    }
  };

  const removeMeter = async (row: MeterRow) => {
    try {
      await meters.remove(row.id);
      message.success('已删除');
      await refreshAll();
    } catch (e) {
      message.error(e instanceof Error ? e.message : '删除失败');
    }
  };

  const openDetail = async (row: MeterRow) => {
    setDetailLoading(true);
    setDetail(null);
    try {
      setDetail(await meters.detail(row.id));
    } catch (e) {
      message.error(e instanceof Error ? e.message : '读取详情失败');
    } finally {
      setDetailLoading(false);
    }
  };

  const openQr = async (row: MeterRow) => {
    try {
      setQr(await meters.qr(row.id));
    } catch (e) {
      message.error(e instanceof Error ? e.message : '生成二维码失败');
    }
  };

  const openReview = (row: MeterReadingRow) => {
    setReview(row);
    setReviewValue(row.readingValue);
    setReviewNote(row.reviewNote || '');
  };

  const saveReview = async () => {
    if (!review || reviewValue === null) {
      message.warning('请填写核对后的读数');
      return;
    }
    setReviewBusy(true);
    try {
      if (review.status === 'pending') {
        await meters.reviewReading(review.id, { readingValue: reviewValue, reviewNote });
        message.success('复核通过，账单已自动生成');
      } else {
        await meters.updateReading(review.id, { readingValue: reviewValue, reviewNote });
        message.success('读数已更新');
      }
      setReview(null);
      await refreshAll();
    } catch (e) {
      message.error(e instanceof Error ? e.message : '保存失败');
    } finally {
      setReviewBusy(false);
    }
  };

  const voidReading = async () => {
    if (!review) return;
    setReviewBusy(true);
    try {
      await meters.updateReading(review.id, { status: 'void', reviewNote });
      message.success('记录已作废');
      setReview(null);
      await refreshAll();
    } catch (e) {
      message.error(e instanceof Error ? e.message : '作废失败');
    } finally {
      setReviewBusy(false);
    }
  };

  const locate = () => {
    if (!navigator.geolocation) {
      message.error('当前浏览器不支持定位');
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (position) => {
        const [lng, lat] = wgs84ToGcj02(position.coords.longitude, position.coords.latitude);
        meterForm.setFieldsValue({ longitude: Number(lng.toFixed(7)), latitude: Number(lat.toFixed(7)) });
        message.success('已填入当前位置（已转 GCJ-02）');
      },
      (error) => message.error(`定位失败：${error.message || '请检查浏览器定位权限'}`),
      { enableHighAccuracy: true, timeout: 10000 },
    );
  };

  const openMap = (row: MeterRow) => {
    if (row.latitude === null || row.longitude === null) return;
    const name = encodeURIComponent(row.name || row.meterNo);
    window.open(
      `https://uri.amap.com/marker?position=${row.longitude},${row.latitude}&name=${name}&src=pms&coordinate=gaode&callnative=0`,
      '_blank',
      'noopener',
    );
  };

  const openPay = (row: MeterChargeRow) => {
    payForm.setFieldsValue({
      amount: Number((row.outstandingCents / 100).toFixed(2)),
      method: row.paymentMethod || 'cash',
      receiptNo: row.receiptNo,
      note: '',
    });
    setPayTarget(row);
  };

  const submitPay = async () => {
    if (!payTarget) return;
    const values = await payForm.validateFields().catch(() => null);
    if (!values) return;
    setPayBusy(true);
    try {
      await meters.payCharge(payTarget.id, {
        amountCents: Math.round(values.amount * 100),
        method: values.method,
        receiptNo: values.receiptNo,
        note: values.note,
      });
      message.success('收款已登记');
      setPayTarget(null);
      await Promise.all([loadCharges(chargePage), loadSummary(period)]);
    } catch (e) {
      message.error(e instanceof Error ? e.message : '登记收款失败');
    } finally {
      setPayBusy(false);
    }
  };

  const openAdjust = (row: MeterChargeRow) => {
    adjustForm.setFieldsValue({ adjustment: 0, note: '' });
    setAdjustTarget(row);
  };

  const submitAdjust = async () => {
    if (!adjustTarget) return;
    const values = await adjustForm.validateFields().catch(() => null);
    if (!values) return;
    setAdjustBusy(true);
    try {
      await meters.adjustCharge(adjustTarget.id, {
        adjustmentCents: Math.round(values.adjustment * 100),
        note: values.note,
      });
      message.success('应收已调整');
      setAdjustTarget(null);
      await Promise.all([loadCharges(chargePage), loadSummary(period)]);
    } catch (e) {
      message.error(e instanceof Error ? e.message : '调整失败');
    } finally {
      setAdjustBusy(false);
    }
  };

  const voidCharge = async (row: MeterChargeRow) => {
    try {
      await meters.voidCharge(row.id);
      message.success('账单已作废');
      await Promise.all([loadCharges(chargePage), loadSummary(period)]);
    } catch (e) {
      message.error(e instanceof Error ? e.message : '作废失败');
    }
  };

  const exportCharges = async () => {
    try {
      const data = await meters.charges({
        keyword: chargeKeyword || undefined,
        meterType: (chargeType || undefined) as MeterType | undefined,
        status: (chargeStatus || undefined) as ChargeStatus | undefined,
        period: period.format('YYYY-MM'),
        page: 1,
        pageSize: 500,
      });
      if (data.total > data.rows.length) {
        message.warning(`本月共 ${data.total} 条，先导出前 500 条；请加筛选条件缩小范围`);
      }
      await exportXlsx(`抄表账单_${period.format('YYYY-MM')}`, [{
        name: '账单',
        columns: [
          { title: '账期', key: 'period', width: 10 },
          { title: '表号', key: 'meterNo', width: 18 },
          { title: '类型', key: 'typeLabel', width: 8 },
          { title: '名称', key: 'meterName', width: 20 },
          { title: '使用人', key: 'ownerName', width: 12 },
          { title: '用量', key: 'usage', width: 10 },
          { title: '单位', key: 'unit', width: 8 },
          { title: '单价(元)', key: 'price', width: 10 },
          { title: '应收(元)', key: 'receivable', width: 10 },
          { title: '已收(元)', key: 'paid', width: 10 },
          { title: '待收(元)', key: 'outstanding', width: 10 },
          { title: '状态', key: 'statusLabel', width: 10 },
          { title: '收款时间', key: 'paidAt', width: 18 },
          { title: '票据号', key: 'receiptNo', width: 16 },
          { title: '备注', key: 'note', width: 24 },
        ],
        rows: data.rows.map((row) => ({
          period: row.period,
          meterNo: row.meterNo,
          typeLabel: TYPE_LABEL[row.meterType] || row.meterType,
          meterName: row.meterName,
          ownerName: row.ownerName,
          usage: row.usageValue,
          unit: row.unit,
          price: row.unitPriceCents / 100,
          receivable: row.receivableCents / 100,
          paid: row.paidCents / 100,
          outstanding: row.outstandingCents / 100,
          statusLabel: CHARGE_STATUS[row.status]?.label || row.status,
          paidAt: timeText(row.paidAt),
          receiptNo: row.receiptNo,
          note: row.note,
        })),
      }]);
    } catch (e) {
      message.error(e instanceof Error ? e.message : '导出失败');
    }
  };

  const meterColumns: ColumnsType<MeterRow> = [
    {
      title: '表号 / 类型',
      dataIndex: 'meterNo',
      width: 190,
      render: (_: unknown, row) => (
        <div className="meter-no-cell">
          <button className="meter-link" onClick={() => void openDetail(row)}>{row.meterNo}</button>
          <TypeTag type={row.meterType} />
        </div>
      ),
    },
    {
      title: '名称 / 安装地点',
      dataIndex: 'name',
      render: (_: unknown, row) => (
        <div>
          <div>{row.name || '未命名'}</div>
          <Text type="secondary" className="meter-sub">{row.installAddress || '未填写安装地点'}</Text>
        </div>
      ),
    },
    { title: '小区', dataIndex: 'communityName', width: 120, render: (value: string) => value || '—' },
    {
      title: '使用人',
      dataIndex: 'ownerName',
      width: 150,
      render: (_: unknown, row) => (
        <div>
          <div>{row.ownerName || '—'}</div>
          <Text type="secondary" className="meter-sub">{row.ownerPhone || ''}</Text>
        </div>
      ),
    },
    {
      title: '上次读数',
      dataIndex: 'lastReadingValueText',
      width: 150,
      render: (_: unknown, row) => (
        <div>
          <span className="meter-reading">{row.lastReadingValueText || '—'}</span>
          <span className="meter-unit">{row.unit}</span>
          <div><Text type="secondary" className="meter-sub">{timeText(row.lastReadingAt)}</Text></div>
        </div>
      ),
    },
    {
      title: '未收',
      dataIndex: 'unpaidCents',
      width: 100,
      render: (value: number) => (value > 0 ? <span className="meter-money">{money(value)}</span> : <Text type="secondary">0.00</Text>),
    },
    {
      title: '状态',
      dataIndex: 'status',
      width: 80,
      render: (value: string) => (value === 'active' ? <Tag color="green">启用</Tag> : <Tag>停用</Tag>),
    },
    {
      title: '操作',
      key: 'actions',
      width: 210,
      fixed: 'right',
      render: (_: unknown, row) => (
        <Space size={4} wrap>
          <Button size="small" icon={<QrcodeOutlined />} onClick={() => void openQr(row)}>码</Button>
          <Button size="small" icon={<EnvironmentOutlined />} onClick={() => openMap(row)} disabled={row.latitude === null}>导航</Button>
          {canEdit && <Button size="small" icon={<EditOutlined />} onClick={() => openEdit(row)}>编辑</Button>}
          {canDelete && (
            <Popconfirm title="删除这块表？" description="有抄表记录的表不能删，请改成停用。" onConfirm={() => void removeMeter(row)}>
              <Button size="small" danger icon={<DeleteOutlined />} />
            </Popconfirm>
          )}
        </Space>
      ),
    },
  ];

  const readingColumns: ColumnsType<MeterReadingRow> = [
    { title: '抄表时间', dataIndex: 'readAt', width: 150, render: (value: string) => timeText(value) },
    {
      title: '表 / 地点',
      dataIndex: 'meterNo',
      width: 200,
      render: (_: unknown, row) => (
        <div>
          <div className="meter-inline"><span className="meter-reading">{row.meterNo}</span><TypeTag type={row.meterType} /></div>
          <Text type="secondary" className="meter-sub">{row.meterName || ''}</Text>
        </div>
      ),
    },
    {
      title: '本次读数',
      dataIndex: 'readingValueText',
      width: 130,
      render: (value: string, row) => (
        <div>
          <span className="meter-reading">{value}</span><span className="meter-unit">{row.unit}</span>
          <div><Text type="secondary" className="meter-sub">上次 {row.previousValue === null ? '—' : row.previousValue}</Text></div>
        </div>
      ),
    },
    {
      title: '用量',
      dataIndex: 'usageValue',
      width: 100,
      render: (value: number | null, row) => (value === null ? <Text type="secondary">首次</Text> : `${value} ${row.unit}`),
    },
    {
      title: '金额',
      dataIndex: 'receivableCents',
      width: 120,
      render: (value: number | null, row) => (
        value === null ? <Text type="secondary">未计费</Text> : (
          <div>
            <span className="meter-money">{money(value)}</span>
            {row.chargeStatus && <div><ChargeTag status={row.chargeStatus} /></div>}
          </div>
        )
      ),
    },
    {
      title: '识别',
      dataIndex: 'ocrConfidence',
      width: 160,
      render: (_: unknown, row) => (
        <div>
          <Tag color={Number(row.ocrConfidence) >= 75 ? 'green' : 'orange'}>{confidenceText(row.ocrConfidence)}</Tag>
          <Text type="secondary" className="meter-sub">
            {row.ocrProvider === 'sidecar' ? '本地 OCR' : row.ocrProvider === 'llm' ? '大模型' : '人工'}
          </Text>
          {row.anomalyLabels?.length > 0 && (
            <div className="meter-anomalies">
              {row.anomalyLabels.slice(0, 3).map((label) => <Tag key={label} color="red">{label}</Tag>)}
            </div>
          )}
        </div>
      ),
    },
    { title: '抄表人', dataIndex: 'operatorName', width: 100, render: (value: string) => value || '—' },
    {
      title: '原图',
      dataIndex: 'photoUrl',
      width: 80,
      render: (value: string) => (value
        ? <Image src={imageSrc(value)} width={56} height={56} style={{ objectFit: 'cover', borderRadius: 6 }} />
        : <Text type="secondary">无</Text>),
    },
    {
      title: '状态',
      dataIndex: 'status',
      width: 80,
      render: (value: string) =>
        value === 'pending' ? <Tag color="orange">待复核</Tag> : value === 'confirmed' ? <Tag color="green">已确认</Tag> : <Tag>已作废</Tag>,
    },
    {
      title: '操作',
      key: 'actions',
      width: 100,
      fixed: 'right',
      render: (_: unknown, row) => <Button size="small" onClick={() => openReview(row)}>{canEdit ? '复核' : '查看'}</Button>,
    },
  ];

  const chargeColumns: ColumnsType<MeterChargeRow> = [
    { title: '账期', dataIndex: 'period', width: 90 },
    {
      title: '表 / 使用人',
      dataIndex: 'meterNo',
      width: 200,
      render: (_: unknown, row) => (
        <div>
          <div className="meter-inline"><span className="meter-reading">{row.meterNo}</span><TypeTag type={row.meterType} /></div>
          <Text type="secondary" className="meter-sub">{row.meterName}{row.ownerName ? ` · ${row.ownerName}` : ''}</Text>
        </div>
      ),
    },
    { title: '用量', dataIndex: 'usageValue', width: 100, render: (value: number, row) => `${value} ${row.unit}` },
    { title: '单价', dataIndex: 'unitPriceCents', width: 90, render: (value: number) => `¥${money(value)}` },
    { title: '应收', dataIndex: 'receivableCents', width: 100, render: (value: number) => <span className="meter-money">{money(value)}</span> },
    { title: '已收', dataIndex: 'paidCents', width: 100, render: (value: number) => money(value) },
    {
      title: '待收',
      dataIndex: 'outstandingCents',
      width: 100,
      render: (value: number) => (value > 0 ? <span className="meter-money">{money(value)}</span> : '0.00'),
    },
    { title: '状态', dataIndex: 'status', width: 100, render: (value: string) => <ChargeTag status={value} /> },
    { title: '收款时间', dataIndex: 'paidAt', width: 150, render: (value: string) => timeText(value) },
    {
      title: '操作',
      key: 'actions',
      width: 200,
      fixed: 'right',
      render: (_: unknown, row) => (
        <Space size={4} wrap>
          {canEdit && row.status !== 'paid' && row.status !== 'void' && <Button size="small" type="primary" onClick={() => openPay(row)}>收款</Button>}
          {canEdit && row.status !== 'paid' && row.status !== 'void' && <Button size="small" onClick={() => openAdjust(row)}>调整</Button>}
          {canEdit && row.paidCents === 0 && row.status !== 'void' && (
            <Popconfirm title="作废这张账单？" description="作废后不再计入欠费，抄表记录仍保留。" onConfirm={() => void voidCharge(row)}>
              <Button size="small" danger>作废</Button>
            </Popconfirm>
          )}
        </Space>
      ),
    },
  ];

  const SAMPLE_STATUS: Record<OcrSampleStatus, { label: string; color: string }> = {
    candidate: { label: '待确认', color: 'orange' },
    training: { label: '进训练集', color: 'blue' },
    trained: { label: '已训练', color: 'green' },
    excluded: { label: '已排除', color: 'default' },
  };

  const changeSampleStatus = async (row: OcrSampleRow, status: OcrSampleStatus) => {
    try {
      const updated = await meters.updateOcrSample(row.id, { status });
      setSamples((list) => list.map((item) => (item.id === row.id ? updated : item)));
      message.success(`已标记为「${SAMPLE_STATUS[status].label}」`);
    } catch (e) {
      message.error(e instanceof Error ? e.message : '更新样本状态失败');
    }
  };

  const exportSamples = () => {
    if (!samples.length) {
      message.info('当前页没有样本');
      return;
    }
    const header = ['id', '表号', '表名', '类型', '整数位', '小数位', '预测值', '纠正值', '置信度', '旋转角', '状态', '纠正时间', '原图'];
    const lines = samples.map((row) => [
      row.id,
      row.meterNo,
      row.meterName,
      TYPE_LABEL[row.meterType] || row.meterType,
      row.integerDigits,
      row.decimalDigits,
      row.predictedValue ?? '',
      row.correctedValue ?? '',
      row.confidence ?? '',
      `${row.orientation}°`,
      SAMPLE_STATUS[row.status]?.label || row.status,
      row.correctedAt || '',
      row.photoUrl,
    ]);
    const csv = `\uFEFF${[header, ...lines].map((line) => line.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(',')).join('\n')}`;
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `meter-ocr-samples-${dayjs().format('YYYYMMDD-HHmm')}.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const sampleColumns: ColumnsType<OcrSampleRow> = [
    {
      title: '原图',
      dataIndex: 'photoUrl',
      width: 74,
      render: (value: string, row) => (
        value ? <Image src={imageSrc(value)} width={52} height={52} style={{ objectFit: 'cover', borderRadius: 6, cursor: 'pointer' }} preview={false} onClick={() => setSamplePreview(row)} /> : <Text type="secondary">无</Text>
      ),
    },
    {
      title: '表 / 地点',
      key: 'meter',
      width: 180,
      render: (_: unknown, row) => (
        <div>
          <div>{row.meterNo} · {row.meterName || '—'}</div>
          <Text type="secondary" style={{ fontSize: 12 }}>{TYPE_LABEL[row.meterType] || row.meterType} · {row.integerDigits}+{row.decimalDigits} 位</Text>
        </div>
      ),
    },
    {
      title: '预测 → 纠正',
      key: 'values',
      width: 190,
      render: (_: unknown, row) => (
        <Space size={6}>
          <Text delete type="secondary">{row.predictedValue ?? '—'}</Text>
          <span>→</span>
          <Text strong>{row.correctedValue ?? '—'}</Text>
        </Space>
      ),
    },
    { title: '置信度', dataIndex: 'confidence', width: 82, render: (value: string | null) => (value ? `${Number(value).toFixed(0)}%` : '—') },
    { title: '方向', dataIndex: 'orientation', width: 64, render: (value: number) => `${value}°` },
    { title: '状态', dataIndex: 'status', width: 96, render: (value: OcrSampleStatus) => <Tag color={SAMPLE_STATUS[value]?.color}>{SAMPLE_STATUS[value]?.label || value}</Tag> },
    { title: '纠正时间', dataIndex: 'correctedAt', width: 150, render: (value: string) => timeText(value) },
    {
      title: '操作',
      key: 'actions',
      width: 220,
      fixed: 'right',
      render: (_: unknown, row) => (
        <Space size={4} wrap>
          <Button size="small" onClick={() => setSamplePreview(row)}>查看</Button>
          {canEdit && row.status === 'candidate' && (
            <>
              <Button size="small" type="primary" onClick={() => void changeSampleStatus(row, 'training')}>加入训练</Button>
              <Button size="small" onClick={() => void changeSampleStatus(row, 'excluded')}>排除</Button>
            </>
          )}
          {canEdit && row.status !== 'candidate' && (
            <Button size="small" onClick={() => void changeSampleStatus(row, 'candidate')}>移回候选</Button>
          )}
        </Space>
      ),
    },
  ];

  return (
    <div className="meter-page">
      <div className="meter-toolbar">
        <Space>
          <DatePicker picker="month" value={period} onChange={(value) => value && setPeriod(value)} allowClear={false} />
          <Button icon={<ReloadOutlined />} onClick={() => void refreshAll()}>刷新</Button>
          {canEdit && <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>新增仪表</Button>}
        </Space>
      </div>

      {ocrHealth && !ocrHealth.ok && (
        <Alert
          type="warning"
          showIcon
          message="读数字识别服务未连接"
          description={`${ocrHealth.detail || '请检查 METER_OCR_URL'}。抄表仍可手工输入读数并保留原图，不影响记账。`}
          action={<Button size="small" onClick={() => void loadOcrHealth()}>重试</Button>}
        />
      )}

      <div className="meter-stats">
        <Card size="small"><Statistic title="仪表总数" value={summary?.meters.total ?? 0} suffix="块" /></Card>
        <Card size="small"><Statistic title={`${period.format('M')} 月已抄`} value={summary?.readings.meters_read ?? 0} suffix={`/ ${summary?.meters.active ?? 0} 块`} /></Card>
        <Card size="small"><Statistic title="本月未抄" value={summary?.meters.due ?? 0} suffix="块" valueStyle={{ color: (summary?.meters.due ?? 0) > 0 ? '#cf1322' : undefined }} /></Card>
        <Card size="small"><Statistic title="本月应收" value={money(summary?.charges.receivable)} prefix="¥" /></Card>
        <Card size="small"><Statistic title="本月已收" value={money(summary?.charges.paid)} prefix="¥" valueStyle={{ color: '#389e0d' }} /></Card>
        <Card size="small"><Statistic title="本月待收" value={money(summary?.charges.outstanding)} prefix="¥" valueStyle={{ color: '#cf1322' }} /></Card>
      </div>

      <Card className="meter-body" styles={{ body: { paddingTop: 8 } }}>
        <Tabs
          activeKey={tab}
          onChange={setTab}
          items={[
            {
              key: 'records',
              label: `抄表记录${readingTotal ? ` (${readingTotal})` : ''}`,
              children: (
                <div>
                  <div className="meter-filters">
                    <RangePicker
                      value={readingRange}
                      allowClear={false}
                      onChange={(value) => value && value[0] && value[1] && setReadingRange([value[0], value[1]])}
                    />
                    <Select placeholder="全部类型" allowClear style={{ width: 120 }} value={readingType || undefined} onChange={(value) => setReadingType(value || '')} options={TYPE_OPTIONS} />
                    <Select
                      style={{ width: 140 }}
                      value={readingAnomalyOnly ? 'anomaly' : 'all'}
                      onChange={(value) => setReadingAnomalyOnly(value === 'anomaly')}
                      options={[{ value: 'all', label: '全部记录' }, { value: 'anomaly', label: '只看异常' }]}
                    />
                    <Input allowClear prefix={<SearchOutlined />} placeholder="表号 / 名称 / 地点 / 抄表人" value={readingKeyword} onChange={(e) => setReadingKeyword(e.target.value)} style={{ width: 260 }} />
                  </div>
                  <Table
                    rowKey="id"
                    size="middle"
                    loading={readingLoading}
                    columns={readingColumns}
                    dataSource={readings}
                    scroll={{ x: 1280 }}
                    pagination={{ current: readingPage, pageSize: 30, total: readingTotal, showSizeChanger: false, onChange: (page) => void loadReadings(page) }}
                  />
                </div>
              ),
            },
            {
              key: 'meters',
              label: `仪表档案 (${meterTotal})`,
              children: (
                <div>
                  <div className="meter-filters">
                    <Input allowClear prefix={<SearchOutlined />} placeholder="表号 / 名称 / 地点 / 使用人 / 电话" value={meterKeyword} onChange={(e) => setMeterKeyword(e.target.value)} style={{ width: 300 }} />
                    <Select placeholder="全部类型" allowClear style={{ width: 120 }} value={meterType || undefined} onChange={(value) => setMeterType(value || '')} options={TYPE_OPTIONS} />
                    <Button type={meterDue ? 'primary' : 'default'} onClick={() => setMeterDue((value) => !value)}>本月未抄</Button>
                  </div>
                  <Table
                    rowKey="id"
                    size="middle"
                    loading={meterLoading}
                    columns={meterColumns}
                    dataSource={meterRows}
                    scroll={{ x: 1180 }}
                    pagination={{ current: meterPage, pageSize: 30, total: meterTotal, showSizeChanger: false, onChange: (page) => void loadMeters(page) }}
                  />
                </div>
              ),
            },
            {
              key: 'charges',
              label: `账单记账 (${chargeTotal})`,
              children: (
                <div>
                  <div className="meter-filters meter-filters--between">
                    <div className="meter-filters">
                      <Input allowClear prefix={<SearchOutlined />} placeholder="表号 / 使用人 / 名称 / 票据号" value={chargeKeyword} onChange={(e) => setChargeKeyword(e.target.value)} style={{ width: 260 }} />
                      <Select placeholder="全部类型" allowClear style={{ width: 120 }} value={chargeType || undefined} onChange={(value) => setChargeType(value || '')} options={TYPE_OPTIONS} />
                      <Select placeholder="全部状态" allowClear style={{ width: 130 }} value={chargeStatus || undefined} onChange={(value) => setChargeStatus(value || '')} options={Object.entries(CHARGE_STATUS).map(([value, meta]) => ({ value, label: meta.label }))} />
                    </div>
                    <Space>
                      <Text type="secondary">共 {chargeTotal} 条</Text>
                      <Button icon={<DownloadOutlined />} onClick={() => void exportCharges()}>导出 Excel</Button>
                    </Space>
                  </div>
                  <div className="meter-charge-totals">
                    <span>应收 <b>¥{money(chargeTotals.receivable)}</b></span>
                    <span>已收 <b className="is-ok">¥{money(chargeTotals.paid)}</b></span>
                    <span>待收 <b className="is-warn">¥{money(chargeTotals.outstanding)}</b></span>
                  </div>
                  <Table
                    rowKey="id"
                    size="middle"
                    loading={chargeLoading}
                    columns={chargeColumns}
                    dataSource={charges}
                    scroll={{ x: 1200 }}
                    pagination={{ current: chargePage, pageSize: 30, total: chargeTotal, showSizeChanger: false, onChange: (page) => void loadCharges(page) }}
                  />
                </div>
              ),
            },
            {
              key: 'learning',
              label: `识别自学习${sampleTotal ? ` (${sampleTotal})` : ''}`,
              children: (
                <div>
                  <Alert
                    type="info"
                    showIcon
                    style={{ marginBottom: 12 }}
                    message="人工改过的读数会自动进这里，原图和纠错值永久保留；先标记「加入训练」，不会立刻改线上模型。"
                  />
                  <div className="meter-filters meter-filters--between">
                    <div className="meter-filters">
                      <Select
                        style={{ width: 130 }}
                        value={sampleStatus || 'all'}
                        onChange={(value) => setSampleStatus(value === 'all' ? '' : (value as OcrSampleStatus))}
                        options={[{ value: 'all', label: '全部状态' }, ...Object.entries(SAMPLE_STATUS).map(([value, meta]) => ({ value, label: meta.label }))]}
                      />
                      <Select placeholder="全部类型" allowClear style={{ width: 120 }} value={sampleType || undefined} onChange={(value) => setSampleType(value || '')} options={TYPE_OPTIONS} />
                      <Input allowClear prefix={<SearchOutlined />} placeholder="表号 / 表名 / 地点" value={sampleKeyword} onChange={(e) => setSampleKeyword(e.target.value)} style={{ width: 240 }} />
                    </div>
                    <Space>
                      <Text type="secondary">共 {sampleTotal} 条</Text>
                      <Button icon={<DownloadOutlined />} onClick={exportSamples}>导出当前页</Button>
                    </Space>
                  </div>
                  <Table
                    rowKey="id"
                    size="middle"
                    loading={sampleLoading}
                    columns={sampleColumns}
                    dataSource={samples}
                    scroll={{ x: 1180 }}
                    pagination={{ current: samplePage, pageSize: 30, total: sampleTotal, showSizeChanger: false, onChange: (page) => void loadSamples(page) }}
                  />
                </div>
              ),
            },
          ]}
        />
      </Card>

      <Modal
        open={meterModal.open}
        title={meterModal.row ? `编辑仪表 · ${meterModal.row.meterNo}` : '新增仪表'}
        width={880}
        onCancel={() => setMeterModal({ open: false })}
        onOk={() => void submitMeter()}
        confirmLoading={savingMeter}
        okText="保存"
        forceRender
      >
        <Form form={meterForm} layout="vertical" className="meter-form">
          <Alert
            type="info"
            showIcon
            style={{ marginBottom: 16 }}
            message="整数位/小数位必须按表盘填：电表常见 6 位整数 + 2 位小数，机械水表常见 5 位整数。填错会让读数差 10 倍，例如 022418.88 会被算成 2241.888。"
          />
          <div className="meter-form-section">基本信息</div>
          <Row gutter={16}>
            <Col span={8}><Form.Item name="meterNo" label="表号" rules={[{ required: true, message: '请填表身钢印号/条码号' }]}><Input placeholder="表壳上的编号" maxLength={64} /></Form.Item></Col>
            <Col span={8}>
              <Form.Item name="meterType" label="表类型" rules={[{ required: true }]}>
                <Select options={TYPE_OPTIONS} onChange={(value: MeterType) => meterForm.setFieldsValue({ unit: TYPE_UNIT[value] })} />
              </Form.Item>
            </Col>
            <Col span={8}><Form.Item name="name" label="名称"><Input placeholder="如 301室电表、1号楼总表" maxLength={120} /></Form.Item></Col>
            <Col span={8}><Form.Item name="spec" label="口径 / 规格"><Input placeholder="DN20 / 3×220/380V 1.5(6)A" /></Form.Item></Col>
            <Col span={8}><Form.Item name="manufacturer" label="厂家"><Input /></Form.Item></Col>
            <Col span={8}><Form.Item name="model" label="型号"><Input /></Form.Item></Col>
            <Col span={6}><Form.Item name="multiplier" label="倍率" tooltip="经互感器的电表、大口径水表读数要乘这个系数"><InputNumber min={0.001} max={100000} precision={3} style={{ width: '100%' }} /></Form.Item></Col>
            <Col span={6}><Form.Item name="integerDigits" label="整数位"><InputNumber min={1} max={10} precision={0} style={{ width: '100%' }} /></Form.Item></Col>
            <Col span={6}><Form.Item name="decimalDigits" label="小数位" tooltip="电表液晶屏通常 6 位整数 + 2 位小数"><InputNumber min={0} max={4} precision={0} style={{ width: '100%' }} /></Form.Item></Col>
            <Col span={6}><Form.Item name="unit" label="计量单位"><Input placeholder="m³ / kWh" /></Form.Item></Col>
          </Row>

          <div className="meter-form-section">位置与使用人</div>
          <Row gutter={16}>
            <Col span={8}><Form.Item name="communityId" label="所属小区"><Select allowClear showSearch optionFilterProp="label" options={communityOptions} placeholder="选择小区" /></Form.Item></Col>
            <Col span={16}><Form.Item name="installAddress" label="安装地点"><Input placeholder="如 3号楼1单元水表井 / 负一层电表箱3号柜" maxLength={255} /></Form.Item></Col>
            <Col span={8}><Form.Item name="ownerName" label="使用人"><Input /></Form.Item></Col>
            <Col span={8}><Form.Item name="ownerPhone" label="使用人电话"><Input /></Form.Item></Col>
            <Col span={8}>
              <Form.Item label="现场定位">
                <Button block icon={<EnvironmentOutlined />} onClick={locate}>用当前位置填充经纬度</Button>
              </Form.Item>
            </Col>
            <Col span={24}>
              <Form.Item
                label="经纬度（GCJ-02）"
                tooltip="微信/高德使用 GCJ-02；后台浏览器定位已自动转换。也可从高德坐标拾取器复制"
                extra="不填也能抄表；填了后台可直接导航到表位"
              >
                <Space.Compact style={{ width: '100%' }}>
                  <Form.Item name="longitude" noStyle><InputNumber placeholder="经度，如 121.3921" precision={7} style={{ width: '50%' }} /></Form.Item>
                  <Form.Item name="latitude" noStyle><InputNumber placeholder="纬度，如 31.0865" precision={7} style={{ width: '50%' }} /></Form.Item>
                </Space.Compact>
              </Form.Item>
            </Col>
          </Row>

          <div className="meter-form-section">计费</div>
          <Row gutter={16}>
            <Col span={6}><Form.Item name="unitPriceYuan" label="单价（元 / 单位）"><InputNumber min={0} max={10000} precision={2} style={{ width: '100%' }} suffix="元" /></Form.Item></Col>
            <Col span={6}><Form.Item name="billingEnabled" label="自动生成应收" valuePropName="checked" tooltip="关掉后仍可抄表留痕，只是不生成账单"><Switch checkedChildren="生成" unCheckedChildren="只抄表" /></Form.Item></Col>
            <Col span={6}><Form.Item name="initialReading" label="期初底数" tooltip="第一次抄表用它算用量；没填则第一次只记录读数"><InputNumber min={0} precision={3} style={{ width: '100%' }} /></Form.Item></Col>
            <Col span={6}><Form.Item name="initialReadingAt" label="期初日期"><DatePicker style={{ width: '100%' }} /></Form.Item></Col>
          </Row>

          <div className="meter-form-section">其他</div>
          <Row gutter={16}>
            <Col span={8}><Form.Item name="status" label="状态"><Select options={[{ value: 'active', label: '启用' }, { value: 'disabled', label: '停用（保留历史）' }]} /></Form.Item></Col>
            <Col span={16}><Form.Item name="remark" label="备注"><Input.TextArea rows={2} maxLength={2000} /></Form.Item></Col>
            <Col span={24}>
              <Form.Item name="photoUrls" label="表具照片" extra="支持点击、拖拽、Ctrl+V 粘贴；建议拍清表号、铭牌和读数窗口">
                <MaterialPhotosUpload max={1} />
              </Form.Item>
            </Col>
          </Row>
        </Form>
      </Modal>

      <Drawer
        open={!!review}
        width={860}
        title={review ? `复核抄表 · ${review.meterNo}` : '复核抄表'}
        onClose={() => setReview(null)}
        extra={review ? (review.chargeStatus ? <ChargeTag status={review.chargeStatus} /> : <Tag>未计费</Tag>) : null}
      >
        {review && (
          <div className="meter-review">
            <div className="meter-review-photo">
              {review.photoUrl
                ? (
                  <div className="meter-review-frame">
                    <Image src={imageSrc(review.photoUrl)} style={{ width: '100%', borderRadius: 8 }} />
                    {review.roi && (
                      <span
                        className="meter-roi"
                        style={{
                          left: `${review.roi.x * 100}%`,
                          top: `${review.roi.y * 100}%`,
                          width: `${review.roi.w * 100}%`,
                          height: `${review.roi.h * 100}%`,
                        }}
                      />
                    )}
                  </div>
                )
                : <div className="meter-review-no-photo">这条记录没有原图（人工补录）</div>}
              <div className="meter-review-hint">
                原图永久保留，用于事后核对。红框是抄表员框选的识别区域；识别结果只是草稿，账以确认读数为准。
              </div>
            </div>
            <div className="meter-review-side">
              <div className="meter-review-reading">
                <div className="meter-review-reading__label">核对后的读数</div>
                <div className="meter-review-reading__value">
                  {reviewValue === null ? review.readingValueText : reviewValue}
                  <span>{review.unit}</span>
                </div>
                <div className="meter-review-reading__meta">
                  <Tag color={review.status === 'pending' ? 'orange' : 'green'}>
                    {review.status === 'pending' ? '待复核' : '已确认'}
                  </Tag>
                  <span>{review.meterNo} · {timeText(review.readAt)}</span>
                </div>
              </div>
              <Descriptions size="small" column={1} bordered styles={{ label: { width: 92, whiteSpace: 'nowrap' } }}>
                <Descriptions.Item label="表 / 地点">{review.meterNo} · {review.meterName || '—'}</Descriptions.Item>
                <Descriptions.Item label="抄表时间">{timeText(review.readAt)}</Descriptions.Item>
                <Descriptions.Item label="抄表人">{review.operatorName || '—'}</Descriptions.Item>
                <Descriptions.Item label="上次读数">{review.previousValue === null ? '—' : review.previousValue}</Descriptions.Item>
                <Descriptions.Item label="用量">{review.usageValue === null ? '首次抄表' : `${review.usageValue} ${review.unit}`}</Descriptions.Item>
                <Descriptions.Item label="识别">
                  {confidenceText(review.ocrConfidence)} · {review.ocrProvider === 'sidecar' ? '本地 OCR' : review.ocrProvider === 'llm' ? '大模型' : '人工/无'}
                  {review.ocrMeterNo ? ` · 识别表号 ${review.ocrMeterNo}` : ''}
                  {review.orientation ? ` · 自动旋转 ${review.orientation}°` : ''}
                </Descriptions.Item>
                <Descriptions.Item label="GPS">
                  {review.latitude === null || review.longitude === null ? '未记录' : `${review.longitude}, ${review.latitude}（±${review.gpsAccuracy || '?'}m）`}
                </Descriptions.Item>
                <Descriptions.Item label="异常">
                  {review.anomalyLabels?.length ? review.anomalyLabels.map((label) => <Tag key={label} color="red">{label}</Tag>) : '无'}
                </Descriptions.Item>
                <Descriptions.Item label="账单">
                  {review.receivableCents === null ? '未生成' : `应收 ¥${money(review.receivableCents)} / 已收 ¥${money(review.paidCents)}`}
                </Descriptions.Item>
                <Descriptions.Item label="备注">{review.note || '—'}</Descriptions.Item>
              </Descriptions>

              {review.ocrText && (
                <details className="meter-ocr-text">
                  <summary>OCR 原文（排障用）</summary>
                  <pre>{review.ocrText}</pre>
                </details>
              )}

              {canEdit && review.status !== 'void' && (
                <div className="meter-review-edit">
                  <div className="meter-review-label">核对后的读数</div>
                  <InputNumber value={reviewValue} onChange={setReviewValue} precision={3} min={0} style={{ width: '100%' }} suffix={review.unit} disabled={review.chargeStatus === 'paid'} />
                  <div className="meter-review-label">复核备注</div>
                  <Input.TextArea rows={3} value={reviewNote} onChange={(e) => setReviewNote(e.target.value)} placeholder="改数原因、现场情况" />
                  <Space className="meter-review-actions">
                    <Button type="primary" loading={reviewBusy} onClick={() => void saveReview()} disabled={review.chargeStatus === 'paid'}>保存</Button>
                    <Popconfirm title="作废这条抄表记录？" description="只能作废最近一次抄表；账单会一并作废。" onConfirm={() => void voidReading()}>
                      <Button danger loading={reviewBusy}>作废记录</Button>
                    </Popconfirm>
                  </Space>
                  {review.chargeStatus === 'paid' && <Alert type="info" showIcon message="这张账单已收款，修正读数前请先处理收款。" />}
                </div>
              )}
            </div>
          </div>
        )}
      </Drawer>

      <Drawer
        open={!!samplePreview}
        width={760}
        title={samplePreview ? `识别纠错样本 · ${samplePreview.meterNo}` : '识别纠错样本'}
        onClose={() => setSamplePreview(null)}
      >
        {samplePreview && (
          <div className="meter-review">
            <div className="meter-review-photo">
              {samplePreview.photoUrl ? (
                <div className="meter-review-frame">
                  <Image src={imageSrc(samplePreview.photoUrl)} style={{ width: '100%', borderRadius: 8 }} />
                  {samplePreview.roi && (
                    <span
                      className="meter-roi"
                      style={{
                        left: `${samplePreview.roi.x * 100}%`,
                        top: `${samplePreview.roi.y * 100}%`,
                        width: `${samplePreview.roi.w * 100}%`,
                        height: `${samplePreview.roi.h * 100}%`,
                      }}
                    />
                  )}
                </div>
              ) : <div className="meter-review-no-photo">没有原图</div>}
              <div className="meter-review-hint">原图与纠正值永久保留；这条样本不会自动改线上模型，需在训练流程里显式使用。</div>
            </div>
            <div className="meter-review-side">
              <Descriptions size="small" column={1} bordered>
                <Descriptions.Item label="表 / 地点">{samplePreview.meterNo} · {samplePreview.meterName || '—'}</Descriptions.Item>
                <Descriptions.Item label="位数">{samplePreview.integerDigits} 位整数 + {samplePreview.decimalDigits} 位小数</Descriptions.Item>
                <Descriptions.Item label="预测 → 纠正">
                  <Text delete type="secondary">{samplePreview.predictedValue ?? '—'}</Text>
                  {' → '}
                  <Text strong>{samplePreview.correctedValue ?? '—'}</Text>
                </Descriptions.Item>
                <Descriptions.Item label="置信度 / 方向">{samplePreview.confidence ?? '—'}% / {samplePreview.orientation}°</Descriptions.Item>
                <Descriptions.Item label="状态"><Tag color={SAMPLE_STATUS[samplePreview.status]?.color}>{SAMPLE_STATUS[samplePreview.status]?.label || samplePreview.status}</Tag></Descriptions.Item>
                <Descriptions.Item label="纠正时间">{timeText(samplePreview.correctedAt)}</Descriptions.Item>
              </Descriptions>
              <div className="meter-detail-section">OCR 原文</div>
              <pre className="meter-ocr-raw">{samplePreview.ocrText || '—'}</pre>
            </div>
          </div>
        )}
      </Drawer>

      <Drawer
        open={!!detail || detailLoading}
        width={760}
        title={detail ? `仪表详情 · ${detail.meter.meterNo}` : '仪表详情'}
        onClose={() => { setDetail(null); setDetailLoading(false); }}
      >
        {detailLoading && <div className="meter-detail-loading">加载中…</div>}
        {detail && (
          <div className="meter-detail">
            <div className="meter-detail-head">
              <div>
                <TypeTag type={detail.meter.meterType} />
                <span className="meter-detail-no">{detail.meter.meterNo}</span>
                {detail.meter.status === 'active' ? <Tag color="green">启用</Tag> : <Tag>停用</Tag>}
              </div>
              <Space>
                <Button icon={<QrcodeOutlined />} onClick={() => void openQr(detail.meter)}>表二维码</Button>
                <Button icon={<EnvironmentOutlined />} onClick={() => openMap(detail.meter)} disabled={detail.meter.latitude === null}>导航</Button>
                {canEdit && <Button icon={<EditOutlined />} onClick={() => { setDetail(null); openEdit(detail.meter); }}>编辑</Button>}
              </Space>
            </div>
            {detail.meter.photoUrl && <Image src={imageSrc(detail.meter.photoUrl)} width={160} style={{ borderRadius: 8, objectFit: 'cover' }} />}
            <Descriptions size="small" column={2} bordered className="meter-detail-desc">
              <Descriptions.Item label="名称">{detail.meter.name || '—'}</Descriptions.Item>
              <Descriptions.Item label="小区">{detail.meter.communityName || '—'}</Descriptions.Item>
              <Descriptions.Item label="安装地点" span={2}>{detail.meter.installAddress || '—'}</Descriptions.Item>
              <Descriptions.Item label="使用人">{detail.meter.ownerName || '—'}</Descriptions.Item>
              <Descriptions.Item label="电话">{detail.meter.ownerPhone || '—'}</Descriptions.Item>
              <Descriptions.Item label="单价">¥{money(detail.meter.unitPriceCents)} / {detail.meter.unit}</Descriptions.Item>
              <Descriptions.Item label="倍率">{detail.meter.multiplier}</Descriptions.Item>
              <Descriptions.Item label="位数">{detail.meter.integerDigits} 位整数 + {detail.meter.decimalDigits} 位小数</Descriptions.Item>
              <Descriptions.Item label="上次读数">{detail.meter.lastReadingValueText || '—'} {detail.meter.unit}</Descriptions.Item>
              <Descriptions.Item label="经纬度" span={2}>{detail.meter.latitude === null ? '未记录' : `${detail.meter.longitude}, ${detail.meter.latitude}`}</Descriptions.Item>
              <Descriptions.Item label="备注" span={2}>{detail.meter.remark || '—'}</Descriptions.Item>
            </Descriptions>
            <div className="meter-detail-stats">
              <span>累计已抄 <b>{detail.stats.readingCount}</b> 次</span>
              <span>本年用量 <b>{detail.stats.yearUsage}</b> {detail.meter.unit}</span>
              <span>未收 <b className="is-warn">¥{money(detail.stats.unpaidCents)}</b></span>
            </div>
            <h3>最近抄表</h3>
            <Table
              rowKey="id"
              size="small"
              pagination={false}
              dataSource={detail.readings}
              columns={[
                { title: '时间', dataIndex: 'readAt', width: 140, render: (value: string) => timeText(value) },
                { title: '读数', dataIndex: 'readingValueText', width: 100 },
                { title: '用量', dataIndex: 'usageValue', width: 90, render: (value: number | null) => (value === null ? '首次' : value) },
                { title: '状态', dataIndex: 'status', width: 80, render: (value: string) => (value === 'pending' ? '待复核' : value === 'confirmed' ? '已确认' : '已作废') },
                { title: '原图', dataIndex: 'photoUrl', width: 70, render: (value: string) => (value ? <Image src={imageSrc(value)} width={38} height={38} style={{ objectFit: 'cover' }} /> : '—') },
              ]}
            />
          </div>
        )}
      </Drawer>

      <Modal
        open={!!payTarget}
        title={payTarget ? `登记收款 · ${payTarget.meterNo} · ${payTarget.period}` : '登记收款'}
        onCancel={() => setPayTarget(null)}
        onOk={() => void submitPay()}
        confirmLoading={payBusy}
        okText="确认收款"
        forceRender
      >
        {payTarget && (
          <Form form={payForm} layout="vertical">
            <Alert type="info" showIcon message={`应收 ¥${money(payTarget.receivableCents)}，已收 ¥${money(payTarget.paidCents)}，待收 ¥${money(payTarget.outstandingCents)}`} />
            <Form.Item name="amount" label="本次收款（元）" rules={[{ required: true, message: '请填收款金额' }]}>
              <InputNumber min={0.01} max={payTarget.outstandingCents / 100} precision={2} style={{ width: '100%' }} suffix="元" />
            </Form.Item>
            <Form.Item name="method" label="收款方式" rules={[{ required: true }]}><Select options={PAY_METHODS} /></Form.Item>
            <Form.Item name="receiptNo" label="票据号"><Input maxLength={60} placeholder="可空" /></Form.Item>
            <Form.Item name="note" label="备注"><Input.TextArea rows={2} maxLength={500} /></Form.Item>
          </Form>
        )}
      </Modal>

      <Modal
        open={!!adjustTarget}
        title={adjustTarget ? `调整应收 · ${adjustTarget.meterNo} · ${adjustTarget.period}` : '调整应收'}
        onCancel={() => setAdjustTarget(null)}
        onOk={() => void submitAdjust()}
        confirmLoading={adjustBusy}
        okText="保存"
        forceRender
      >
        {adjustTarget && (
          <Form form={adjustForm} layout="vertical">
            <Alert type="info" showIcon message={`当前应收 ¥${money(adjustTarget.receivableCents)}；调整金额填负数表示减免。`} />
            <Form.Item name="adjustment" label="调整金额（元）" rules={[{ required: true }]}><InputNumber precision={2} style={{ width: '100%' }} suffix="元" /></Form.Item>
            <Form.Item name="note" label="调整原因" rules={[{ required: true, message: '请写清减免/补收原因' }]}><Input.TextArea rows={2} maxLength={500} /></Form.Item>
          </Form>
        )}
      </Modal>

      <Modal
        open={!!qr}
        title={qr ? `表二维码 · ${qr.meterNo}` : '表二维码'}
        footer={<Button onClick={() => setQr(null)}>关闭</Button>}
        onCancel={() => setQr(null)}
        width={420}
      >
        {qr && (
          <div className="meter-qr">
            <img src={qr.wxaCodeDataUrl || qr.dataUrl} alt={`表 ${qr.meterNo} 二维码`} />
            {qr.wxaCodeDataUrl ? (
              <p>
                微信扫一扫直接打开员工端，进入这块表的抄表页；授权过的员工登录后即可拍照。
                {qr.wxaCodeEnv === 'trial' ? ' 当前生成的是体验版码，只有体验成员能扫；正式发布后重新生成正式码。' : ''}
              </p>
            ) : (
              <p>当前是普通二维码，需要员工端「抄表 → 扫码」识别；微信直接扫不会进小程序。</p>
            )}
            {qr.wxaCodeError && !qr.wxaCodeDataUrl && (
              <Alert type="warning" showIcon message={`小程序码生成失败：${qr.wxaCodeError}`} />
            )}
            <Text code>{qr.payload}</Text>
            <Button
              icon={<DownloadOutlined />}
              onClick={() => {
                const link = document.createElement('a');
                link.href = qr.wxaCodeDataUrl || qr.dataUrl;
                const ext = qr.wxaCodeDataUrl.startsWith('data:image/jpeg') ? 'jpg' : 'png';
                link.download = `表码-${qr.meterNo}.${ext}`;
                link.click();
              }}
            >
              下载二维码
            </Button>
          </div>
        )}
      </Modal>
    </div>
  );
}
