import {
  App as AntdApp,
  Alert,
  Button,
  Card,
  Col,
  Divider,
  Drawer,
  Form,
  Input,
  InputNumber,
  Image,
  Modal,
  Popconfirm,
  Row,
  Select,
  Space,
  Statistic,
  Steps,
  Switch,
  Table,
  Tabs,
  Tag,
  Tooltip,
  Typography,
  Upload,
} from 'antd';
import type { UploadProps } from 'antd/es/upload/interface';
import {
  AppstoreOutlined,
  AuditOutlined,
  ColumnWidthOutlined,
  EditOutlined,
  InboxOutlined,
  PlusOutlined,
  ReloadOutlined,
  ShoppingCartOutlined,
  SwapOutlined,
  UnorderedListOutlined,
  UploadOutlined,
} from '@ant-design/icons';
import { useEffect, useMemo, useState } from 'react';
import UnitSelect from '../components/UnitSelect';
import { useTableColumnPrefs, type PrefsColumn } from '../components/tableColumnPrefs';
import { formatDateTimeCn } from '@pms/shared-types';
import type { MaterialCategoryView } from '@pms/shared-types';
import type { StockLotView, StockMovementView } from '@pms/shared-types';
import { request } from '../lib/api';
import { auth, useAuth, useCompanyWideView, usePagePerm } from '../lib/auth';
import { useTableSeq } from '../components/tableSeqColumn';
import { nameOr, unknown } from '../lib/displayName';
import { compressImageFile } from '../lib/compressImage';
import {
  MATERIAL_PHOTO_LIMIT,
  MaterialPhotoCell,
  MaterialPhotosUpload,
  imageSrc,
  materialPhotoList,
  normalizePhotoUrl,
  uploadFileUrl,
} from '../components/MaterialPhotos';
import { searchableExtraWideSelectProps, searchableWideSelectProps, withOptionTitles } from '../lib/selectProps';
import { PurchaseOrderStatus, PurchaseRequestStatus, WAREHOUSE_TYPE_LABELS, WarehouseType } from '@pms/shared-types';

const { Title, Text } = Typography;
const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || '/api/v1';

interface MaterialRow {
  id: number;
  code: string;
  name: string;
  spec?: string | null;
  category?: string | null;
  unit: string;
  defaultCostCents: number;
  photoUrl?: string | null;
  photoUrls?: string[];
  enabled: boolean;
  createdAt?: string;
}

interface UploadResponse {
  publicUrl: string;
  displayUrl?: string;
  objectKey?: string;
  bucket?: string;
}

interface WarehouseRow {
  id: number;
  name: string;
  type: WarehouseType;
  communityId?: number | null;
  communityName?: string | null;
  /** 所属管理处；空 = 公司级。人员按管理处匹配仓库的依据 */
  officeId?: number | null;
  /**
   * 管理处名字由 /warehouses 直接给。别再用 access.offices 去查 ——
   * 那是「本人可切换的管理处」，新建管理处后不重登就查不到，档案页会显示成「#5」
   */
  officeName?: string | null;
  /** 默认入库库位：入库、调拨入库的表单带出它 */
  defaultLocationId?: number | null;
  enabled: boolean;
}

interface SupplierRow {
  id: number;
  name: string;
  contactName?: string | null;
  contactPhone?: string | null;
  address?: string | null;
  rating?: number | null;
  note?: string | null;
  enabled: boolean;
}

interface StockRow {
  id: number;
  warehouseId: number;
  materialId: number;
  qty: number | string;
  safetyQty: number | string;
  /** 下面几项由 GET /stocks 按剩余批次算好：有批次按批次加权，没有退回 SKU 参考成本 */
  lotQty?: number;
  lotValueCents?: number;
  unitCostCents?: number;
  costSource?: 'lot' | 'default';
  amountCents?: number;
  /** 当前存放库位，最近一次入库写入；空 = 该仓没配库位 */
  locationLabel?: string | null;
}

interface PurchaseRequestItem {
  materialId?: number;
  name: string;
  qty: number;
  estUnitCostCents?: number;
}

interface PurchaseRequestRow {
  /** 名字/单号由服务端随行下发（见 InventoryService.withRequestNames），端上不再自己查 */
  applicantName?: string | null;
  managerName?: string | null;
  purchaserName?: string | null;
  workOrderNo?: string | null;
  id: number;
  requestNo: string;
  workOrderId?: number | null;
  applicantId: number;
  items: PurchaseRequestItem[];
  estTotalCents: number;
  status: PurchaseRequestStatus;
  managerId?: number | null;
  managerAt?: string | null;
  purchaserId?: number | null;
  purchaserAt?: string | null;
  rejectReason?: string | null;
  createdAt?: string;
}

interface PurchaseOrderItem {
  materialId: number;
  qty: number;
  unitCostCents: number;
}

interface PurchaseOrderRow {
  /** 关联采购申请的单号，服务端下发；界面上不显示申请的 id */
  requestNo?: string | null;
  id: number;
  orderNo: string;
  requestId?: number | null;
  supplierId: number;
  items: PurchaseOrderItem[];
  totalCents: number;
  status: PurchaseOrderStatus;
  createdAt?: string;
}

interface TransferOrderItem {
  materialId: number;
  qty: number;
  receivedQty?: number;
}

interface TransferOrderRow {
  id: number;
  transferNo: string;
  fromWarehouseId: number;
  toWarehouseId: number;
  items: TransferOrderItem[];
  status: 'pending_review' | 'approved' | 'received' | 'rejected' | string;
  approvedAt?: string | null;
  shippedAt?: string | null;
  receivedAt?: string | null;
  rejectReason?: string | null;
  note?: string | null;
  createdAt?: string;
}

interface WarehouseLocationRow {
  id: number;
  warehouseId: number;
  zone?: string | null;
  shelf?: string | null;
  bin?: string | null;
  label: string;
  enabled: boolean;
}

type CatalogKind = 'material' | 'warehouse' | 'supplier';
type RequestFilterKey = 'all' | PurchaseRequestStatus;

const requestStatusMeta: Record<string, { label: string; color: string }> = {
  draft: { label: '草稿', color: 'default' },
  office_review: { label: '办公室汇总', color: 'purple' },
  manager_review: { label: '物业经理审批', color: 'gold' },
  purchaser_review: { label: '采购经理审批', color: 'blue' },
  approved: { label: '待下单', color: 'green' },
  rejected: { label: '已驳回', color: 'red' },
  merged: { label: '已合并', color: 'default' },
  done: { label: '已转采购单', color: 'default' },
};

const orderStatusMeta: Record<string, { label: string; color: string }> = {
  placed: { label: '已下单', color: 'blue' },
  partial: { label: '部分到货', color: 'orange' },
  received: { label: '已收货', color: 'green' },
  closed: { label: '已关闭', color: 'default' },
};

const transferStatusMeta: Record<string, { label: string; color: string }> = {
  pending_review: { label: '待经理审批', color: 'gold' },
  approved: { label: '待接收', color: 'blue' },
  received: { label: '已完成', color: 'green' },
  rejected: { label: '已驳回', color: 'red' },
  // 兼容历史数据
  created: { label: '待出库(旧)', color: 'default' },
  shipped: { label: '运输中(旧)', color: 'blue' },
};

const inventoryPageSizeOptions = ['30', '50', '100'];

/** 材料档案没填分类的，快筛里单独归一档，否则这些料点哪个分类都看不到 */
const UNCATEGORIZED = '未分类';

const requestFilterOrder: RequestFilterKey[] = [
  'all',
  PurchaseRequestStatus.OFFICE_REVIEW,
  PurchaseRequestStatus.MANAGER_REVIEW,
  PurchaseRequestStatus.PURCHASER_REVIEW,
  PurchaseRequestStatus.APPROVED,
  PurchaseRequestStatus.REJECTED,
  PurchaseRequestStatus.DONE,
];

function money(cents?: number | null) {
  return `¥${((cents || 0) / 100).toFixed(2)}`;
}

function numberQty(value: number | string | undefined | null) {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function quantityPrecision(unit?: string | null) {
  return ['米', '公斤', '升', '平方米', '立方米'].includes(unit || '') ? 2 : 0;
}

function materialDisplayName(material?: Pick<MaterialRow, 'name' | 'spec'> | null) {
  if (!material) return '';
  return material.spec ? `${material.name} ${material.spec}` : material.name;
}

/** 时间全站一种写法：2026/8/9 20:43 周日（见 shared-types 的 formatDateTimeCn） */
function formatDateTime(value?: string | null) {
  return formatDateTimeCn(value) || '-';
}

function requestStepCurrent(status: PurchaseRequestStatus) {
  if (status === PurchaseRequestStatus.OFFICE_REVIEW) return 0;
  if (status === PurchaseRequestStatus.MANAGER_REVIEW) return 1;
  if (status === PurchaseRequestStatus.PURCHASER_REVIEW) return 2;
  if (status === PurchaseRequestStatus.APPROVED) return 3;
  if (status === PurchaseRequestStatus.DONE) return 4;
  return 0;
}

function requestStepStatus(status: PurchaseRequestStatus): 'process' | 'error' {
  return status === PurchaseRequestStatus.REJECTED ? 'error' : 'process';
}

export default function InventoryPage() {
  const { message, modal } = AntdApp.useApp();
  const { canEdit, canDelete } = usePagePerm('inventory');
  const { access, actingOffice } = useAuth();
  // 「材料 SKU」「仓库数量」是全公司口径的家底数字，范围受限的角色看了对不上账
  const companyWide = useCompanyWideView();
  const [materials, setMaterials] = useState<MaterialRow[]>([]);
  const [warehouses, setWarehouses] = useState<WarehouseRow[]>([]);
  const [suppliers, setSuppliers] = useState<SupplierRow[]>([]);
  const [stocks, setStocks] = useState<StockRow[]>([]);
  const [purchaseRequests, setPurchaseRequests] = useState<PurchaseRequestRow[]>([]);
  const [purchaseOrders, setPurchaseOrders] = useState<PurchaseOrderRow[]>([]);
  const [transferOrders, setTransferOrders] = useState<TransferOrderRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [keyword, setKeyword] = useState('');
  const [stockCategory, setStockCategory] = useState<string>('all');
  /**
   * 仓库库存看哪个仓。'all' = 全部（本人看得见的那些合并）。
   * 默认落在自己所属管理处的仓上（见 defaultStockWarehouseId），
   * 选过一次之后就尊重用户的选择，不再被默认值改回去。
   */
  const [stockWarehouseId, setStockWarehouseId] = useState<number | 'all'>('all');
  const [stockWarehousePicked, setStockWarehousePicked] = useState(false);
  /**
   * 「本次请求看得见哪些仓」——和 GET /stocks 是同一口径（后端 visibleWarehouseIds）。
   * 下拉必须用它而不是全量仓库列表：全量里会混进选了就是空表的仓，
   * 看着像库存丢了（2026-09-01 反馈「总仓是空的」正是这一类）。
   */
  const [visibleWarehouses, setVisibleWarehouses] = useState<WarehouseRow[]>([]);
  const [catalogOpen, setCatalogOpen] = useState<CatalogKind | null>(null);
  const [editingMaterial, setEditingMaterial] = useState<MaterialRow | null>(null);
  const [editingWarehouse, setEditingWarehouse] = useState<WarehouseRow | null>(null);
  const [editingSupplier, setEditingSupplier] = useState<SupplierRow | null>(null);
  const [purchaseOrderOpen, setPurchaseOrderOpen] = useState(false);
  const [receiptOrder, setReceiptOrder] = useState<PurchaseOrderRow | null>(null);
  const [transferOpen, setTransferOpen] = useState(false);
  const [receiveTransferOpen, setReceiveTransferOpen] = useState(false);
  const [receivingTransfer, setReceivingTransfer] = useState<TransferOrderRow | null>(null);
  const [rejectTransferTarget, setRejectTransferTarget] = useState<TransferOrderRow | null>(null);
  const [rejectTarget, setRejectTarget] = useState<PurchaseRequestRow | null>(null);
  const [requestDetail, setRequestDetail] = useState<PurchaseRequestRow | null>(null);
  const [manualRequestOpen, setManualRequestOpen] = useState(false);
  const [selectedRequestKeys, setSelectedRequestKeys] = useState<number[]>([]);
  const [requestFilter, setRequestFilter] = useState<RequestFilterKey>('all');
  const [editingStock, setEditingStock] = useState<StockRow | null>(null);
  const [lotDrawerStock, setLotDrawerStock] = useState<StockRow | null>(null);
  const [warehouseLocations, setWarehouseLocations] = useState<WarehouseLocationRow[]>([]);
  /** 材料类别档案（后台可增删改）。新建/编辑 SKU 的下拉、分类快筛的排序都以它为准 */
  const [materialCategories, setMaterialCategories] = useState<MaterialCategoryView[]>([]);
  const [categoryModalOpen, setCategoryModalOpen] = useState(false);
  const [locationConfigWarehouse, setLocationConfigWarehouse] = useState<WarehouseRow | null>(null);
  const [generalReceiptOpen, setGeneralReceiptOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [catalogForm] = Form.useForm();
  const [purchaseOrderForm] = Form.useForm();
  const [receiptForm] = Form.useForm();
  const [generalReceiptForm] = Form.useForm();
  const [transferForm] = Form.useForm();
  const [receiveTransferForm] = Form.useForm();
  const [rejectTransferForm] = Form.useForm();
  const [rejectForm] = Form.useForm();
  const [manualRequestForm] = Form.useForm();
  const [stockForm] = Form.useForm();

  /** 新建/编辑 SKU 的类别下拉：只列启用中的（停用的选不到，但老材料照常显示） */
  const materialCategoryOptions = useMemo(
    () => materialCategories.filter((item) => item.enabled)
      .map((item) => ({ value: item.label, label: `${item.label}（${item.code}-）` })),
    [materialCategories],
  );
  /** 分类快筛的排列顺序按档案里的排序走 */
  const categoryOrder = useMemo(() => materialCategories.map((item) => item.label), [materialCategories]);

  const materialById = useMemo(() => new Map(materials.map((item) => [item.id, item])), [materials]);
  const warehouseById = useMemo(() => new Map(warehouses.map((item) => [item.id, item])), [warehouses]);
  const supplierById = useMemo(() => new Map(suppliers.map((item) => [item.id, item])), [suppliers]);
  const editingStockMaterial = editingStock ? materialById.get(editingStock.materialId) : undefined;
  const stockQtyPrecision = quantityPrecision(editingStockMaterial?.unit);

  const materialOptions = withOptionTitles(materials
    .filter((item) => item.enabled)
    .map((item) => ({
      value: item.id,
      label: `${item.code} · ${materialDisplayName(item)}`,
    })));
  const warehouseOptions = withOptionTitles(warehouses
    .filter((item) => item.enabled)
    .map((item) => ({
      value: item.id,
      label: `${item.name} · ${WAREHOUSE_TYPE_LABELS[item.type] || item.type}${item.officeName ? ' · ' + item.officeName : ''}`,
    })));
  const supplierOptions = withOptionTitles(suppliers
    .filter((item) => item.enabled)
    .map((item) => ({ value: item.id, label: item.name })));
  const locationOptionsByWarehouse = useMemo(() => {
    const map = new Map<number, Array<{ value: number; label: string }>>();
    warehouseLocations.filter((loc) => loc.enabled).forEach((loc) => {
      const list = map.get(loc.warehouseId) || [];
      list.push({ value: loc.id, label: loc.label });
      map.set(loc.warehouseId, list);
    });
    return map;
  }, [warehouseLocations]);

  /** 仓库 → 它配的默认入库库位，入库表单选了仓就带出来 */
  const defaultLocationByWarehouse = useMemo(
    () => new Map(warehouses.map((w) => [w.id, w.defaultLocationId ?? null])),
    [warehouses],
  );

  /** 调拨接收弹窗里可选的库位 = 接收仓自己的库位 */
  const receiveLocationOptions = useMemo(
    () => (receivingTransfer ? locationOptionsByWarehouse.get(receivingTransfer.toWarehouseId) ?? [] : []),
    [receivingTransfer, locationOptionsByWarehouse],
  );

  const loadAll = async () => {
    setLoading(true);
    try {
      const [
        materialRows,
        warehouseRows,
        visibleWarehouseRows,
        supplierRows,
        stockRows,
        requestRows,
        orderRows,
        transferRows,
        locationRows,
        categoryRows,
      ] = await Promise.all([
        request<MaterialRow[]>({ url: '/materials' }),
        request<WarehouseRow[]>({ url: '/warehouses' }),
        request<WarehouseRow[]>({ url: '/warehouses', query: { scope: 'visible' } }),
        request<SupplierRow[]>({ url: '/suppliers' }),
        request<StockRow[]>({ url: '/stocks' }),
        request<PurchaseRequestRow[]>({ url: '/purchase-requests' }),
        request<PurchaseOrderRow[]>({ url: '/purchase-orders' }),
        request<TransferOrderRow[]>({ url: '/transfer-orders' }),
        request<WarehouseLocationRow[]>({ url: '/warehouse-locations' }),
        request<MaterialCategoryView[]>({ url: '/material-categories' }),
      ]);
      setMaterials(materialRows);
      setWarehouses(warehouseRows);
      setVisibleWarehouses(visibleWarehouseRows);
      setSuppliers(supplierRows);
      setStocks(stockRows);
      setPurchaseRequests(requestRows);
      setPurchaseOrders(orderRows);
      setTransferOrders(transferRows);
      setWarehouseLocations(locationRows);
      setMaterialCategories(categoryRows);
    } catch (e: any) {
      message.error(e?.message || '加载库存采购数据失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadAll(); }, []);

  const stats = useMemo(() => {
    // 估值口径和报表页「库存清单」一致：接口已按剩余批次加权算好 amountCents，这里只求和
    const stockValue = stocks.reduce((sum, row) => sum + (row.amountCents ?? 0), 0);
    return {
      materials: materials.length,
      warehouses: warehouses.length,
      lowStock: stocks.filter((row) => numberQty(row.qty) <= numberQty(row.safetyQty)).length,
      pendingRequests: purchaseRequests.filter((row) =>
        [PurchaseRequestStatus.MANAGER_REVIEW, PurchaseRequestStatus.PURCHASER_REVIEW].includes(row.status),
      ).length,
      approvedRequests: purchaseRequests.filter((row) => row.status === PurchaseRequestStatus.APPROVED).length,
      placedOrders: purchaseOrders.filter((row) => row.status === PurchaseOrderStatus.PLACED).length,
      stockValue,
    };
  }, [materialById, materials.length, purchaseOrders, purchaseRequests, stocks, warehouses.length]);

  /**
   * 默认选哪个仓：**自己所属管理处的那个仓**。
   * 「自己所属」的判据和员工端小程序一致（见 inventory.ts 的 defaultWarehouseIndex）：
   *   · 顶栏切了管理处视角 → 那个管理处的仓
   *   · 没切、但本人只挂着一个管理处 → 那个管理处的仓
   *   · 其余（全公司范围又没切视角）→ 全部仓库，别替他挑一个
   * 有别的仓的权限时下拉里照样能切，切过就不再自动改回来。
   */
  const defaultStockWarehouseId = useMemo<number | 'all'>(() => {
    const officeId = actingOffice?.id
      ?? (access?.offices?.length === 1 ? access.offices[0].id : null);
    if (!officeId) return 'all';
    const own = visibleWarehouses.find((item) => item.enabled && item.officeId === officeId);
    return own?.id ?? 'all';
  }, [actingOffice, access, visibleWarehouses]);

  useEffect(() => {
    if (!stockWarehousePicked) setStockWarehouseId(defaultStockWarehouseId);
  }, [defaultStockWarehouseId, stockWarehousePicked]);

  /** 下拉选项：只列本人看得见的仓（口径同 GET /stocks），带上类型和管理处好区分同名仓 */
  const stockWarehouseOptions = useMemo(() => ([
    { value: 'all' as const, label: `全部仓库（${visibleWarehouses.length}）` },
    ...withOptionTitles(visibleWarehouses.map((item) => ({
      value: item.id,
      label: `${item.name} · ${WAREHOUSE_TYPE_LABELS[item.type] || item.type}${item.officeName ? ' · ' + item.officeName : ''}`,
    }))),
  ]), [visibleWarehouses]);

  /**
   * 一个总仓都看不见时说明原因，别让人对着空下拉猜。
   * 「能不能看总仓」就是角色的数据范围：管理处范围的人看到总仓库存也领不到，
   * 反而会当成自己的可用量。要放开去「业务角色」把数据范围改成全公司。
   */
  const centralHint = useMemo(() => {
    if (!visibleWarehouses.length) return '';
    if (visibleWarehouses.some((item) => item.type === WarehouseType.CENTRAL)) return '';
    return '你的角色数据范围限定在管理处，看不到公司总仓。需要的话去「业务角色」把数据范围改成全公司。';
  }, [visibleWarehouses]);

  const typedStocks = useMemo(
    () => (stockWarehouseId === 'all'
      ? stocks
      : stocks.filter((row) => row.warehouseId === stockWarehouseId)),
    [stocks, stockWarehouseId],
  );
  const keywordStocks = useMemo(() => typedStocks.filter((row) => {
    if (!keyword.trim()) return true;
    const material = materialById.get(row.materialId);
    const text = `${material?.code || ''} ${materialDisplayName(material)} ${warehouseById.get(row.warehouseId)?.name || ''}`;
    return text.toLowerCase().includes(keyword.toLowerCase());
  }), [typedStocks, keyword, materialById, warehouseById]);

  /* 分类快筛的条数口径：先按关键词过滤，再统计分类 ——
     和下面列表看到的是同一批数据，不会出现「角标 12 条、点进去 3 条」。
     没填分类的归到「未分类」，否则这些料在任何分类下都找不到。 */
  const stockCategoryCounts = useMemo(() => {
    const counts = new Map<string, number>();
    keywordStocks.forEach((row) => {
      const key = materialById.get(row.materialId)?.category || UNCATEGORIZED;
      counts.set(key, (counts.get(key) || 0) + 1);
    });
    return counts;
  }, [keywordStocks, materialById]);

  const stockCategoryItems = useMemo(() => {
    // 只列出当前有货的分类，按材料档案里的固定顺序排，「未分类」永远垫底
    const ordered = categoryOrder.filter((name) => stockCategoryCounts.has(name));
    if (stockCategoryCounts.has(UNCATEGORIZED)) ordered.push(UNCATEGORIZED);
    return [
      { key: 'all', label: `全部 ${keywordStocks.length}` },
      ...ordered.map((name) => ({ key: name, label: `${name} ${stockCategoryCounts.get(name) || 0}` })),
    ];
  }, [keywordStocks.length, stockCategoryCounts, categoryOrder]);

  /* 搜索之后当前分类可能已经一条都不剩（比如先点「五金」再搜「水管」），
     这时快筛没有一项高亮、列表却是空的，看着像坏了 —— 自动退回「全部」。 */
  useEffect(() => {
    if (stockCategory !== 'all' && !stockCategoryCounts.has(stockCategory)) setStockCategory('all');
  }, [stockCategory, stockCategoryCounts]);

  const filteredStocks = stockCategory === 'all'
    ? keywordStocks
    : keywordStocks.filter((row) => (materialById.get(row.materialId)?.category || UNCATEGORIZED) === stockCategory);

  // 序号跟着分页连续（第 2 页从 51 起），不是页内下标
  const stockSeq = useTableSeq<StockRow>(filteredStocks.length, {
    defaultPageSize: 50,
    pageSizeOptions: inventoryPageSizeOptions,
  });
  const materialSeq = useTableSeq<MaterialRow>(materials.length, {
    defaultPageSize: 50,
    pageSizeOptions: inventoryPageSizeOptions,
  });

  const requestCounts = useMemo(() => {
    const counts = new Map<RequestFilterKey, number>([['all', purchaseRequests.length]]);
    purchaseRequests.forEach((row) => {
      counts.set(row.status, (counts.get(row.status) || 0) + 1);
    });
    return counts;
  }, [purchaseRequests]);

  const filteredPurchaseRequests = requestFilter === 'all'
    ? purchaseRequests
    : purchaseRequests.filter((row) => row.status === requestFilter);

  const requestFilterItems = requestFilterOrder.map((key) => ({
    key,
    label: key === 'all'
      ? `全部 ${requestCounts.get('all') || 0}`
      : `${requestStatusMeta[key]?.label || key} ${requestCounts.get(key) || 0}`,
  }));

  const openCreateMaterial = () => {
    setEditingMaterial(null);
    catalogForm.resetFields();
    catalogForm.setFieldsValue({ unit: '个', enabled: true, photoUrls: [], photoUploading: false });
    setCatalogOpen('material');
  };

  const openEditMaterial = (row: MaterialRow) => {
    setEditingMaterial(row);
    catalogForm.resetFields();
    catalogForm.setFieldsValue({
      name: row.name,
      spec: row.spec || undefined,
      category: row.category,
      unit: row.unit,
      defaultCostYuan: row.defaultCostCents / 100,
      photoUrls: materialPhotoList(row),
      photoUploading: false,
      enabled: row.enabled,
    });
    setCatalogOpen('material');
  };

  const openCreateWarehouse = () => {
    setEditingWarehouse(null);
    catalogForm.resetFields();
    catalogForm.setFieldsValue({ type: WarehouseType.CENTRAL, enabled: true });
    setCatalogOpen('warehouse');
  };

  const openEditWarehouse = (row: WarehouseRow) => {
    setEditingWarehouse(row);
    catalogForm.resetFields();
    catalogForm.setFieldsValue({
      name: row.name,
      type: row.type,
      communityId: row.communityId || undefined,
      officeId: row.officeId || undefined,
      defaultLocationId: row.defaultLocationId || undefined,
      enabled: row.enabled,
    });
    setCatalogOpen('warehouse');
  };

  const openCreateSupplier = () => {
    setEditingSupplier(null);
    catalogForm.resetFields();
    setCatalogOpen('supplier');
  };

  const openEditSupplier = (row: SupplierRow) => {
    setEditingSupplier(row);
    catalogForm.resetFields();
    catalogForm.setFieldsValue({
      name: row.name,
      contactName: row.contactName || undefined,
      contactPhone: row.contactPhone || undefined,
      address: row.address || undefined,
      rating: row.rating || undefined,
      note: row.note || undefined,
      enabled: row.enabled,
    });
    setCatalogOpen('supplier');
  };

  const closeCatalog = () => {
    setCatalogOpen(null);
    setEditingMaterial(null);
    setEditingWarehouse(null);
    setEditingSupplier(null);
  };

  const openEditStock = (row: StockRow) => {
    setEditingStock(row);
    stockForm.resetFields();
    stockForm.setFieldsValue({
      qty: numberQty(row.qty),
      safetyQty: numberQty(row.safetyQty),
      unitCostYuan: (materialById.get(row.materialId)?.defaultCostCents || 0) / 100,
      note: '',
    });
  };

  const submitCatalog = async (values: any) => {
    if (!catalogOpen) return;
    if (catalogOpen === 'material' && values.photoUploading) {
      message.warning('照片还在上传，请稍后再保存');
      return;
    }
    setSaving(true);
    try {
      const path = catalogOpen === 'material'
        ? '/materials'
        : catalogOpen === 'warehouse'
          ? '/warehouses'
          : '/suppliers';
      const data = catalogOpen === 'material'
        ? {
            ...values,
            defaultCostCents: values.defaultCostYuan != null ? Math.round(values.defaultCostYuan * 100) : 0,
            photoUrls: (values.photoUrls || []).map((url: string) => normalizePhotoUrl(url)),
          }
        : catalogOpen === 'warehouse'
          // 下拉清空是 undefined，接口里 undefined = 不动，得明确传 null 才能清成公司级
          ? { ...values, officeId: values.officeId ?? null, defaultLocationId: values.defaultLocationId ?? null }
          : values;
      delete data.defaultCostYuan;
      delete data.photoUploading;
      const editingId = catalogOpen === 'material'
        ? editingMaterial?.id
        : catalogOpen === 'warehouse'
          ? editingWarehouse?.id
          : editingSupplier?.id;
      await request({
        method: editingId ? 'PATCH' : 'POST',
        url: editingId ? `${path}/${editingId}` : path,
        data,
      });
      message.success('基础资料已保存');
      catalogForm.resetFields();
      closeCatalog();
      await loadAll();
    } catch (e: any) {
      message.error(e?.message || '保存失败');
    } finally {
      setSaving(false);
    }
  };

  const submitStock = async () => {
    if (!editingStock) return;
    const values = await stockForm.validateFields();
    setSaving(true);
    try {
      await request({
        method: 'PATCH',
        url: `/stocks/${editingStock.id}`,
        data: {
          qty: values.qty,
          safetyQty: values.safetyQty,
          // 盘盈才需要单价（新批次按它入账）；盘亏按先进先出扣批次，后端会忽略
          unitCostCents: numberQty(values.qty) > numberQty(editingStock.qty) && values.unitCostYuan != null
            ? Math.round(values.unitCostYuan * 100)
            : undefined,
          note: values.note?.trim() || undefined,
        },
      });
      message.success('库存已更新');
      setEditingStock(null);
      await loadAll();
    } catch (e: any) {
      message.error(e?.message || '库存更新失败');
    } finally {
      setSaving(false);
    }
  };

  const approveRequest = async (row: PurchaseRequestRow, step: 'manager' | 'purchaser') => {
    setSaving(true);
    try {
      await request({
        method: 'POST',
        url: `/purchase-requests/${row.id}/${step === 'manager' ? 'manager-approve' : 'purchaser-approve'}`,
      });
      message.success('审批已通过');
      setRequestDetail(null);
      await loadAll();
    } catch (e: any) {
      message.error(e?.message || '审批失败');
    } finally {
      setSaving(false);
    }
  };

  const submitRequestsToManager = async (ids: number[]) => {
    if (!ids.length) return;
    setSaving(true);
    try {
      await request({
        method: 'POST',
        url: '/purchase-requests/submit-to-manager',
        data: { requestIds: ids },
      });
      message.success(ids.length > 1 ? `已合并 ${ids.length} 条申请并提交经理` : '已提交物业经理审批');
      setRequestDetail(null);
      setSelectedRequestKeys([]);
      await loadAll();
    } catch (e: any) {
      message.error(e?.message || '提交失败');
    } finally {
      setSaving(false);
    }
  };

  const openManualRequest = () => {
    manualRequestForm.resetFields();
    manualRequestForm.setFieldsValue({ items: [{}] });
    setManualRequestOpen(true);
  };

  const submitManualRequest = async () => {
    const values = await manualRequestForm.validateFields();
    const items = (values.items || []).filter((item: any) => item?.materialId && item?.qty);
    if (!items.length) {
      message.warning('请至少添加一种材料');
      return;
    }
    setSaving(true);
    try {
      await request({
        method: 'POST',
        url: '/purchase-requests',
        data: {
          items: items.map((item: any) => ({
            materialId: item.materialId,
            qty: item.qty,
            estUnitCostCents: item.estUnitCostYuan != null ? Math.round(item.estUnitCostYuan * 100) : 0,
          })),
        },
      });
      message.success('采购申请已创建（进入办公室汇总）');
      setManualRequestOpen(false);
      await loadAll();
    } catch (e: any) {
      message.error(e?.message || '创建失败');
    } finally {
      setSaving(false);
    }
  };

  const submitReject = async () => {
    if (!rejectTarget) return;
    const values = await rejectForm.validateFields();
    setSaving(true);
    try {
      await request({
        method: 'POST',
        url: `/purchase-requests/${rejectTarget.id}/reject`,
        data: { reason: values.reason },
      });
      message.success('已驳回采购申请');
      rejectForm.resetFields();
      setRejectTarget(null);
      setRequestDetail(null);
      await loadAll();
    } catch (e: any) {
      message.error(e?.message || '驳回失败');
    } finally {
      setSaving(false);
    }
  };

  const openPurchaseOrder = (requestRow?: PurchaseRequestRow) => {
    purchaseOrderForm.resetFields();
    purchaseOrderForm.setFieldsValue({
      requestId: requestRow?.id,
      items: requestRow?.items?.length
        ? requestRow.items.map((item) => ({
            materialId: item.materialId,
            qty: item.qty,
            unitCostYuan: item.estUnitCostCents != null ? item.estUnitCostCents / 100 : undefined,
          }))
        : [{}],
    });
    setRequestDetail(null);
    setPurchaseOrderOpen(true);
  };

  const submitPurchaseOrder = async () => {
    const values = await purchaseOrderForm.validateFields();
    setSaving(true);
    try {
      await request({
        method: 'POST',
        url: '/purchase-orders',
        data: {
          requestId: values.requestId,
          supplierId: values.supplierId,
          items: (values.items || []).filter((item: any) => item?.materialId && item?.qty).map((item: any) => ({
            materialId: item.materialId,
            qty: item.qty,
            unitCostCents: Math.round((item.unitCostYuan || 0) * 100),
          })),
        },
      });
      message.success('采购单已创建');
      setPurchaseOrderOpen(false);
      await loadAll();
    } catch (e: any) {
      message.error(e?.message || '创建采购单失败');
    } finally {
      setSaving(false);
    }
  };

  const openReceipt = (order: PurchaseOrderRow) => {
    receiptForm.resetFields();
    receiptForm.setFieldsValue({
      purchaseOrderId: order.id,
      warehouseId: undefined,
      items: order.items.map((item) => ({
        materialId: item.materialId,
        orderedQty: item.qty,
        qty: item.qty,
        unitCostYuan: item.unitCostCents / 100,
        photoUrls: [],
        locationId: undefined,
      })),
    });
    setReceiptOrder(order);
  };

  const submitReceipt = async () => {
    const values = await receiptForm.validateFields();
    const items = (values.items || []);
    // 实物照片选填：货到了先入账，照片仓库慢慢补（2026-09-01）
    setSaving(true);
    try {
      await request({
        method: 'POST',
        url: '/goods-receipts',
        data: {
          purchaseOrderId: values.purchaseOrderId,
          warehouseId: values.warehouseId,
          items: items.map((item: any) => ({
            materialId: item.materialId,
            qty: item.qty,
            unitCostCents: Math.round((item.unitCostYuan || 0) * 100),
            photoUrls: item.photoUrls || [],
            locationId: item.locationId || undefined,
          })),
        },
      });
      message.success('采购入库已完成');
      setReceiptOrder(null);
      await loadAll();
    } catch (e: any) {
      message.error(e?.message || '入库失败');
    } finally {
      setSaving(false);
    }
  };

  const openGeneralReceipt = () => {
    generalReceiptForm.resetFields();
    generalReceiptForm.setFieldsValue({ items: [{ photoUrls: [] }] });
    setGeneralReceiptOpen(true);
  };

  const submitGeneralReceipt = async () => {
    const values = await generalReceiptForm.validateFields();
    const items = (values.items || []).filter((item: any) => item?.materialId && item?.qty);
    if (!items.length) {
      message.warning('请至少添加一种材料');
      return;
    }
    setSaving(true);
    try {
      await request({
        method: 'POST',
        url: '/goods-receipts/general',
        data: {
          warehouseId: values.warehouseId,
          sourceText: values.sourceText,
          attachments: values.attachments || [],
          items: items.map((item: any) => ({
            materialId: item.materialId,
            qty: item.qty,
            unitCostCents: Math.round((item.unitCostYuan || 0) * 100),
            photoUrls: item.photoUrls || [],
            locationId: item.locationId || undefined,
          })),
        },
      });
      message.success('一般入库已完成');
      setGeneralReceiptOpen(false);
      await loadAll();
    } catch (e: any) {
      message.error(e?.message || '入库失败');
    } finally {
      setSaving(false);
    }
  };

  const submitTransfer = async () => {
    const values = await transferForm.validateFields();
    setSaving(true);
    try {
      await request({
        method: 'POST',
        url: '/transfer-orders',
        data: {
          fromWarehouseId: values.fromWarehouseId,
          toWarehouseId: values.toWarehouseId,
          items: (values.items || []).filter((item: any) => item?.materialId && item?.qty),
        },
      });
      message.success('调拨单已创建');
      transferForm.resetFields();
      setTransferOpen(false);
      await loadAll();
    } catch (e: any) {
      message.error(e?.message || '创建调拨单失败');
    } finally {
      setSaving(false);
    }
  };

  const approveTransfer = async (row: TransferOrderRow) => {
    setSaving(true);
    try {
      await request({ method: 'POST', url: `/transfer-orders/${row.id}/approve` });
      message.success('已审批通过，发货仓已扣减，等待接收仓确认');
      await loadAll();
    } catch (e: any) {
      message.error(e?.message || '审批失败');
    } finally {
      setSaving(false);
    }
  };

  const rejectTransfer = async (row: TransferOrderRow, reason: string) => {
    setSaving(true);
    try {
      await request({ method: 'POST', url: `/transfer-orders/${row.id}/reject`, data: { reason } });
      message.success('已驳回');
      await loadAll();
    } catch (e: any) {
      message.error(e?.message || '驳回失败');
    } finally {
      setSaving(false);
    }
  };

  const openReceiveTransfer = (row: TransferOrderRow) => {
    setReceivingTransfer(row);
    receiveTransferForm.setFieldsValue({
      // 默认入哪一格由接收仓的「默认入库库位」带出来，收货人可以改
      locationId: warehouseById.get(row.toWarehouseId)?.defaultLocationId ?? undefined,
      items: row.items.map((item) => ({
        materialId: item.materialId,
        qty: item.qty,
        receivedQty: item.qty,
      })),
    });
    setReceiveTransferOpen(true);
  };

  const submitReceiveTransfer = async () => {
    if (!receivingTransfer) return;
    const values = await receiveTransferForm.validateFields();
    setSaving(true);
    try {
      await request({
        method: 'POST',
        url: `/transfer-orders/${receivingTransfer.id}/receive`,
        data: {
          locationId: values.locationId ?? null,
          items: (values.items || []).map((item: any) => ({
            materialId: item.materialId,
            receivedQty: item.receivedQty,
          })),
        },
      });
      message.success('已接收入库');
      setReceiveTransferOpen(false);
      setReceivingTransfer(null);
      await loadAll();
    } catch (e: any) {
      message.error(e?.message || '接收失败');
    } finally {
      setSaving(false);
    }
  };

  /* 库存清单的列。key 必须写死且唯一 —— 列宽/列序按 key 存本地，
     这里有三列都取 dataIndex: 'materialId'，光靠 dataIndex 区分不开。
     列本身每次渲染重建没关系，useTableColumnPrefs 只认 key。 */
  const stockColumns: PrefsColumn<StockRow>[] = [
    stockSeq.column,
    { key: 'warehouse', title: '仓库', dataIndex: 'warehouseId', width: 180, render: (id) => nameOr(warehouseById.get(id)?.name, '仓库') },
    {
      key: 'location', title: '库位', dataIndex: 'locationLabel', width: 130,
      render: (v: string | null) => v || <Text type="secondary">未指定</Text>,
    },
    {
      key: 'warehouseType', title: '仓库类型', dataIndex: 'warehouseId', width: 110,
      render: (id) => {
        const type = warehouseById.get(id)?.type;
        if (type === WarehouseType.CENTRAL) return <Tag color="blue">总仓</Tag>;
        if (type === WarehouseType.OFFICE) return <Tag color="geekblue">管理处仓</Tag>;
        return <Tag>小区仓</Tag>;
      },
    },
    {
      key: 'photo',
      title: '商品图片',
      dataIndex: 'materialId',
      width: 130,
      // 点开是这条 SKU 的整组大图，可左右翻
      render: (id) => <MaterialPhotoCell item={materialById.get(id)} />,
    },
    { key: 'code', title: '材料编码', dataIndex: 'materialId', width: 140, render: (id) => materialById.get(id)?.code || '-' },
    { key: 'name', title: '材料名称', dataIndex: 'materialId', width: 220, ellipsis: true, render: (id) => materialById.get(id)?.name || '-' },
    { key: 'spec', title: '规格', dataIndex: 'materialId', width: 140, render: (id) => materialById.get(id)?.spec || '-' },
    { key: 'category', title: '分类', dataIndex: 'materialId', width: 120, render: (id) => materialById.get(id)?.category || '-' },
    { key: 'qty', title: '当前库存', dataIndex: 'qty', width: 120, render: (v, row) => `${numberQty(v)} ${materialById.get(row.materialId)?.unit || ''}` },
    { key: 'safetyQty', title: '安全库存', dataIndex: 'safetyQty', width: 120, render: (v, row) => `${numberQty(v)} ${materialById.get(row.materialId)?.unit || ''}` },
    {
      key: 'unitCost',
      title: '批次均价',
      dataIndex: 'unitCostCents',
      width: 120,
      render: (v, row) => (
        <Tooltip title={row.costSource === 'lot' ? '按剩余入库批次加权' : '没有入库批次记录，按 SKU 参考成本'}>
          <span>{money(v)}{row.costSource !== 'lot' && <Text type="secondary"> *</Text>}</span>
        </Tooltip>
      ),
    },
    { key: 'amount', title: '库存金额', dataIndex: 'amountCents', width: 120, render: (v) => money(v) },
    {
      key: 'status',
      title: '状态',
      width: 110,
      render: (_, row) => numberQty(row.qty) <= numberQty(row.safetyQty) ? <Tag color="red">低库存</Tag> : <Tag color="green">正常</Tag>,
    },
    {
      key: 'op',
      title: '操作',
      width: 150,
      fixed: 'right',
      render: (_, row) => (
        <Space size={0}>
          <Button size="small" type="link" icon={<UnorderedListOutlined />} onClick={() => setLotDrawerStock(row)}>批次</Button>
          {canEdit && <Button size="small" type="link" icon={<EditOutlined />} onClick={() => openEditStock(row)}>编辑</Button>}
        </Space>
      ),
    },
  ];
  const stockPrefs = useTableColumnPrefs('inventory.stock', stockColumns);

  const renderItems = (items: Array<PurchaseRequestItem | PurchaseOrderItem | TransferOrderItem>) => (
    <Space size={[6, 6]} wrap>
      {items?.length ? items.map((item, index) => {
        const material = 'materialId' in item && item.materialId ? materialById.get(item.materialId) : null;
        const name = material ? materialDisplayName(material) : (('name' in item && item.name) ? item.name : unknown('材料'));
        const unit = material?.unit || '';
        return <Tag key={`${name}-${index}`}>{name} x {item.qty}{unit}</Tag>;
      }) : <Text type="secondary">无明细</Text>}
    </Space>
  );

  return (
    <div>
      <Space align="start" style={{ width: '100%', justifyContent: 'space-between', marginBottom: 16 }}>
        <div>
          <Title level={3} style={{ margin: 0 }}>库存与采购</Title>
          <Text type="secondary">按库存清单、缺料审批、采购下单、到货入库、仓库调拨与领料组织日常工作。</Text>
        </div>
        <Space>
          <Button icon={<ReloadOutlined />} loading={loading} onClick={loadAll}>刷新</Button>
          {canEdit && <Button icon={<InboxOutlined />} onClick={openGeneralReceipt}>一般入库</Button>}
          {canEdit && <Button type="primary" icon={<PlusOutlined />} onClick={() => openPurchaseOrder()}>新建采购单</Button>}
        </Space>
      </Space>

      {/* 金额卡占双格：¥ 带千分位的数字比计数宽得多，挤在单格里会换行、把整行高度撑乱 */}
      <Row gutter={[16, 16]} align="stretch" style={{ marginBottom: 16 }}>
        {companyWide && <Col xs={24} sm={12} lg={6} xl={3}><Metric title="材料 SKU" value={stats.materials} /></Col>}
        {companyWide && <Col xs={24} sm={12} lg={6} xl={3}><Metric title="仓库数量" value={stats.warehouses} /></Col>}
        <Col xs={24} sm={12} lg={6} xl={3}><Metric title="库存预警" value={stats.lowStock} alert /></Col>
        <Col xs={24} sm={24} lg={12} xl={6}><Metric title="库存总值" value={stats.stockValue} money suffix="按剩余入库批次加权，与报表页口径一致" /></Col>
        <Col xs={24} sm={12} lg={6} xl={3}><Metric title="采购待审" value={stats.pendingRequests} /></Col>
        <Col xs={24} sm={12} lg={6} xl={3}><Metric title="待下单申请" value={stats.approvedRequests} /></Col>
        <Col xs={24} sm={12} lg={6} xl={3}><Metric title="在途采购单" value={stats.placedOrders} /></Col>
      </Row>

      <Tabs
        items={[
          {
            key: 'stock',
            label: <span><InboxOutlined /> 库存清单</span>,
            children: (
              <Card
                title="仓库库存"
                extra={(
                  <Space wrap>
                    {/* 看哪个仓：默认自己所属管理处的仓，有别的仓的权限就能在这里切 */}
                    <Select
                      {...searchableWideSelectProps}
                      value={stockWarehouseId}
                      onChange={(value) => { setStockWarehousePicked(true); setStockWarehouseId(value); }}
                      options={stockWarehouseOptions}
                      style={{ width: 280 }}
                      placeholder="选择仓库"
                    />
                    {centralHint && (
                      <Tooltip title={centralHint}>
                        <Text type="secondary" style={{ fontSize: 12, cursor: 'help' }}>看不到总仓？</Text>
                      </Tooltip>
                    )}
                    {stockPrefs.customized && (
                      <Tooltip title="把列宽和列顺序恢复成系统默认">
                        <Button size="small" icon={<ColumnWidthOutlined />} onClick={stockPrefs.reset}>恢复默认列</Button>
                      </Tooltip>
                    )}
                    <Input.Search allowClear placeholder="搜索材料 / 仓库" onSearch={setKeyword} onChange={(event) => setKeyword(event.target.value)} style={{ width: 220 }} />
                  </Space>
                )}
              >
                {/* 分类快筛：只列出当前确实有库存的分类，并带上条数，
                    省得点进去发现是空的（数量口径 = 搜索之后、分类之前） */}
                <Tabs
                  size="small"
                  activeKey={stockCategory}
                  onChange={setStockCategory}
                  items={stockCategoryItems}
                  style={{ marginBottom: 12 }}
                />
                <Text type="secondary" style={{ display: 'block', marginBottom: 8, fontSize: 12 }}>
                  表头可直接拖动：拖右边缘调列宽，按住表头左右拖调列顺序，改完自动记住。
                </Text>
                <Table
                  rowKey="id"
                  loading={loading}
                  dataSource={filteredStocks}
                  tableLayout="fixed"
                  scroll={{ x: 1440 }}
                  pagination={stockSeq.pagination}
                  components={stockPrefs.components}
                  columns={stockPrefs.columns}
                />
              </Card>
            ),
          },
          {
            key: 'requests',
            label: <span><AuditOutlined /> 采购申请</span>,
            children: (
              <Card
                title="采购申请单"
                extra={
                  <Space>
                    {canEdit && <Button icon={<PlusOutlined />} onClick={openManualRequest}>新建采购申请</Button>}
                    <Button onClick={loadAll} icon={<ReloadOutlined />}>刷新</Button>
                  </Space>
                }
              >
                <Tabs
                  size="small"
                  activeKey={requestFilter}
                  onChange={(key) => { setRequestFilter(key as RequestFilterKey); setSelectedRequestKeys([]); }}
                  items={requestFilterItems}
                  style={{ marginBottom: 12 }}
                />
                {requestFilter === PurchaseRequestStatus.OFFICE_REVIEW && (
                  <Alert
                    type="info"
                    showIcon
                    style={{ marginBottom: 12 }}
                    message="办公室汇总：勾选多条同类缺料申请可合并成一张提交给物业经理；单条也可直接提交。"
                    action={
                      <Popconfirm
                        title={`将勾选的 ${selectedRequestKeys.length} 条合并提交经理？`}
                        disabled={selectedRequestKeys.length === 0}
                        onConfirm={() => submitRequestsToManager(selectedRequestKeys)}
                      >
                        <Button size="small" type="primary" disabled={selectedRequestKeys.length === 0} loading={saving}>
                          合并提交经理（{selectedRequestKeys.length}）
                        </Button>
                      </Popconfirm>
                    }
                  />
                )}
                <Table
                  rowKey="id"
                  loading={loading}
                  dataSource={filteredPurchaseRequests}
                  tableLayout="fixed"
                  scroll={{ x: 1320 }}
                  rowSelection={requestFilter === PurchaseRequestStatus.OFFICE_REVIEW ? {
                    selectedRowKeys: selectedRequestKeys,
                    onChange: (keys) => setSelectedRequestKeys(keys as number[]),
                  } : undefined}
                  pagination={{ defaultPageSize: 50, pageSizeOptions: inventoryPageSizeOptions, showSizeChanger: true }}
                  columns={[
                    { title: '申请单号', dataIndex: 'requestNo', width: 180, ellipsis: true },
                    { title: '当前环节', dataIndex: 'status', width: 140, render: (s: PurchaseRequestStatus) => <Tag color={requestStatusMeta[s]?.color}>{requestStatusMeta[s]?.label || s}</Tag> },
                    { title: '来源', key: 'source', width: 170, ellipsis: true, render: (_, row) => row.workOrderId ? (row.workOrderNo || unknown('工单')) : '手工申请' },
                    { title: '材料摘要', dataIndex: 'items', width: 360, render: renderItems },
                    { title: '预估金额', dataIndex: 'estTotalCents', width: 120, render: money },
                    { title: '申请人', key: 'applicant', width: 110, render: (_, row) => nameOr(row.applicantName, '申请人') },
                    {
                      title: '审批进度',
                      key: 'progress',
                      width: 220,
                      render: (_, row) => (
                        <Space size={4} wrap>
                          <Tag color={row.managerAt ? 'green' : 'default'}>经理{row.managerAt ? '已审' : '待审'}</Tag>
                          <Tag color={row.purchaserAt ? 'green' : row.status === PurchaseRequestStatus.PURCHASER_REVIEW ? 'blue' : 'default'}>采购{row.purchaserAt ? '已审' : '待审'}</Tag>
                        </Space>
                      ),
                    },
                    { title: '申请时间', dataIndex: 'createdAt', width: 170, render: formatDateTime },
                    {
                      title: '操作',
                      key: 'op',
                      fixed: 'right',
                      width: 170,
                      render: (_, row) => (
                        <Space size={4}>
                          <Button size="small" type="link" onClick={() => setRequestDetail(row)}>
                            {[
                              PurchaseRequestStatus.MANAGER_REVIEW,
                              PurchaseRequestStatus.PURCHASER_REVIEW,
                            ].includes(row.status) ? '审批' : '查看'}
                          </Button>
                          {canEdit && row.status === PurchaseRequestStatus.APPROVED && (
                            <Button size="small" type="link" onClick={() => openPurchaseOrder(row)}>下单</Button>
                          )}
                        </Space>
                      ),
                    },
                  ]}
                />
              </Card>
            ),
          },
          {
            key: 'orders',
            label: <span><ShoppingCartOutlined /> 采购单与入库</span>,
            children: (
              <Card title="采购单" extra={canEdit && <Button type="primary" icon={<PlusOutlined />} onClick={() => openPurchaseOrder()}>新建采购单</Button>}>
                <Table
                  rowKey="id"
                  loading={loading}
                  dataSource={purchaseOrders}
                  tableLayout="fixed"
                  scroll={{ x: 1120 }}
                  pagination={{ pageSize: 10, showSizeChanger: false }}
                  columns={[
                    { title: '采购单号', dataIndex: 'orderNo', width: 180, ellipsis: true },
                    { title: '关联申请', key: 'request', width: 180, ellipsis: true, render: (_, row) => row.requestId ? (row.requestNo || unknown('申请单')) : '手工下单' },
                    { title: '供应商', dataIndex: 'supplierId', width: 180, render: (id) => nameOr(supplierById.get(id)?.name, '供应商') },
                    { title: '采购明细', dataIndex: 'items', width: 340, render: renderItems },
                    { title: '总金额', dataIndex: 'totalCents', width: 120, render: money },
                    { title: '状态', dataIndex: 'status', width: 110, render: (s) => <Tag color={orderStatusMeta[s]?.color}>{orderStatusMeta[s]?.label || s}</Tag> },
                    {
                      title: '操作',
                      key: 'op',
                      fixed: 'right',
                      width: 120,
                      render: (_, row) => canEdit && [PurchaseOrderStatus.PLACED, PurchaseOrderStatus.PARTIAL].includes(row.status) ? (
                        <Button size="small" type="link" onClick={() => openReceipt(row)}>到货入库</Button>
                      ) : <Text type="secondary">-</Text>,
                    },
                  ]}
                />
              </Card>
            ),
          },
          {
            key: 'transfers',
            label: <span><SwapOutlined /> 仓库调拨与领料</span>,
            children: (
              <Card title="调拨单" extra={canEdit && <Button type="primary" icon={<PlusOutlined />} onClick={() => { transferForm.resetFields(); transferForm.setFieldsValue({ items: [{}] }); setTransferOpen(true); }}>新建调拨</Button>}>
                <Table
                  rowKey="id"
                  loading={loading}
                  dataSource={transferOrders}
                  tableLayout="fixed"
                  scroll={{ x: 1120 }}
                  pagination={{ pageSize: 10, showSizeChanger: false }}
                  columns={[
                    { title: '调拨单号', dataIndex: 'transferNo', width: 180, ellipsis: true },
                    { title: '出库仓', dataIndex: 'fromWarehouseId', width: 180, render: (id) => nameOr(warehouseById.get(id)?.name, '仓库') },
                    { title: '入库仓', dataIndex: 'toWarehouseId', width: 180, render: (id) => nameOr(warehouseById.get(id)?.name, '仓库') },
                    { title: '调拨明细', dataIndex: 'items', width: 300, render: renderItems },
                    { title: '状态', dataIndex: 'status', width: 120, render: (s) => <Tag color={transferStatusMeta[s]?.color}>{transferStatusMeta[s]?.label || s}</Tag> },
                    { title: '审批时间', dataIndex: 'approvedAt', width: 160, render: formatDateTime },
                    { title: '接收时间', dataIndex: 'receivedAt', width: 160, render: formatDateTime },
                    {
                      title: '操作',
                      key: 'op',
                      fixed: 'right',
                      width: 170,
                      render: (_, row) => canEdit && row.status === 'pending_review' ? (
                        <Space size={4}>
                          <Popconfirm title="审批通过？" description="发货仓将立即扣减库存并锁定在途。" onConfirm={() => approveTransfer(row)}>
                            <Button size="small" type="link">审批</Button>
                          </Popconfirm>
                          <Button size="small" type="link" danger onClick={() => { setRejectTransferTarget(row); rejectTransferForm.resetFields(); }}>驳回</Button>
                        </Space>
                      ) : canEdit && row.status === 'approved' ? (
                        <Button size="small" type="link" onClick={() => openReceiveTransfer(row)}>接收确认</Button>
                      ) : row.status === 'rejected' && row.rejectReason ? (
                        <Tooltip title={row.rejectReason}><Text type="secondary">驳回原因</Text></Tooltip>
                      ) : <Text type="secondary">-</Text>,
                    },
                  ]}
                />
              </Card>
            ),
          },
          {
            key: 'catalog',
            label: '基础资料',
            children: (
              <Card>
                <Tabs
                  items={[
                    {
                      key: 'materials',
                      label: '材料SKU',
                      children: (
                        <>
                          <Space style={{ width: '100%', justifyContent: 'flex-end', marginBottom: 12 }}>
                            {canEdit && <Button size="small" icon={<PlusOutlined />} onClick={openCreateMaterial}>新增材料</Button>}
                          </Space>
                          <Table
                            rowKey="id"
                            size="small"
                            dataSource={materials}
                            pagination={materialSeq.pagination}
                            columns={[
                              materialSeq.column,
                              { title: '类别', dataIndex: 'category', width: 110, render: (v) => v || '-' },
                              { title: '编码', dataIndex: 'code', width: 120, ellipsis: true },
                              {
                                title: '实物照片',
                                key: 'photos',
                                width: 130,
                                // 点开是整组大图，可左右翻
                                render: (_, row) => <MaterialPhotoCell item={row} />,
                              },
                              { title: '名称', dataIndex: 'name', ellipsis: true },
                              { title: '规格', dataIndex: 'spec', width: 120, render: (v) => v || '-' },
                              { title: '单位', dataIndex: 'unit', width: 80 },
                              { title: '参考成本', dataIndex: 'defaultCostCents', width: 110, render: money },
                              {
                                title: '操作',
                                key: 'op',
                                width: 90,
                                render: (_, row) => canEdit ? <Button size="small" type="link" icon={<EditOutlined />} onClick={() => openEditMaterial(row)}>编辑</Button> : null,
                              },
                            ]}
                          />
                        </>
                      ),
                    },
                    {
                      key: 'categories',
                      label: '材料类别',
                      children: (
                        <MaterialCategoryPanel
                          rows={materialCategories}
                          canEdit={canEdit}
                          canDelete={canDelete}
                          onChanged={loadAll}
                        />
                      ),
                    },
                    {
                      key: 'warehouses',
                      label: '仓库档案',
                      children: (
                        <>
                          <Space style={{ width: '100%', justifyContent: 'flex-end', marginBottom: 12 }}>
                            {canEdit && <Button size="small" icon={<PlusOutlined />} onClick={openCreateWarehouse}>新增仓库</Button>}
                          </Space>
                          <Table
                            rowKey="id"
                            size="small"
                            dataSource={warehouses}
                            pagination={{ pageSize: 12, showSizeChanger: false }}
                            columns={[
                              { title: '名称', dataIndex: 'name', ellipsis: true },
                              { title: '类型', dataIndex: 'type', width: 110, render: (v) => WAREHOUSE_TYPE_LABELS[v] || v },
                              // 人员按角色范围对应管理处、再对应到这里的仓：空 = 公司级，全公司范围的人才默认它
                              {
                                title: '所属管理处', dataIndex: 'officeName', width: 180,
                                render: (v: string | null, row) =>
                                  v || (row.officeId ? unknown('管理处') : <Text type="secondary">公司级（总仓）</Text>),
                              },
                              {
                                title: '库位数',
                                key: 'locations',
                                width: 90,
                                render: (_, row) => warehouseLocations.filter((loc) => loc.warehouseId === row.id).length || <Text type="secondary">0</Text>,
                              },
                              {
                                title: '操作',
                                key: 'op',
                                width: 190,
                                render: (_, row) => canEdit ? (
                                  <Space size={0}>
                                    <Button size="small" type="link" icon={<EditOutlined />} onClick={() => openEditWarehouse(row)}>编辑</Button>
                                    <Button size="small" type="link" icon={<AppstoreOutlined />} onClick={() => setLocationConfigWarehouse(row)}>库位</Button>
                                  </Space>
                                ) : null,
                              },
                            ]}
                          />
                        </>
                      ),
                    },
                    {
                      key: 'suppliers',
                      label: '供应商档案',
                      children: (
                        <>
                          <Space style={{ width: '100%', justifyContent: 'flex-end', marginBottom: 12 }}>
                            {canEdit && <Button size="small" icon={<PlusOutlined />} onClick={openCreateSupplier}>新增供应商</Button>}
                          </Space>
                          <Table
                            rowKey="id"
                            size="small"
                            dataSource={suppliers}
                            pagination={{ pageSize: 12, showSizeChanger: false }}
                            columns={[
                              { title: '名称', dataIndex: 'name', ellipsis: true },
                              { title: '联系人', dataIndex: 'contactName', width: 120, render: (v) => v || '-' },
                              { title: '电话', dataIndex: 'contactPhone', width: 140, render: (v) => v || '-' },
                              {
                                title: '操作',
                                key: 'op',
                                width: 90,
                                render: (_, row) => canEdit ? <Button size="small" type="link" icon={<EditOutlined />} onClick={() => openEditSupplier(row)}>编辑</Button> : null,
                              },
                            ]}
                          />
                        </>
                      ),
                    },
                  ]}
                />
              </Card>
            ),
          },
        ]}
      />

      <CatalogModal
        kind={catalogOpen}
        form={catalogForm}
        warehouseLocationOptions={editingWarehouse ? locationOptionsByWarehouse.get(editingWarehouse.id) ?? [] : []}
        materialCategoryOptions={materialCategoryOptions}
        editingMaterial={editingMaterial}
        editingWarehouse={editingWarehouse}
        editingSupplier={editingSupplier}
        saving={saving}
        onCancel={closeCatalog}
        onOk={submitCatalog}
      />
      <PurchaseOrderModal
        open={purchaseOrderOpen}
        form={purchaseOrderForm}
        saving={saving}
        materialOptions={materialOptions}
        supplierOptions={supplierOptions}
        onCancel={() => setPurchaseOrderOpen(false)}
        onOk={submitPurchaseOrder}
      />
      <ReceiptModal
        order={receiptOrder}
        form={receiptForm}
        saving={saving}
        materialById={materialById}
        warehouseOptions={warehouseOptions}
        locationOptionsByWarehouse={locationOptionsByWarehouse}
        defaultLocationByWarehouse={defaultLocationByWarehouse}
        onCancel={() => setReceiptOrder(null)}
        onOk={submitReceipt}
      />
      <GeneralReceiptModal
        open={generalReceiptOpen}
        form={generalReceiptForm}
        saving={saving}
        materialOptions={materialOptions}
        warehouseOptions={warehouseOptions}
        locationOptionsByWarehouse={locationOptionsByWarehouse}
        defaultLocationByWarehouse={defaultLocationByWarehouse}
        onCancel={() => setGeneralReceiptOpen(false)}
        onOk={submitGeneralReceipt}
      />
      <LocationConfigModal
        warehouse={locationConfigWarehouse}
        locations={warehouseLocations.filter((loc) => loc.warehouseId === locationConfigWarehouse?.id)}
        onClose={() => setLocationConfigWarehouse(null)}
        onChanged={loadAll}
      />
      <TransferModal
        open={transferOpen}
        form={transferForm}
        saving={saving}
        materialOptions={materialOptions}
        warehouseOptions={warehouseOptions}
        onCancel={() => setTransferOpen(false)}
        onOk={submitTransfer}
      />
      <Modal
        open={receiveTransferOpen}
        title={receivingTransfer ? `接收确认 ${receivingTransfer.transferNo}` : '接收确认'}
        okText="确认接收入库"
        confirmLoading={saving}
        onOk={submitReceiveTransfer}
        onCancel={() => { setReceiveTransferOpen(false); setReceivingTransfer(null); }}
        width={560}
        destroyOnHidden
      >
        <Text type="secondary">核对每种材料实际收到数量，可修改（不得超过发出数量）。存在差异时会自动通知发货人核查。</Text>
        <Form form={receiveTransferForm} layout="vertical" style={{ marginTop: 16 }}>
          <Form.Item
            name="locationId"
            label="入库库位"
            extra={
              receiveLocationOptions.length
                ? '默认是接收仓配的库位，可以改；整单入同一格'
                : '接收仓还没配库位，可先在「基础资料 → 仓库档案 → 库位」里加'
            }
          >
            <Select
              allowClear
              disabled={!receiveLocationOptions.length}
              placeholder={receiveLocationOptions.length ? '选择库位' : '该仓暂无库位'}
              options={receiveLocationOptions}
            />
          </Form.Item>
          <Form.List name="items">
            {(fields) => (
              <>
                {fields.map((field) => {
                  const item = receiveTransferForm.getFieldValue(['items', field.name]);
                  const material = materialById.get(item?.materialId);
                  return (
                    <div key={field.key} style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
                      <div style={{ flex: 1 }}>
                        <div style={{ fontWeight: 600 }}>{material ? materialDisplayName(material) : unknown('材料')}</div>
                        <Text type="secondary" style={{ fontSize: 12 }}>发出 {item?.qty} {material?.unit || ''}</Text>
                      </div>
                      <Form.Item name={[field.name, 'materialId']} hidden><Input /></Form.Item>
                      <Form.Item name={[field.name, 'qty']} hidden><Input /></Form.Item>
                      <Form.Item
                        name={[field.name, 'receivedQty']}
                        label="实收"
                        style={{ marginBottom: 0, width: 140 }}
                        rules={[
                          { required: true, message: '请填写实收数量' },
                          {
                            validator: (_, v) =>
                              v > item?.qty
                                ? Promise.reject(new Error(`不得超过发出 ${item?.qty}`))
                                : Promise.resolve(),
                          },
                        ]}
                      >
                        <InputNumber min={0} max={item?.qty} style={{ width: '100%' }} />
                      </Form.Item>
                    </div>
                  );
                })}
              </>
            )}
          </Form.List>
        </Form>
      </Modal>
      <Modal
        open={!!rejectTransferTarget}
        title={rejectTransferTarget ? `驳回调拨 ${rejectTransferTarget.transferNo}` : '驳回调拨'}
        okText="确认驳回"
        okButtonProps={{ danger: true, loading: saving }}
        onOk={async () => {
          const v = await rejectTransferForm.validateFields();
          await rejectTransfer(rejectTransferTarget!, v.reason);
          setRejectTransferTarget(null);
        }}
        onCancel={() => setRejectTransferTarget(null)}
        destroyOnHidden
      >
        <Form form={rejectTransferForm} layout="vertical">
          <Form.Item name="reason" label="驳回原因" rules={[{ required: true, message: '请填写驳回原因' }]}>
            <Input.TextArea rows={3} maxLength={200} placeholder="如：库存需要保留、调拨数量有误等" />
          </Form.Item>
        </Form>
      </Modal>
      <Drawer
        title={requestDetail ? `采购申请单 ${requestDetail.requestNo}` : '采购申请单'}
        open={!!requestDetail}
        onClose={() => setRequestDetail(null)}
        width={860}
        extra={requestDetail ? (
          <Space>
            {requestDetail.status === PurchaseRequestStatus.OFFICE_REVIEW && (
              <Popconfirm title="提交给物业经理审批？" description="如需合并多条申请，请在列表勾选后批量提交。" onConfirm={() => submitRequestsToManager([requestDetail.id])}>
                <Button type="primary" loading={saving}>提交经理</Button>
              </Popconfirm>
            )}
            {requestDetail.status === PurchaseRequestStatus.MANAGER_REVIEW && (
              <Popconfirm title="确认物业经理审批通过？" onConfirm={() => approveRequest(requestDetail, 'manager')}>
                <Button type="primary" loading={saving}>经理通过</Button>
              </Popconfirm>
            )}
            {requestDetail.status === PurchaseRequestStatus.PURCHASER_REVIEW && (
              <Popconfirm title="确认采购经理审批通过？" onConfirm={() => approveRequest(requestDetail, 'purchaser')}>
                <Button type="primary" loading={saving}>采购通过</Button>
              </Popconfirm>
            )}
            {canEdit && requestDetail.status === PurchaseRequestStatus.APPROVED && (
              <Button type="primary" icon={<ShoppingCartOutlined />} onClick={() => openPurchaseOrder(requestDetail)}>转采购单</Button>
            )}
            {[PurchaseRequestStatus.OFFICE_REVIEW, PurchaseRequestStatus.MANAGER_REVIEW, PurchaseRequestStatus.PURCHASER_REVIEW, PurchaseRequestStatus.APPROVED].includes(requestDetail.status) && (
              <Button danger onClick={() => setRejectTarget(requestDetail)}>驳回</Button>
            )}
          </Space>
        ) : null}
      >
        {requestDetail && (
          <Space direction="vertical" size={16} style={{ width: '100%' }}>
            <Steps
              size="small"
              current={requestStepCurrent(requestDetail.status)}
              status={requestStepStatus(requestDetail.status)}
              items={[
                {
                  title: '办公室汇总',
                  description: requestDetail.status === PurchaseRequestStatus.OFFICE_REVIEW ? '待汇总' : '已提交',
                },
                {
                  title: '物业经理审批',
                  // 「谁在什么时候批的」要一起写，只有时间的话回头查是谁批的还得去问人
                  description: requestDetail.managerAt
                    ? `${nameOr(requestDetail.managerName, '审批人')} · ${formatDateTime(requestDetail.managerAt)}`
                    : '待处理',
                },
                {
                  title: '采购经理审批',
                  description: requestDetail.purchaserAt
                    ? `${nameOr(requestDetail.purchaserName, '审批人')} · ${formatDateTime(requestDetail.purchaserAt)}`
                    : '待处理',
                },
                {
                  title: '采购下单',
                  description: requestDetail.status === PurchaseRequestStatus.APPROVED
                    ? '待转采购单'
                    : requestDetail.status === PurchaseRequestStatus.DONE ? '已转采购单' : '待审批完成',
                },
              ]}
            />

            {requestDetail.status === PurchaseRequestStatus.REJECTED && (
              <Alert type="error" showIcon message="采购申请已驳回" description={requestDetail.rejectReason || '未填写驳回原因'} />
            )}

            {/* 只放人看得懂的：单号、姓名、金额、时间。
                申请的数据库 id 不显示 —— 那是程序定位用的，用户不关心（2026-09-01 反馈） */}
            <Card size="small" title="申请信息">
              <Row gutter={[16, 12]}>
                <Col span={8}><Text type="secondary">申请单号</Text><br /><Text>{requestDetail.requestNo}</Text></Col>
                <Col span={8}><Text type="secondary">当前状态</Text><br /><Tag color={requestStatusMeta[requestDetail.status]?.color}>{requestStatusMeta[requestDetail.status]?.label || requestDetail.status}</Tag></Col>
                <Col span={8}><Text type="secondary">申请人</Text><br /><Text>{nameOr(requestDetail.applicantName, '申请人')}</Text></Col>
                <Col span={8}>
                  <Text type="secondary">来源工单</Text><br />
                  <Text>{requestDetail.workOrderId ? (requestDetail.workOrderNo || unknown('工单')) : '手工申请，无来源工单'}</Text>
                </Col>
                <Col span={8}><Text type="secondary">预估金额</Text><br /><Text strong>{money(requestDetail.estTotalCents)}</Text></Col>
                <Col span={8}><Text type="secondary">创建时间</Text><br /><Text>{formatDateTime(requestDetail.createdAt)}</Text></Col>
              </Row>
            </Card>

            <Card size="small" title="材料明细">
              <Table
                rowKey="key"
                size="small"
                pagination={false}
                dataSource={(requestDetail.items || []).map((item, index) => ({ ...item, key: index }))}
                columns={[
                  { title: '序号', dataIndex: 'key', width: 64, render: (v) => Number(v) + 1 },
                  {
                    title: '材料编码',
                    dataIndex: 'materialId',
                    width: 120,
                    render: (id) => id ? materialById.get(id)?.code || '-' : '-',
                  },
                  {
                    title: '材料名称',
                    key: 'name',
                    ellipsis: true,
                    render: (_, item) => {
                      const material = item.materialId ? materialById.get(item.materialId) : null;
                      return material ? material.name : item.name || '-';
                    },
                  },
                  {
                    title: '规格',
                    key: 'spec',
                    width: 120,
                    render: (_, item) => item.materialId ? materialById.get(item.materialId)?.spec || '-' : '-',
                  },
                  {
                    title: '数量',
                    key: 'qty',
                    width: 110,
                    render: (_, item) => {
                      const material = item.materialId ? materialById.get(item.materialId) : null;
                      return `${item.qty}${material?.unit || ''}`;
                    },
                  },
                  { title: '预估单价', dataIndex: 'estUnitCostCents', width: 110, render: (v) => v != null ? money(v) : '-' },
                  {
                    title: '小计',
                    key: 'amount',
                    width: 120,
                    render: (_, item) => item.estUnitCostCents != null ? money(item.qty * item.estUnitCostCents) : '-',
                  },
                ]}
              />
            </Card>
          </Space>
        )}
      </Drawer>
      <Modal
        title={`驳回采购申请 ${rejectTarget?.requestNo || ''}`}
        open={!!rejectTarget}
        onCancel={() => setRejectTarget(null)}
        onOk={submitReject}
        confirmLoading={saving}
        destroyOnHidden
      >
        <Form form={rejectForm} layout="vertical">
          <Form.Item name="reason" label="驳回原因" rules={[{ required: true, message: '请填写驳回原因' }]}>
            <Input.TextArea rows={3} placeholder="说明缺料信息、金额或供应渠道问题" />
          </Form.Item>
        </Form>
      </Modal>
      <Modal
        title="新建采购申请"
        open={manualRequestOpen}
        onCancel={() => setManualRequestOpen(false)}
        onOk={submitManualRequest}
        confirmLoading={saving}
        width={720}
        destroyOnHidden
      >
        <Alert type="info" showIcon style={{ marginBottom: 12 }} message="办公室手工新建的采购申请进入「办公室汇总」环节，可与维修工缺料申请一起合并后提交经理。材料从 SKU 库选择。" />
        <Form form={manualRequestForm} layout="vertical" initialValues={{ items: [{}] }}>
          <Form.List name="items">
            {(fields, { add, remove }) => (
              <Space direction="vertical" style={{ width: '100%' }}>
                {fields.map((field) => (
                  <Row key={field.key} gutter={8} align="middle">
                    <Col span={13}><Form.Item name={[field.name, 'materialId']} rules={[{ required: true, message: '请选择材料' }]} noStyle><Select {...searchableExtraWideSelectProps} placeholder="材料" options={materialOptions} /></Form.Item></Col>
                    <Col span={5}><Form.Item name={[field.name, 'qty']} rules={[{ required: true, message: '数量' }]} noStyle><InputNumber min={0.01} placeholder="数量" style={{ width: '100%' }} /></Form.Item></Col>
                    <Col span={5}><Form.Item name={[field.name, 'estUnitCostYuan']} noStyle><InputNumber min={0} precision={2} placeholder="预估单价" style={{ width: '100%' }} /></Form.Item></Col>
                    <Col span={1}><Button danger size="small" onClick={() => remove(field.name)}>删</Button></Col>
                  </Row>
                ))}
                <Button type="dashed" block onClick={() => add({})}>+ 增加材料</Button>
              </Space>
            )}
          </Form.List>
        </Form>
      </Modal>
      <Modal
        title={editingStock
          ? `编辑库存：${materialDisplayName(materialById.get(editingStock.materialId)) || unknown('材料')} · ${nameOr(warehouseById.get(editingStock.warehouseId)?.name, '仓库')}`
          : '编辑库存'}
        open={!!editingStock}
        onCancel={() => setEditingStock(null)}
        onOk={submitStock}
        confirmLoading={saving}
        destroyOnHidden
      >
        <Form form={stockForm} layout="vertical">
          <Form.Item label="材料">
            <Input
              value={editingStock ? materialDisplayName(editingStockMaterial) : ''}
              disabled
            />
          </Form.Item>
          <Form.Item label="仓库">
            <Input
              value={editingStock ? nameOr(warehouseById.get(editingStock.warehouseId)?.name, '仓库') : ''}
              disabled
            />
          </Form.Item>
          <Row gutter={12}>
            <Col span={12}>
              <Form.Item name="qty" label="当前库存" rules={[{ required: true, message: '请填写当前库存' }]}>
                <InputNumber min={0} precision={stockQtyPrecision} step={stockQtyPrecision ? 0.01 : 1} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="safetyQty" label="安全库存" rules={[{ required: true, message: '请填写安全库存' }]}>
                <InputNumber min={0} precision={stockQtyPrecision} step={stockQtyPrecision ? 0.01 : 1} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
          </Row>
          {/* 数量只能通过批次变：盘盈建一条新批次（要单价），盘亏按先进先出扣旧批次 */}
          <Form.Item noStyle shouldUpdate={(prev, next) => prev.qty !== next.qty}>
            {({ getFieldValue }) => {
              const nextQty = numberQty(getFieldValue('qty'));
              const currentQty = numberQty(editingStock?.qty);
              if (nextQty > currentQty) {
                return (
                  <Form.Item
                    name="unitCostYuan"
                    label={`盘盈单价（元）· 本次盘盈 ${(nextQty - currentQty).toFixed(stockQtyPrecision)} ${editingStockMaterial?.unit || ''}`}
                    tooltip="盘盈的数量会作为一条新入库批次记账，之后领料按这个价算成本。默认取 SKU 参考成本。"
                    rules={[{ required: true, message: '请填写盘盈单价' }]}
                  >
                    <InputNumber min={0} precision={2} style={{ width: '100%' }} />
                  </Form.Item>
                );
              }
              if (nextQty < currentQty) {
                return (
                  <Alert
                    type="info"
                    showIcon
                    style={{ marginBottom: 16 }}
                    message={`本次盘亏 ${(currentQty - nextQty).toFixed(stockQtyPrecision)} ${editingStockMaterial?.unit || ''}，按先进先出从最早的入库批次扣减，成本取被扣批次的单价。`}
                  />
                );
              }
              return null;
            }}
          </Form.Item>
          <Form.Item name="note" label="调整原因" extra="写进出入库流水，方便日后对账">
            <Input maxLength={200} placeholder="如：月末盘点、报损、系统上线前存量补录" />
          </Form.Item>
        </Form>
      </Modal>
      <StockLotDrawer
        stock={lotDrawerStock}
        material={lotDrawerStock ? materialById.get(lotDrawerStock.materialId) : undefined}
        warehouseName={lotDrawerStock ? nameOr(warehouseById.get(lotDrawerStock.warehouseId)?.name, '仓库') : ''}
        onClose={() => setLotDrawerStock(null)}
      />
    </div>
  );
}

function Metric({ title, value, suffix, alert, money: isMoney }: { title: string; value: number; suffix?: string; alert?: boolean; money?: boolean }) {
  return (
    <Card style={{ height: '100%' }} styles={{ body: { padding: 16 } }}>
      <Statistic
        title={title}
        value={isMoney ? value / 100 : value}
        precision={isMoney ? 2 : 0}
        prefix={isMoney ? '¥' : undefined}
        valueStyle={alert && value > 0 ? { color: '#cf1322' } : undefined}
      />
      {suffix && <Text type="secondary" style={{ fontSize: 12 }}>{suffix}</Text>}
    </Card>
  );
}

const LOT_SOURCE_LABELS: Record<string, string> = {
  goods_receipt: '采购入库',
  general_receipt: '一般入库',
  transfer_order: '调拨入库',
  stock_adjust: '盘盈',
  legacy_stock: '老库存兜底',
};

const REF_TYPE_LABELS: Record<string, string> = {
  work_order: '工单',
  goods_receipt: '采购入库单',
  general_receipt: '一般入库单',
  transfer_order: '调拨单',
  stock: '库存盘点',
};

const MOVEMENT_TYPE_LABELS: Record<string, string> = {
  inbound: '入库',
  outbound: '领料出库',
  transfer: '调拨',
  adjust: '盘点调整',
};

/**
 * 某条库存的批次 + 流水抽屉。
 * 批次按先进先出顺序列（最早入库的排最前，出库先扣它）；流水最新在前。
 * 为什么要有：不同批次单价不同，不看批次就解释不了「同一个东西这次领料为什么比上次贵」。
 */
function StockLotDrawer({ stock, material, warehouseName, onClose }: {
  stock: StockRow | null;
  material?: MaterialRow;
  warehouseName: string;
  onClose: () => void;
}) {
  const { message } = AntdApp.useApp();
  const [lots, setLots] = useState<StockLotView[]>([]);
  const [movements, setMovements] = useState<StockMovementView[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!stock) return;
    let cancelled = false;
    setLoading(true);
    Promise.all([
      request<StockLotView[]>({ url: `/stocks/${stock.id}/lots` }),
      request<StockMovementView[]>({
        url: '/stock-movements',
        query: { warehouseId: stock.warehouseId, materialId: stock.materialId, limit: 100 } as any,
      }),
    ])
      .then(([lotRows, movementRows]) => {
        if (cancelled) return;
        setLots(lotRows);
        setMovements(movementRows);
      })
      .catch((e: any) => { if (!cancelled) message.error(e?.message || '加载批次失败'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [stock?.id]);

  const unit = material?.unit || '';
  const remainingLots = lots.filter((lot) => numberQty(lot.remainingQty) > 0);
  const lotValue = remainingLots.reduce((sum, lot) => sum + numberQty(lot.remainingQty) * lot.unitCostCents, 0);

  return (
    <Drawer
      title={stock ? `批次与流水 · ${materialDisplayName(material)} · ${warehouseName}` : ''}
      open={!!stock}
      onClose={onClose}
      width={880}
      destroyOnHidden
    >
      <Space size={24} wrap style={{ marginBottom: 16 }}>
        <Statistic title="当前库存" value={numberQty(stock?.qty)} suffix={unit} />
        <Statistic title="剩余批次" value={remainingLots.length} suffix="批" />
        <Statistic title="批次金额" value={lotValue / 100} precision={2} prefix="¥" />
      </Space>
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
        message="同一材料不同价格的入库各记一批，领料按先进先出扣最早那批，成本取该批单价，之后再入贵的货也不改历史工单的成本。"
      />
      <Title level={5} style={{ marginTop: 0 }}>入库批次（先进先出顺序）</Title>
      <Table<StockLotView>
        rowKey="id"
        size="small"
        loading={loading}
        dataSource={lots}
        pagination={false}
        scroll={{ x: 760 }}
        rowClassName={(lot) => (numberQty(lot.remainingQty) > 0 ? '' : 'pms-row-muted')}
        columns={[
          { title: '批次号', dataIndex: 'lotNo', width: 200 },
          { title: '来源', dataIndex: 'sourceType', width: 110, render: (v) => LOT_SOURCE_LABELS[v || ''] || v || '-' },
          { title: '入库时间', dataIndex: 'receivedAt', width: 160, render: (v) => formatDateTimeCn(v) },
          { title: '入库数量', dataIndex: 'initialQty', width: 100, align: 'right', render: (v) => `${numberQty(v)} ${unit}` },
          { title: '剩余', dataIndex: 'remainingQty', width: 100, align: 'right', render: (v) => numberQty(v) > 0 ? <b>{numberQty(v)} {unit}</b> : <Text type="secondary">已用完</Text> },
          { title: '单价', dataIndex: 'unitCostCents', width: 100, align: 'right', render: money },
          { title: '剩余金额', key: 'amount', width: 110, align: 'right', render: (_, lot) => money(numberQty(lot.remainingQty) * lot.unitCostCents) },
        ]}
        locale={{ emptyText: '还没有入库批次；老库存会在第一次出库时自动按参考成本补一批' }}
      />
      <Divider />
      <Title level={5}>出入库流水（最近 100 条）</Title>
      <Table<StockMovementView>
        rowKey="id"
        size="small"
        loading={loading}
        dataSource={movements}
        pagination={{ pageSize: 20, size: 'small' }}
        scroll={{ x: 760 }}
        columns={[
          { title: '时间', dataIndex: 'createdAt', width: 160, render: (v) => formatDateTimeCn(v) },
          { title: '类型', dataIndex: 'type', width: 100, render: (v) => MOVEMENT_TYPE_LABELS[v] || v },
          {
            title: '数量',
            dataIndex: 'qty',
            width: 110,
            align: 'right',
            render: (v) => {
              const n = numberQty(v);
              return <span style={{ color: n < 0 ? '#cf1322' : '#3f8600' }}>{n > 0 ? '+' : ''}{n} {unit}</span>;
            },
          },
          { title: '单价', dataIndex: 'unitCostCents', width: 100, align: 'right', render: money },
          { title: '金额', key: 'amount', width: 110, align: 'right', render: (_, row) => money(Math.abs(numberQty(row.qty)) * row.unitCostCents) },
          {
            // 单号由服务端带下来（refNo）；没有单号的老流水只写单据类型，不写内部 id
            title: '来源单据', key: 'ref', width: 190, ellipsis: true,
            render: (_, row) => {
              if (!row.refType) return '-';
              const label = REF_TYPE_LABELS[row.refType] || row.refType;
              return row.refNo ? `${label} ${row.refNo}` : label;
            },
          },
          { title: '备注', dataIndex: 'note', ellipsis: true, render: (v) => v || '-' },
        ]}
      />
    </Drawer>
  );
}

/**
 * 材料类别档案（后台可增删改）。
 *
 * 两条规矩直接写在界面上，别等用户点了才弹错：
 * · **编码前缀决定新建材料的编码**（五金 → WJ-0001），这个类别一旦发出过编码就锁死 ——
 *   编码已经贴在实物上、印在单据里，改前缀会让老编码解释不了自己属于谁。
 * · **用着的类别不给删，只能停用**：停用后新建材料选不到它，已有的材料照常显示。
 *   改名是安全的，服务端会把这个类别下的材料一起改过去。
 */
function MaterialCategoryPanel({ rows, canEdit, canDelete, onChanged }: {
  rows: MaterialCategoryView[];
  canEdit: boolean;
  canDelete: boolean;
  onChanged: () => void;
}) {
  const { message, modal } = AntdApp.useApp();
  const [editing, setEditing] = useState<MaterialCategoryView | null>(null);
  const [creating, setCreating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form] = Form.useForm();

  const open = (row: MaterialCategoryView | null) => {
    setEditing(row);
    setCreating(!row);
    form.resetFields();
    form.setFieldsValue(row
      ? { label: row.label, code: row.code, sortOrder: row.sortOrder, enabled: row.enabled }
      : { enabled: true, sortOrder: (rows.length + 1) * 10 });
  };
  const close = () => { setEditing(null); setCreating(false); };

  const submit = async () => {
    const v = await form.validateFields();
    setSaving(true);
    try {
      await request({
        method: editing ? 'PATCH' : 'POST',
        url: editing ? `/material-categories/${editing.id}` : '/material-categories',
        data: {
          label: v.label?.trim(),
          code: v.code?.trim().toUpperCase(),
          sortOrder: v.sortOrder ?? 0,
          enabled: v.enabled ?? true,
        },
      });
      message.success(editing ? '类别已更新' : '类别已新增');
      close();
      onChanged();
    } catch (e: any) {
      message.error(e?.message || '保存失败');
    } finally {
      setSaving(false);
    }
  };

  const remove = (row: MaterialCategoryView) => {
    modal.confirm({
      title: `删除类别「${row.label}」？`,
      content: '删除后这个类别不再出现在任何下拉里。已经有材料在用的类别删不掉，请改成停用。',
      okButtonProps: { danger: true },
      onOk: async () => {
        try {
          await request({ method: 'DELETE', url: `/material-categories/${row.id}` });
          message.success('已删除');
          onChanged();
        } catch (e: any) {
          message.error(e?.message || '删除失败');
        }
      },
    });
  };

  return (
    <>
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 12 }}
        message="类别决定新建材料的编码前缀：选「五金」新建出来的就是 WJ-0001。已经发出过编码的类别不能再改前缀；有材料在用的类别不能删，请改成停用。改名是安全的，这个类别下的材料会一起改过去。"
      />
      <Space style={{ width: '100%', justifyContent: 'flex-end', marginBottom: 12 }}>
        {canEdit && <Button size="small" icon={<PlusOutlined />} onClick={() => open(null)}>新增类别</Button>}
      </Space>
      <Table
        rowKey="id"
        size="small"
        dataSource={rows}
        pagination={false}
        columns={[
          { title: '排序', dataIndex: 'sortOrder', width: 80 },
          { title: '类别名称', dataIndex: 'label', width: 160, render: (v, row) => (
            <Space size={4}><span style={{ fontWeight: 600 }}>{v}</span>{!row.enabled && <Tag>停用</Tag>}</Space>
          ) },
          { title: '编码前缀', dataIndex: 'code', width: 120, render: (v) => <Tag color="blue">{v}-</Tag> },
          { title: '在用材料', dataIndex: 'materialCount', width: 110, render: (v) => v ? `${v} 条` : <Text type="secondary">未使用</Text> },
          {
            title: '操作', key: 'op', width: 140,
            render: (_, row) => (
              <Space size={0}>
                {canEdit && <Button type="link" size="small" onClick={() => open(row)}>编辑</Button>}
                {canDelete && (
                  <Tooltip title={row.materialCount ? '有材料在用，删不掉；请改成停用' : ''}>
                    <Button type="link" size="small" danger disabled={!!row.materialCount} onClick={() => remove(row)}>删除</Button>
                  </Tooltip>
                )}
              </Space>
            ),
          },
        ]}
      />
      <Modal
        open={creating || !!editing}
        title={editing ? `编辑类别：${editing.label}` : '新增材料类别'}
        onCancel={close}
        onOk={submit}
        confirmLoading={saving}
        destroyOnHidden
      >
        <Form form={form} layout="vertical">
          <Form.Item name="label" label="类别名称" rules={[{ required: true, message: '请输入类别名称' }]}>
            <Input placeholder="如：五金" maxLength={20} />
          </Form.Item>
          <Form.Item
            name="code"
            label="编码前缀"
            tooltip="2~4 位英文字母，决定这个类别下新建材料的编码（WJ → WJ-0001）"
            rules={[
              { required: true, message: '请输入编码前缀' },
              { pattern: /^[A-Za-z]{2,4}$/, message: '只能是 2~4 位英文字母' },
            ]}
            extra={editing && editing.materialCount > 0
              ? `已有 ${editing.materialCount} 条材料用着 ${editing.code}- 开头的编码，前缀不能再改`
              : '定下来之后，一旦这个类别下建过材料就不能改了'}
          >
            <Input placeholder="如：WJ" maxLength={4} disabled={!!editing && editing.materialCount > 0} />
          </Form.Item>
          <Form.Item name="sortOrder" label="排序" tooltip="数字小的排前面，影响下拉和分类快筛的顺序">
            <InputNumber min={0} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="enabled" label="启用" valuePropName="checked" extra="停用后新建材料时选不到它，已有的材料照常显示">
            <Switch />
          </Form.Item>
        </Form>
      </Modal>
    </>
  );
}

function CatalogModal({ kind, form, warehouseLocationOptions, materialCategoryOptions, editingMaterial, editingWarehouse, editingSupplier, saving, onCancel, onOk }: {
  kind: CatalogKind | null;
  form: any;
  /** 类别下拉：服务端的材料类别档案，只含启用中的 */
  materialCategoryOptions: Array<{ value: string; label: string }>;
  /** 正在编辑的这个仓自己的库位，用来选默认入库库位 */
  warehouseLocationOptions: Array<{ value: number; label: string }>;
  editingMaterial: MaterialRow | null;
  editingWarehouse: WarehouseRow | null;
  editingSupplier: SupplierRow | null;
  saving: boolean;
  onCancel: () => void;
  onOk: (values: any) => void;
}) {
  const photoUploading = Form.useWatch('photoUploading', form);
  // 「所属管理处」现取，不用登录时下发的 access.offices —— 那份里没有新建的管理处
  const [offices, setOffices] = useState<Array<{ id: number; name: string }>>([]);
  useEffect(() => {
    if (kind !== 'warehouse') return;
    request<Array<{ id: number; name: string }>>({ url: '/warehouses/offices' })
      .then((list) => setOffices(Array.isArray(list) ? list : []))
      .catch(() => setOffices([]));
  }, [kind]);
  const title = kind === 'material'
    ? editingMaterial ? `编辑材料SKU ${editingMaterial.code}` : '新增材料SKU'
    : kind === 'warehouse'
      ? editingWarehouse ? `编辑仓库：${editingWarehouse.name}` : '新增仓库'
      : editingSupplier ? `编辑供应商：${editingSupplier.name}` : '新增供应商';
  return (
    <Modal
      title={title}
      open={!!kind}
      onCancel={onCancel}
      onOk={() => form.submit()}
      okButtonProps={{ disabled: kind === 'material' && !!photoUploading }}
      confirmLoading={saving}
      destroyOnHidden
    >
      <Form form={form} layout="vertical" onFinish={onOk}>
        {kind === 'material' && (
          <>
            <Row gutter={12}>
              <Col span={12}><Form.Item name="name" label="材料名称" rules={[{ required: true }]}><Input placeholder="如：门禁读卡器" /></Form.Item></Col>
              <Col span={12}><Form.Item name="spec" label="规格"><Input placeholder="如：50*50 / 5W / DN60" /></Form.Item></Col>
            </Row>
            <Row gutter={12}>
              <Col span={12}><Form.Item name="category" label="分类" rules={[{ required: true, message: '请选择材料类别' }]}><Select options={materialCategoryOptions} /></Form.Item></Col>
              <Col span={12}><Form.Item name="unit" label="单位" initialValue="个" rules={[{ required: true, message: '请选择单位' }]}><UnitSelect /></Form.Item></Col>
            </Row>
            <Row gutter={12}>
              <Col span={12}><Form.Item name="defaultCostYuan" label="参考成本（元）" tooltip="入库后自动刷新为剩余批次的加权均价；只用于估价和展示，领料成本按实际入库批次算"><InputNumber min={0} precision={2} style={{ width: '100%' }} /></Form.Item></Col>
            </Row>
            <Form.Item name="photoUploading" hidden><Input /></Form.Item>
            <Form.Item
              name="photoUrls"
              label={`实物照片（最多 ${MATERIAL_PHOTO_LIMIT} 张）`}
              tooltip="正面 / 侧面 / 铭牌 / 包装各一张；第一张作封面，在列表和选料弹层里显示"
            >
              <MaterialPhotosUpload
                onUploadingChange={(uploading) => form.setFieldsValue({ photoUploading: uploading })}
              />
            </Form.Item>
          </>
        )}
        {kind === 'warehouse' && (
          <>
            <Form.Item name="name" label="仓库名称" rules={[{ required: true }]}><Input placeholder="如：总仓 / 枫桦景苑小区仓" /></Form.Item>
            <Row gutter={12}>
              <Col span={12}>
                <Form.Item name="type" label="仓库类型" initialValue={WarehouseType.CENTRAL} rules={[{ required: true }]}>
                  <Select options={[
                    { value: WarehouseType.CENTRAL, label: '总仓（公司级）' },
                    { value: WarehouseType.OFFICE, label: '管理处仓' },
                    // 「小区仓」不再新建：一个管理处一个仓就够，挂到某一个小区会让人
                    // 以为同管理处的其它小区用不了它。老的小区仓仍可编辑，类型照旧显示
                    ...(editingWarehouse?.type === WarehouseType.COMMUNITY
                      ? [{ value: WarehouseType.COMMUNITY, label: '小区仓（旧数据）' }]
                      : []),
                  ]} />
                </Form.Item>
              </Col>
              <Col span={12}>
                <Form.Item
                  name="officeId"
                  label="所属管理处"
                  extra="员工端按自己角色范围对应的管理处默认选这里的仓；留空 = 公司级，只有全公司范围的人会默认它"
                >
                  <Select allowClear placeholder="公司级（不挂管理处）" options={withOptionTitles(offices.map((o) => ({ value: o.id, label: o.name })))} {...searchableWideSelectProps} />
                </Form.Item>
              </Col>
            </Row>
            <Form.Item
              name="defaultLocationId"
              label="默认入库库位"
              extra={
                editingWarehouse
                  ? warehouseLocationOptions.length
                    ? '入库、调拨入库的表单会带出它，仍可逐次改'
                    : '这个仓还没有库位，先用右侧的「库位」按钮加几个'
                  : '库位要先建出来才能选。仓库存好后点列表里的「库位」添加，再回来设默认'
              }
            >
              <Select
                allowClear
                disabled={!editingWarehouse || !warehouseLocationOptions.length}
                placeholder={warehouseLocationOptions.length ? '不指定（入库时手动挑）' : '暂无库位'}
                options={warehouseLocationOptions}
              />
            </Form.Item>
          </>
        )}
        {kind === 'supplier' && (
          <>
            <Form.Item name="name" label="供应商名称" rules={[{ required: true }]}><Input /></Form.Item>
            <Row gutter={12}>
              <Col span={12}><Form.Item name="contactName" label="联系人"><Input /></Form.Item></Col>
              <Col span={12}><Form.Item name="contactPhone" label="联系电话"><Input /></Form.Item></Col>
            </Row>
            <Form.Item name="address" label="地址"><Input /></Form.Item>
            <Row gutter={12}>
              <Col span={8}><Form.Item name="rating" label="评级"><InputNumber min={1} max={5} style={{ width: '100%' }} /></Form.Item></Col>
              <Col span={16}><Form.Item name="note" label="备注"><Input /></Form.Item></Col>
            </Row>
          </>
        )}
      </Form>
    </Modal>
  );
}

function PurchaseOrderModal({ open, form, saving, materialOptions, supplierOptions, onCancel, onOk }: {
  open: boolean;
  form: any;
  saving: boolean;
  materialOptions: Array<{ value: number; label: string }>;
  supplierOptions: Array<{ value: number; label: string }>;
  onCancel: () => void;
  onOk: () => void;
}) {
  return (
    <Modal title="新建采购单" open={open} onCancel={onCancel} onOk={onOk} confirmLoading={saving} width={1120} destroyOnHidden>
      <Alert type="info" showIcon style={{ marginBottom: 12 }} message="从已审批采购申请下单时会自动带入明细；也可以手工录入采购明细。" />
      <Form form={form} layout="vertical" initialValues={{ items: [{}] }}>
        <Row gutter={12}>
          <Col span={8}><Form.Item name="requestId" label="关联采购申请 ID"><InputNumber min={1} style={{ width: '100%' }} disabled /></Form.Item></Col>
          <Col span={16}><Form.Item name="supplierId" label="供应商" rules={[{ required: true }]}><Select {...searchableExtraWideSelectProps} options={supplierOptions} /></Form.Item></Col>
        </Row>
        <Divider orientation="left">采购明细</Divider>
        <Form.List name="items">
          {(fields, { add, remove }) => (
            <Space direction="vertical" style={{ width: '100%' }}>
              {fields.map((field) => (
                <Row key={field.key} gutter={8} align="middle">
                  <Col span={17}><Form.Item name={[field.name, 'materialId']} rules={[{ required: true, message: '请选择材料' }]} noStyle><Select {...searchableExtraWideSelectProps} placeholder="材料" options={materialOptions} /></Form.Item></Col>
                  <Col span={3}><Form.Item name={[field.name, 'qty']} rules={[{ required: true, message: '数量' }]} noStyle><InputNumber min={0.01} placeholder="数量" style={{ width: '100%' }} /></Form.Item></Col>
                  <Col span={3}><Form.Item name={[field.name, 'unitCostYuan']} rules={[{ required: true, message: '单价' }]} noStyle><InputNumber min={0} precision={2} placeholder="单价" style={{ width: '100%' }} /></Form.Item></Col>
                  <Col span={1}><Button danger size="small" onClick={() => remove(field.name)}>删</Button></Col>
                </Row>
              ))}
              <Button type="dashed" block onClick={() => add({})}>+ 增加材料</Button>
            </Space>
          )}
        </Form.List>
      </Form>
    </Modal>
  );
}

/**
 * 选了入库仓之后，把还空着的行填上该仓的「默认入库库位」。
 * 已经手动挑过的行不动 —— 默认值是省事的，不是覆盖人的选择。
 */
function useApplyDefaultLocation(
  form: any,
  warehouseId: number | undefined,
  defaultLocationByWarehouse: Map<number, number | null>,
) {
  useEffect(() => {
    if (!warehouseId) return;
    const fallback = defaultLocationByWarehouse.get(warehouseId) ?? null;
    if (!fallback) return;
    const items = form.getFieldValue('items');
    if (!Array.isArray(items) || !items.length) return;
    if (items.every((item: any) => item?.locationId)) return;
    form.setFieldsValue({
      items: items.map((item: any) => ({ ...item, locationId: item?.locationId ?? fallback })),
    });
  }, [warehouseId, defaultLocationByWarehouse, form]);
}

function ReceiptModal({ order, form, saving, materialById, warehouseOptions, locationOptionsByWarehouse, defaultLocationByWarehouse, onCancel, onOk }: {
  order: PurchaseOrderRow | null;
  form: any;
  saving: boolean;
  materialById: Map<number, MaterialRow>;
  warehouseOptions: Array<{ value: number; label: string }>;
  locationOptionsByWarehouse: Map<number, Array<{ value: number; label: string }>>;
  defaultLocationByWarehouse: Map<number, number | null>;
  onCancel: () => void;
  onOk: () => void;
}) {
  const warehouseId = Form.useWatch('warehouseId', form);
  const locationOptions = warehouseId ? (locationOptionsByWarehouse.get(warehouseId) || []) : [];
  useApplyDefaultLocation(form, warehouseId, defaultLocationByWarehouse);
  return (
    <Modal title={`采购单入库 ${order?.orderNo || ''}`} open={!!order} onCancel={onCancel} onOk={onOk} confirmLoading={saving} width={860} destroyOnHidden>
      <Alert type="info" showIcon style={{ marginBottom: 12 }} message="核对实收数量（可与订购数量不同，差异会自动提醒采购经理与办公室），并选择存放库位。实物照片选填，可事后在材料档案里补。" />
      <Form form={form} layout="vertical">
        <Form.Item name="purchaseOrderId" hidden><InputNumber /></Form.Item>
        <Form.Item name="warehouseId" label="入库仓库" rules={[{ required: true, message: '请选择入库仓库' }]}>
          <Select {...searchableWideSelectProps} options={warehouseOptions} placeholder="常规入总仓；供应商直送小区的选对应小区仓" />
        </Form.Item>
        {warehouseId && !locationOptions.length && (
          <Alert type="warning" showIcon style={{ marginBottom: 12 }} message="该仓库尚未配置库位，可先在「基础资料 → 仓库档案 → 库位」中添加。库位为选填。" />
        )}
        <Form.List name="items">
          {(fields) => (
            <Space direction="vertical" style={{ width: '100%' }} size={16}>
              {fields.map((field) => {
                const item = form.getFieldValue(['items', field.name]);
                const material = materialById.get(item?.materialId);
                return (
                  <Card key={field.key} size="small" style={{ background: '#fafafa' }}>
                    <div style={{ fontWeight: 600, marginBottom: 8 }}>
                      {material ? `${material.code} · ${materialDisplayName(material)}` : unknown('材料')}
                      <Text type="secondary" style={{ fontWeight: 400, marginLeft: 8 }}>订购 {item?.orderedQty} {material?.unit || ''}</Text>
                    </div>
                    <Form.Item name={[field.name, 'materialId']} hidden><InputNumber /></Form.Item>
                    <Form.Item name={[field.name, 'orderedQty']} hidden><InputNumber /></Form.Item>
                    <Row gutter={8}>
                      <Col span={8}><Form.Item name={[field.name, 'qty']} label="实收数量" rules={[{ required: true, message: '请填实收' }]}><InputNumber min={0.01} style={{ width: '100%' }} /></Form.Item></Col>
                      <Col span={8}><Form.Item name={[field.name, 'unitCostYuan']} label="入库单价(元)" rules={[{ required: true, message: '请填单价' }]}><InputNumber min={0} precision={2} style={{ width: '100%' }} /></Form.Item></Col>
                      <Col span={8}><Form.Item name={[field.name, 'locationId']} label="存放库位"><Select allowClear options={locationOptions} placeholder="选择库位" /></Form.Item></Col>
                    </Row>
                    <Form.Item name={[field.name, 'photoUrls']} label="实物照片（选填，可事后补）" style={{ marginBottom: 0 }}>
                      <MultiPhotoUpload />
                    </Form.Item>
                  </Card>
                );
              })}
            </Space>
          )}
        </Form.List>
      </Form>
    </Modal>
  );
}

function GeneralReceiptModal({ open, form, saving, materialOptions, warehouseOptions, locationOptionsByWarehouse, defaultLocationByWarehouse, onCancel, onOk }: {
  open: boolean;
  form: any;
  saving: boolean;
  materialOptions: Array<{ value: number; label: string }>;
  warehouseOptions: Array<{ value: number; label: string }>;
  locationOptionsByWarehouse: Map<number, Array<{ value: number; label: string }>>;
  defaultLocationByWarehouse: Map<number, number | null>;
  onCancel: () => void;
  onOk: () => void;
}) {
  const warehouseId = Form.useWatch('warehouseId', form);
  const locationOptions = warehouseId ? (locationOptionsByWarehouse.get(warehouseId) || []) : [];
  useApplyDefaultLocation(form, warehouseId, defaultLocationByWarehouse);
  return (
    <Modal title="一般入库（无采购单）" open={open} onCancel={onCancel} onOk={onOk} confirmLoading={saving} width={860} destroyOnHidden>
      <Alert type="info" showIcon style={{ marginBottom: 12 }} message="零星采买（如五金店临时采购）走此入口：填写来源、上传凭证，逐项从材料库选择。实物照片选填，可事后补。材料只能从 SKU 库选择，没有请先到「材料 SKU 库」新增。" />
      <Form form={form} layout="vertical">
        <Row gutter={12}>
          <Col span={12}><Form.Item name="warehouseId" label="入库仓库" rules={[{ required: true, message: '请选择入库仓库' }]}><Select {...searchableWideSelectProps} options={warehouseOptions} /></Form.Item></Col>
          <Col span={12}><Form.Item name="sourceText" label="材料来源" rules={[{ required: true, message: '请填写来源' }]}><Input placeholder="如：XX五金店临时采购" /></Form.Item></Col>
        </Row>
        <Form.Item name="attachments" label="相关附件（请上传小票照片或发票 PDF）">
          <AttachmentsUpload />
        </Form.Item>
        <Divider orientation="left">入库材料</Divider>
        <Form.List name="items">
          {(fields, { add, remove }) => (
            <Space direction="vertical" style={{ width: '100%' }} size={16}>
              {fields.map((field) => (
                <Card key={field.key} size="small" style={{ background: '#fafafa' }}
                  extra={<Button danger size="small" onClick={() => remove(field.name)}>删除</Button>}>
                  <Row gutter={8}>
                    <Col span={24}><Form.Item name={[field.name, 'materialId']} label="材料" rules={[{ required: true, message: '请选择材料' }]}><Select {...searchableExtraWideSelectProps} options={materialOptions} placeholder="从材料库搜索选择" /></Form.Item></Col>
                  </Row>
                  <Row gutter={8}>
                    <Col span={8}><Form.Item name={[field.name, 'qty']} label="数量" rules={[{ required: true, message: '请填数量' }]}><InputNumber min={0.01} style={{ width: '100%' }} /></Form.Item></Col>
                    <Col span={8}><Form.Item name={[field.name, 'unitCostYuan']} label="单价(元)" rules={[{ required: true, message: '请填单价' }]}><InputNumber min={0} precision={2} style={{ width: '100%' }} /></Form.Item></Col>
                    <Col span={8}><Form.Item name={[field.name, 'locationId']} label="存放库位"><Select allowClear options={locationOptions} placeholder="选择库位" /></Form.Item></Col>
                  </Row>
                  <Form.Item name={[field.name, 'photoUrls']} label="实物照片（选填，可事后补）" style={{ marginBottom: 0 }}>
                    <MultiPhotoUpload />
                  </Form.Item>
                </Card>
              ))}
              <Button type="dashed" block onClick={() => add({ photoUrls: [] })}>+ 增加材料</Button>
            </Space>
          )}
        </Form.List>
      </Form>
    </Modal>
  );
}

function LocationConfigModal({ warehouse, locations, onClose, onChanged }: {
  warehouse: WarehouseRow | null;
  locations: WarehouseLocationRow[];
  onClose: () => void;
  onChanged: () => void;
}) {
  const { message } = AntdApp.useApp();
  const [form] = Form.useForm();
  const [saving, setSaving] = useState(false);

  const addLocation = async () => {
    const v = await form.validateFields();
    setSaving(true);
    try {
      await request({
        method: 'POST',
        url: '/warehouse-locations',
        data: { warehouseId: warehouse!.id, zone: v.zone, shelf: v.shelf, bin: v.bin },
      });
      message.success('库位已添加');
      form.resetFields();
      onChanged();
    } catch (e: any) {
      message.error(e?.message || '添加失败');
    } finally {
      setSaving(false);
    }
  };

  const toggleLocation = async (loc: WarehouseLocationRow) => {
    try {
      await request({ method: 'PATCH', url: `/warehouse-locations/${loc.id}`, data: { enabled: !loc.enabled } });
      onChanged();
    } catch (e: any) {
      message.error(e?.message || '操作失败');
    }
  };

  return (
    <Modal
      title={warehouse ? `库位配置 · ${warehouse.name}` : '库位配置'}
      open={!!warehouse}
      onCancel={onClose}
      footer={<Button onClick={onClose}>关闭</Button>}
      width={620}
      destroyOnHidden
    >
      <Alert type="info" showIcon style={{ marginBottom: 12 }} message="预先建好库区-货架-货位，入库时可直接选择存放位置。三项可只填其一。" />
      <Form form={form} layout="inline" style={{ marginBottom: 16 }}>
        <Form.Item name="zone"><Input placeholder="库区（如 A区）" style={{ width: 130 }} /></Form.Item>
        <Form.Item name="shelf"><Input placeholder="货架（如 03架）" style={{ width: 130 }} /></Form.Item>
        <Form.Item name="bin"><Input placeholder="货位（如 2层）" style={{ width: 130 }} /></Form.Item>
        <Button type="primary" loading={saving} onClick={addLocation}>添加</Button>
      </Form>
      <Table
        rowKey="id"
        size="small"
        dataSource={locations}
        pagination={false}
        columns={[
          { title: '库位', dataIndex: 'label' },
          { title: '状态', dataIndex: 'enabled', width: 90, render: (v) => v ? <Tag color="green">启用</Tag> : <Tag>停用</Tag> },
          {
            title: '操作',
            key: 'op',
            width: 90,
            render: (_, row) => <Button size="small" type="link" danger={row.enabled} onClick={() => toggleLocation(row)}>{row.enabled ? '停用' : '启用'}</Button>,
          },
        ]}
      />
    </Modal>
  );
}

/** 多图上传（value/onChange 为 string[]，供 Form.Item 使用） */
function MultiPhotoUpload({ value, onChange }: { value?: string[]; onChange?: (urls: string[]) => void }) {
  const { message } = AntdApp.useApp();
  const urls = value || [];
  const uploadProps: UploadProps<UploadResponse> = {
    name: 'file',
    action: `${API_BASE_URL}/upload`,
    headers: auth.getToken() ? { Authorization: `Bearer ${auth.getToken()}` } : undefined,
    accept: 'image/*',
    multiple: true,
    showUploadList: false,
    beforeUpload: async (file) => {
      if (!/^image\//i.test(file.type || '')) { message.error('只能上传照片'); return Upload.LIST_IGNORE; }
      if (file.size / 1024 / 1024 > 10) { message.error('照片不能超过 10MB'); return Upload.LIST_IGNORE; }
      return compressImageFile(file);
    },
    onChange: ({ file }) => {
      if (file.status === 'done') {
        const url = file.response?.displayUrl || (file.response?.objectKey ? uploadFileUrl(file.response.objectKey) : file.response?.publicUrl);
        if (url) onChange?.([...urls, normalizePhotoUrl(url)]);
      } else if (file.status === 'error') {
        message.error(`${file.name} 上传失败`);
      }
    },
  };
  return (
    <Space wrap>
      {urls.map((url, index) => (
        <div key={url} style={{ position: 'relative' }}>
          <Image src={imageSrc(url)} width={72} height={72} style={{ objectFit: 'cover', borderRadius: 6 }} />
          <Button size="small" danger style={{ position: 'absolute', top: -8, right: -8, padding: '0 6px' }}
            onClick={() => onChange?.(urls.filter((_, i) => i !== index))}>×</Button>
        </div>
      ))}
      <Upload {...uploadProps}>
        <div style={{ width: 72, height: 72, border: '1px dashed #bbb', borderRadius: 6, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', color: '#888' }}>
          <UploadOutlined />
          <span style={{ fontSize: 12 }}>上传</span>
        </div>
      </Upload>
    </Space>
  );
}

/** 附件上传（图片或 PDF，value/onChange 为 string[]） */
function AttachmentsUpload({ value, onChange }: { value?: string[]; onChange?: (urls: string[]) => void }) {
  const { message } = AntdApp.useApp();
  const urls = value || [];
  const uploadProps: UploadProps<UploadResponse> = {
    name: 'file',
    action: `${API_BASE_URL}/upload`,
    headers: auth.getToken() ? { Authorization: `Bearer ${auth.getToken()}` } : undefined,
    accept: 'image/*,application/pdf',
    multiple: true,
    showUploadList: false,
    beforeUpload: async (file) => {
      const ok = /^image\//i.test(file.type || '') || file.type === 'application/pdf';
      if (!ok) { message.error('只能上传图片或 PDF'); return Upload.LIST_IGNORE; }
      if (file.size / 1024 / 1024 > 20) { message.error('附件不能超过 20MB'); return Upload.LIST_IGNORE; }
      // PDF 原样传，只有图片走压缩（compressImageFile 自己会判类型）
      return compressImageFile(file);
    },
    onChange: ({ file }) => {
      if (file.status === 'done') {
        const url = file.response?.displayUrl || (file.response?.objectKey ? uploadFileUrl(file.response.objectKey) : file.response?.publicUrl);
        if (url) onChange?.([...urls, normalizePhotoUrl(url)]);
      } else if (file.status === 'error') {
        message.error(`${file.name} 上传失败`);
      }
    },
  };
  return (
    <Space direction="vertical" style={{ width: '100%' }}>
      {urls.map((url, index) => (
        <Space key={url}>
          <Text style={{ maxWidth: 320 }} ellipsis>{url.toLowerCase().includes('.pdf') ? '📄 PDF 凭证' : '🖼 图片凭证'} {index + 1}</Text>
          <Button size="small" danger type="link" onClick={() => onChange?.(urls.filter((_, i) => i !== index))}>移除</Button>
        </Space>
      ))}
      <Upload {...uploadProps}>
        <Button icon={<UploadOutlined />}>上传附件</Button>
      </Upload>
    </Space>
  );
}

function TransferModal({ open, form, saving, materialOptions, warehouseOptions, onCancel, onOk }: {
  open: boolean;
  form: any;
  saving: boolean;
  materialOptions: Array<{ value: number; label: string }>;
  warehouseOptions: Array<{ value: number; label: string }>;
  onCancel: () => void;
  onOk: () => void;
}) {
  return (
    <Modal title="新建仓库调拨" open={open} onCancel={onCancel} onOk={onOk} confirmLoading={saving} width={920} destroyOnHidden>
      <Form form={form} layout="vertical" initialValues={{ items: [{}] }}>
        <Row gutter={12}>
          <Col span={12}><Form.Item name="fromWarehouseId" label="出库仓" rules={[{ required: true }]}><Select {...searchableWideSelectProps} options={warehouseOptions} /></Form.Item></Col>
          <Col span={12}><Form.Item name="toWarehouseId" label="入库仓" rules={[{ required: true }]}><Select {...searchableWideSelectProps} options={warehouseOptions} /></Form.Item></Col>
        </Row>
        <Form.List name="items">
          {(fields, { add, remove }) => (
            <Space direction="vertical" style={{ width: '100%' }}>
              {fields.map((field) => (
                <Row key={field.key} gutter={8}>
                  <Col span={18}><Form.Item name={[field.name, 'materialId']} rules={[{ required: true }]} noStyle><Select {...searchableWideSelectProps} options={materialOptions} placeholder="材料" /></Form.Item></Col>
                  <Col span={4}><Form.Item name={[field.name, 'qty']} rules={[{ required: true }]} noStyle><InputNumber min={0.01} placeholder="数量" style={{ width: '100%' }} /></Form.Item></Col>
                  <Col span={2}><Button danger size="small" onClick={() => remove(field.name)}>删</Button></Col>
                </Row>
              ))}
              <Button type="dashed" block onClick={() => add({})}>+ 增加材料</Button>
            </Space>
          )}
        </Form.List>
      </Form>
    </Modal>
  );
}
