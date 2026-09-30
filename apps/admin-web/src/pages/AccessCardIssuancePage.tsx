import {
  Alert,
  Button,
  Card,
  Col,
  Descriptions,
  Empty,
  Flex,
  Input,
  Modal,
  Row,
  Select,
  Skeleton,
  Space,
  Table,
  Tag,
  Typography,
  message,
} from 'antd';
import {
  CheckCircleOutlined,
  CreditCardOutlined,
  DatabaseOutlined,
  EllipsisOutlined,
  ExperimentOutlined,
  LeftOutlined,
  MinusOutlined,
  PlusOutlined,
  ReloadOutlined,
  SafetyCertificateOutlined,
  UsbOutlined,
  WarningOutlined,
} from '@ant-design/icons';
import {
  accessCardIssuance,
  address as addressApi,
  type AccessCardHistoryRow,
  type AccessCardHouseContext,
  type AccessCardIssueBatch,
  type AccessCardPermissionResult,
  type AccessCardReadiness,
} from '@pms/api-client';
import type { AddressCommunity } from '@pms/shared-types';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import CopyableSecret from '../components/CopyableSecret';
import HouseAddressPicker, { type PickedAddress } from '../components/HouseAddressPicker';

const { Text, Title } = Typography;

const PREVIEW_CONTEXT: AccessCardHouseContext = {
  house: {
    id: 1,
    roomNo: '301',
    communityId: 228,
    communityName: '枫桦景苑二期',
    buildingId: 5,
    buildingNo: '5',
    lane: '228',
    roomKey: '228/5/301',
    displayAddress: '枫桦景苑二期 · 5号楼 · 301室',
  },
  projectPhase: 'phase2',
  accessSystem: 'mjsystem',
  routeReady: true,
  availableBuildings: [
    { id: 5, buildingNo: '5', accessSystem: 'mjsystem', routeReady: true },
    { id: 9, buildingNo: '9', accessSystem: 'mjsystem', routeReady: true },
    { id: 11, buildingNo: '11', accessSystem: 'iccard', routeReady: true },
  ],
  issuedCount: 3,
  nextSequence: 4,
  history: [
    { id: 3, sequence: 3, legacyPersonNo: null, icCardNo: 'A1B2C3D4', wgCardNo: '19545729', issuedAt: new Date().toISOString(), accessStatus: 'controller_uploaded', legacySyncStatus: 'pending', controllerResults: [
      { wgCardNo: '19545729', accessSystem: 'iccard', buildingNo: '4', controller: '4号楼控制器', door: '4号大门', sourceTable: 't_d_Privilege' },
      { wgCardNo: '19545729', accessSystem: 'iccard', buildingNo: '11', controller: '11号楼控制器', door: '11号大门', sourceTable: 't_d_Privilege' },
      { wgCardNo: '19545729', accessSystem: 'iccard', buildingNo: '41', controller: '41号楼控制器', door: '41号大门', sourceTable: 't_d_Privilege' },
      { wgCardNo: '19545729', accessSystem: 'iccard', buildingNo: '53', controller: '53号楼控制器', door: '53号大门', sourceTable: 't_d_Privilege' },
    ] },
    { id: 2, sequence: 2, legacyPersonNo: '11251', icCardNo: '11223344', wgCardNo: '05108721', issuedAt: '2026-09-22T02:20:00.000Z', accessStatus: 'not_uploaded', legacySyncStatus: 'synced', controllerResults: [] },
    { id: 1, sequence: 1, legacyPersonNo: '10982', icCardNo: '0A1B2C3D', wgCardNo: '04406922', issuedAt: '2025-12-16T01:08:00.000Z', accessStatus: 'controller_uploaded', legacySyncStatus: 'synced', controllerResults: [{ wgCardNo: '04406922', accessSystem: 'mjsystem', buildingNo: '3', controller: '3号楼控制器', door: '3号楼大门', sourceTable: 'MJ_MacPower' }] },
  ],
  historySources: { pms: true, legacy80: true, accessPermissions: true, accessPermissionsMessage: '已按门禁权限表核验 3 张卡', message: '已合并 192.168.1.80 历史记录' },
};

const PREVIEW_READINESS: AccessCardReadiness = {
  simulationEnabled: true,
  features: { cardWrite: false, legacyDbWrite: false, accessDbWrite: false, parkingDbRead: true, parkingDbWrite: false, controllerUpload: false },
  agents: [],
};

function newIdempotencyKey(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `access-card-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function formatTime(value: string | null): string {
  if (!value) return '—';
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime())
    ? value
    : parsed.toLocaleString('zh-CN', { hour12: false });
}

function systemLabel(value: AccessCardHouseContext['accessSystem']): string {
  if (value === 'mjsystem') return 'MjSystem';
  if (value === 'iccard') return 'iCCard';
  return '只写卡';
}

function accessStatus(value: string) {
  if (value === 'not_required') return <Tag>不适用</Tag>;
  if (value === 'controller_uploaded') return <Tag color="success">已上传</Tag>;
  if (value === 'not_uploaded') return <Tag color="error">未上传</Tag>;
  if (value === 'permission_check_pending') return <Tag color="processing">权限核验中</Tag>;
  if (value === 'permission_check_failed') return <Tag color="error">权限核验失败</Tag>;
  if (value === 'waiting_retry') return <Tag color="error">下载失败 · 门禁控制器离线</Tag>;
  if (value === 'needs_operator') return <Tag color="error">下载失败 · 需要处理</Tag>;
  return <Tag color="processing">处理中</Tag>;
}

function permissionLabel(item: AccessCardPermissionResult): string {
  if (item.buildingNo) return `${item.buildingNo}号楼`;
  return item.door || item.controller || '未命名门禁';
}

function ControllerPermissionCell({ row }: { row: AccessCardHistoryRow }) {
  const [expanded, setExpanded] = useState(false);
  const permissions = useMemo(() => {
    const unique = new Map<string, AccessCardPermissionResult>();
    for (const item of row.controllerResults ?? []) {
      const label = permissionLabel(item);
      if (!unique.has(label)) unique.set(label, item);
    }
    return Array.from(unique.values()).sort((a, b) =>
      permissionLabel(a).localeCompare(permissionLabel(b), 'zh-Hans-CN', { numeric: true, sensitivity: 'base' }));
  }, [row.controllerResults]);
  const visible = expanded ? permissions : permissions.slice(0, 2);

  return (
    <Space direction="vertical" size={4}>
      {accessStatus(row.accessStatus)}
      {permissions.length > 0 && (
        <Flex gap={4} wrap="wrap" align="center">
          {visible.map((item) => (
            <Tag
              key={`${item.accessSystem}-${item.buildingNo ?? item.door}`}
              title={`${item.accessSystem === 'iccard' ? 'iCCard' : 'MjSystem'} · ${item.controller || '未记录控制器'} · ${item.door}`}
            >
              {permissionLabel(item)}
            </Tag>
          ))}
          {!expanded && permissions.length > 2 && (
            <Button
              type="link"
              size="small"
              icon={<EllipsisOutlined aria-hidden="true" />}
              aria-label={`展开其余 ${permissions.length - 2} 个门栋权限`}
              aria-expanded={false}
              onClick={() => setExpanded(true)}
            >
              +{permissions.length - 2}
            </Button>
          )}
          {expanded && permissions.length > 2 && (
            <Button
              type="link"
              size="small"
              icon={<LeftOutlined aria-hidden="true" />}
              aria-label="收起门栋权限"
              aria-expanded={true}
              onClick={() => setExpanded(false)}
            >
              收起
            </Button>
          )}
        </Flex>
      )}
    </Space>
  );
}

function legacyStatus(value: string) {
  if (value === 'synced') return <Tag color="success">已同步</Tag>;
  if (value === 'conflict') return <Tag color="error">数据冲突</Tag>;
  if (value === 'waiting_retry') return <Tag color="warning">等待重试</Tag>;
  return <Tag>同步中</Tag>;
}

function HealthTile({
  icon,
  label,
  state,
  detail,
}: {
  icon: React.ReactNode;
  label: string;
  state: 'ready' | 'pending' | 'disabled';
  detail: string;
}) {
  return (
    <div className={`access-card-health is-${state}`}>
      <span>{icon}</span>
      <div>
        <strong>{label}</strong>
        <small>{detail}</small>
      </div>
    </div>
  );
}

export default function AccessCardIssuancePage({ preview = false }: { preview?: boolean }) {
  const [communities, setCommunities] = useState<AddressCommunity[]>([]);
  const [addressValue, setAddressValue] = useState<Array<number | string>>([]);
  const [picked, setPicked] = useState<PickedAddress | null>(preview ? {
    communityId: 228,
    communityName: '枫桦景苑二期',
    buildingId: 5,
    buildingText: '228弄5号',
    houseId: 1,
    roomNo: '301',
    ownerName: '预览住户',
    ownerPhone: null,
    fullText: '枫桦景苑二期/228弄5号/301',
  } : null);
  const [context, setContext] = useState<AccessCardHouseContext | null>(preview ? PREVIEW_CONTEXT : null);
  const [contextLoading, setContextLoading] = useState(false);
  const [contextError, setContextError] = useState('');
  const [readiness, setReadiness] = useState<AccessCardReadiness | null>(preview ? PREVIEW_READINESS : null);
  const [readinessLoading, setReadinessLoading] = useState(false);
  const [quantity, setQuantity] = useState(1);
  const [extraBuildingIds, setExtraBuildingIds] = useState<number[]>([]);
  const [batch, setBatch] = useState<AccessCardIssueBatch | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [simulating, setSimulating] = useState(false);
  const [retryingItemId, setRetryingItemId] = useState<number | null>(null);
  const [agentModalOpen, setAgentModalOpen] = useState(false);
  const [agentKind, setAgentKind] = useState<'issuer' | 'access_gateway' | 'legacy_sync'>('issuer');
  const [agentName, setAgentName] = useState('办公室发卡器接入');
  const [agentEnrolling, setAgentEnrolling] = useState(false);
  const [agentCredential, setAgentCredential] = useState<{ id: string; token: string; message: string } | null>(null);
  const contextRequestRef = useRef(0);

  const loadReadiness = useCallback(async () => {
    setReadinessLoading(true);
    try {
      setReadiness(await accessCardIssuance.readiness());
    } catch (error) {
      message.error(error instanceof Error ? error.message : '设备状态加载失败');
    } finally {
      setReadinessLoading(false);
    }
  }, []);

  useEffect(() => {
    if (preview) return;
    addressApi.tree().then(setCommunities).catch((error) => {
      message.error(error?.message || '房产地址加载失败');
    });
    void loadReadiness();
  }, [loadReadiness, preview]);

  useEffect(() => {
    if (preview || !batch || batch.status === 'completed' || batch.status === 'needs_operator') return;
    let cancelled = false;
    const refresh = async () => {
      try {
        const next = await accessCardIssuance.batch(batch.id);
        if (!cancelled) setBatch(next);
      } catch {
        // 主动任务轮询失败不清空当前进度，下一轮继续。
      }
    };
    const timer = window.setInterval(() => void refresh(), 1_250);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [batch?.id, batch?.status, preview]);

  const loadContext = useCallback(async (
    houseId: number,
    preserveSelection = false,
    silent = false,
    requestId?: number,
  ) => {
    if (!silent) setContextLoading(true);
    setContextError('');
    try {
      const next = await accessCardIssuance.houseContext(houseId);
      if (requestId !== undefined && contextRequestRef.current !== requestId) return null;
      setContext(next);
      if (!preserveSelection) setExtraBuildingIds([]);
      return next;
    } catch (error) {
      if (requestId !== undefined && contextRequestRef.current !== requestId) return null;
      if (!silent) setContext(null);
      setContextError(error instanceof Error ? error.message : '房号信息加载失败');
      return null;
    } finally {
      if (!silent && (requestId === undefined || contextRequestRef.current === requestId)) {
        setContextLoading(false);
      }
    }
  }, []);

  const loadContextUntilLegacyReady = useCallback(async (houseId: number, preserveSelection = false) => {
    const requestId = ++contextRequestRef.current;
    let next = await loadContext(houseId, preserveSelection, false, requestId);
    if (preview) return;
    // The first request creates a local-agent task. Poll only this active selection
    // for a few seconds so the operator does not have to click refresh manually.
    for (let attempt = 0; attempt < 8 && next
      && (!next.historySources.legacy80 || !next.historySources.accessPermissions); attempt += 1) {
      await new Promise((resolve) => window.setTimeout(resolve, 1_250));
      if (contextRequestRef.current !== requestId) return;
      next = await loadContext(houseId, true, true, requestId);
    }
  }, [loadContext, preview]);

  const enrollAgent = async () => {
    if (!agentName.trim()) {
      message.error('请填写这台电脑或网关的名称');
      return;
    }
    setAgentEnrolling(true);
    try {
      if (preview) {
        setAgentCredential({
          id: `${agentKind}-preview12345678`,
          token: '预览环境不会生成真实密钥',
          message: '预览凭据仅用于检查安装说明，不可连接 PMS',
        });
        return;
      }
      const result = await accessCardIssuance.enrollAgent({ kind: agentKind, name: agentName.trim() });
      setAgentCredential({ id: result.id, token: result.token, message: result.message });
      await loadReadiness();
    } catch (error) {
      message.error(error instanceof Error ? error.message : '代理注册失败');
    } finally {
      setAgentEnrolling(false);
    }
  };

  const onPicked = (next: PickedAddress | null) => {
    contextRequestRef.current += 1;
    setPicked(next);
    setBatch(null);
    setContext(null);
    setContextError('');
    setExtraBuildingIds([]);
    if (next?.houseId) void loadContextUntilLegacyReady(next.houseId);
  };

  const issuerAgents = readiness?.agents.filter((item) => item.kind === 'issuer') ?? [];
  const onlineIssuer = issuerAgents.find((item) => item.status === 'online');
  // A computer can be re-registered after replacement or credential rotation.
  // Prefer the currently-online record instead of the oldest record of that kind.
  const accessGateway = readiness?.agents.find((item) => item.kind === 'access_gateway' && item.status === 'online')
    ?? readiness?.agents.find((item) => item.kind === 'access_gateway');
  const legacyAgent = readiness?.agents.find((item) => item.kind === 'legacy_sync' && item.status === 'online')
    ?? readiness?.agents.find((item) => item.kind === 'legacy_sync');
  const canStart = !!context?.routeReady && (!!onlineIssuer || !!readiness?.simulationEnabled);

  const extraOptions = useMemo(
    () => context?.availableBuildings
      .filter((item) => item.id !== context.house.buildingId)
      .map((item) => ({
        value: item.id,
        label: `${context.house.lane ? `${context.house.lane}弄` : ''}${item.buildingNo}号楼 · ${systemLabel(item.accessSystem)}${item.routeReady ? '' : '（未配置）'}`,
        disabled: !item.routeReady,
      })) ?? [],
    [context],
  );

  const refreshContext = async () => {
    if (picked?.houseId) await loadContextUntilLegacyReady(picked.houseId, true);
  };

  const start = async () => {
    if (!picked?.houseId || !context) return;
    if (preview) {
      setBatch({
        id: 9001,
        houseId: picked.houseId,
        addressSnapshot: context.house.roomKey,
        projectPhase: context.projectPhase,
        accessSystem: context.accessSystem,
        quantity,
        status: 'waiting_for_card',
        currentSequence: 1,
        deliverable: false,
        items: Array.from({ length: quantity }, (_, index) => ({
          id: 9100 + index,
          sequence: index + 1,
          cardStatus: 'waiting_for_card',
          accessStatus: context.projectPhase === 'phase1' ? 'not_required' : 'pending',
          legacySyncStatus: 'pending',
          icCardNo: null,
          wgCardNo: null,
          legacyPersonNo: null,
          cardCompletedAt: null,
          lastErrorRef: null,
          lastErrorMessage: null,
          controllerResults: [],
        })),
      });
      message.success('预览任务已建立，请模拟放入第 1 张卡');
      return;
    }
    setSubmitting(true);
    try {
      const created = await accessCardIssuance.createBatch({
        houseId: picked.houseId,
        quantity,
        extraBuildingIds,
        workstationId: onlineIssuer?.id,
        idempotencyKey: newIdempotencyKey(),
      });
      setBatch(created);
      message.success(`发卡任务已建立，请放第 1 张卡`);
    } catch (error) {
      message.error(error instanceof Error ? error.message : '发卡任务创建失败');
    } finally {
      setSubmitting(false);
    }
  };

  const simulateNext = async () => {
    if (!batch) return;
    if (preview) {
      const target = batch.items.find((item) => item.cardStatus !== 'card_completed');
      if (!target) return;
      const icCardNo = `A1B2C3${String(target.sequence).padStart(2, '0')}`;
      const completedAt = new Date().toISOString();
      const items = batch.items.map((item) => item.id === target.id ? {
        ...item,
        cardStatus: 'card_completed',
        accessStatus: batch.projectPhase === 'phase1' ? 'not_required' : 'controller_uploaded',
        icCardNo,
        wgCardNo: batch.projectPhase === 'phase1' ? null : `19545${String(720 + target.sequence).padStart(3, '0')}`,
        cardCompletedAt: completedAt,
      } : item);
      const allDone = items.every((item) => item.cardStatus === 'card_completed');
      setBatch({ ...batch, items, status: allDone ? 'completed' : 'waiting_for_card', deliverable: allDone });
      setContext((current) => current ? {
        ...current,
        issuedCount: current.issuedCount + 1,
        nextSequence: current.nextSequence + 1,
        history: [{
          id: target.id,
          sequence: current.history.length + 1,
          legacyPersonNo: null,
          icCardNo,
          wgCardNo: batch.projectPhase === 'phase1' ? null : `19545${String(720 + target.sequence).padStart(3, '0')}`,
          issuedAt: completedAt,
          accessStatus: batch.projectPhase === 'phase1' ? 'not_required' : 'controller_uploaded',
          legacySyncStatus: 'pending',
          controllerResults: [],
        }, ...current.history],
      } : current);
      message.success(`第 ${target.sequence} 张卡已完成`);
      return;
    }
    setSimulating(true);
    try {
      const next = await accessCardIssuance.simulateNext(batch.id);
      setBatch(next);
      await refreshContext();
      message.success(`第 ${next.items.filter((item) => item.cardStatus === 'card_completed').length} 张卡已完成`);
    } catch (error) {
      message.error(error instanceof Error ? error.message : '模拟写卡失败');
    } finally {
      setSimulating(false);
    }
  };

  const simulateLegacySync = async () => {
    if (!batch) return;
    if (preview) {
      const items = batch.items.map((item) => item.cardStatus === 'card_completed' ? {
        ...item,
        legacyPersonNo: item.legacyPersonNo || String(11251 + item.sequence),
        legacySyncStatus: 'synced',
      } : item);
      setBatch({ ...batch, items });
      setContext((current) => current ? {
        ...current,
        history: current.history.map((item) => item.legacySyncStatus === 'pending' ? {
          ...item,
          legacyPersonNo: item.legacyPersonNo || String(11251 + item.sequence),
          legacySyncStatus: 'synced',
        } : item),
      } : current);
      message.success('已模拟完成 .80 旧库增量同步');
      return;
    }
    setSimulating(true);
    try {
      const next = await accessCardIssuance.simulateLegacySync(batch.id);
      setBatch(next);
      await refreshContext();
      message.success('已模拟完成 .80 旧库增量同步');
    } catch (error) {
      message.error(error instanceof Error ? error.message : '模拟旧库同步失败');
    } finally {
      setSimulating(false);
    }
  };

  const completedCount = batch?.items.filter((item) => item.cardStatus === 'card_completed').length ?? 0;
  const currentSequence = Math.min(completedCount + 1, batch?.quantity ?? 1);
  const duplicateItem = batch?.items.find((item) => item.cardStatus === 'duplicate_card');
  const activeErrorItem = batch?.items.find((item) => item.cardStatus !== 'card_completed' && item.lastErrorMessage);
  const accessFailedItem = batch?.items.find((item) => ['waiting_retry', 'needs_operator'].includes(item.accessStatus));

  const retryAccessUpload = async (itemId: number) => {
    if (!batch) return;
    setRetryingItemId(itemId);
    try {
      const updated = await accessCardIssuance.retryAccessUpload(batch.id, itemId);
      setBatch(updated);
      message.success('已重新提交门禁控制器下载');
    } catch (error: any) {
      message.error(error?.message || '重新提交失败，请稍后重试');
    } finally {
      setRetryingItemId(null);
    }
  };
  const history = (context?.history ?? [])
    .slice()
    .sort((a, b) => {
      const aTime = a.issuedAt ? new Date(a.issuedAt).getTime() : Number.NEGATIVE_INFINITY;
      const bTime = b.issuedAt ? new Date(b.issuedAt).getTime() : Number.NEGATIVE_INFINITY;
      return (Number.isFinite(bTime) ? bTime : Number.NEGATIVE_INFINITY)
        - (Number.isFinite(aTime) ? aTime : Number.NEGATIVE_INFINITY)
        || b.sequence - a.sequence;
    });
  const accessGatewayReady = accessGateway?.status === 'online'
    && accessGateway.capabilities?.accessDbWrite === true
    && accessGateway.capabilities?.controllerUpload === true;
  const accessGatewayDetail = accessGateway?.status !== 'online'
    ? '未接入，不能修改现场数据'
    : accessGateway.capabilities?.accessDbWrite !== true
      ? '网关在线，但门禁数据库不可写'
      : accessGateway.capabilities?.controllerUpload !== true
        ? '数据库已连接，但控制器下发组件未就绪'
        : '数据库和控制器下发均已就绪';

  const columns = [
    { title: '发卡序号', dataIndex: 'sequence', width: 92, fixed: 'left' as const, render: (value: number) => <strong>{value}</strong> },
    { title: '捷顺系统编号', dataIndex: 'legacyPersonNo', width: 136, render: (value: string | null) => value || <Tag>同步中</Tag> },
    { title: 'IC 卡号', dataIndex: 'icCardNo', width: 150, render: (value: string | null) => value || '—' },
    { title: 'WG 卡号', dataIndex: 'wgCardNo', width: 130, render: (value: string | null) => value || <Text type="secondary">不适用</Text> },
    { title: '发卡时间', dataIndex: 'issuedAt', width: 180, render: formatTime },
    { title: '控制器上传 / 门栋权限', key: 'controllerPermissions', width: 300, render: (_: unknown, row: AccessCardHistoryRow) => <ControllerPermissionCell row={row} /> },
    { title: '旧库同步', dataIndex: 'legacySyncStatus', width: 120, render: legacyStatus },
  ];

  return (
    <div className="access-card-page">
      <section className="access-card-hero">
        <div>
          <Tag color="blue">ACR122U 任意工作站发卡</Tag>
          <h1>门禁发卡</h1>
          <p>选择房号后，系统自动区分枫桦景苑一期与二期；一期只写卡，二期自动同步门禁并上传控制器。</p>
        </div>
        <div className="access-card-hero-stat">
          <span>{batch ? '本次进度' : '默认数量'}</span>
          <strong>{batch ? `${completedCount}/${batch.quantity}` : quantity}</strong>
          <small>{batch ? '已完成' : '张'}</small>
        </div>
      </section>

      <Card
        className="access-card-bridge-card"
        title={<Space><SafetyCertificateOutlined />设备与服务</Space>}
        extra={<Space wrap>
          <Button onClick={() => { setAgentCredential(null); setAgentModalOpen(true); }}>注册本地服务</Button>
          <Button icon={<ReloadOutlined />} loading={readinessLoading} onClick={() => void loadReadiness()}>重新检测</Button>
        </Space>}
      >
        <Row gutter={[12, 12]}>
          <Col xs={24} md={8}>
            <HealthTile
              icon={<UsbOutlined />}
              label="办公室发卡器接入"
              state={onlineIssuer ? 'ready' : readiness?.simulationEnabled ? 'pending' : 'disabled'}
              detail={onlineIssuer ? `${onlineIssuer.name} 已连接` : readiness?.simulationEnabled ? '尚未接入，当前可用模拟模式' : '未检测到发卡助手'}
            />
          </Col>
          <Col xs={24} md={8}>
            <HealthTile
              icon={<DatabaseOutlined />}
              label="枫桦一二期小区大门门禁系统接入"
              state={legacyAgent?.status === 'online' ? 'ready' : 'pending'}
              detail={legacyAgent?.status === 'online' ? '增量同步服务在线' : '未接入，发卡后将显示待同步'}
            />
          </Col>
          <Col xs={24} md={8}>
            <HealthTile
              icon={<SafetyCertificateOutlined />}
              label="枫桦二期楼栋门禁系统接入"
              state={accessGatewayReady ? 'ready' : 'pending'}
              detail={accessGatewayDetail}
            />
          </Col>
        </Row>
        {readiness?.simulationEnabled && (
          <Alert
            className="access-card-observe-alert"
            type="info"
            showIcon
            icon={<ExperimentOutlined />}
            message="当前为安全模拟模式"
            description="页面和任务状态会真实保存，但不会写实体卡、旧 SQL、两套 MDB 或现场控制器。"
          />
        )}
      </Card>

      <Card className="access-card-house-card" title="1. 选择房号">
        <Row gutter={[18, 18]} align="middle">
          <Col xs={24} lg={11}>
            <label className="pms-field-label" htmlFor="access-card-house">房号</label>
            <HouseAddressPicker
              id="access-card-house"
              communities={communities}
              value={addressValue}
              onChange={setAddressValue}
              onPicked={onPicked}
              loading={!communities.length}
            />
          </Col>
          <Col xs={24} lg={13}>
            {contextLoading ? <Skeleton active paragraph={{ rows: 2 }} /> : context ? (
              <div className="access-card-address-summary">
                <div>
                  <Title level={3}>{context.house.roomKey}</Title>
                  <Text>{context.house.displayAddress}</Text>
                </div>
                <Space wrap>
                  <Tag color={context.projectPhase === 'phase2' ? 'blue' : 'default'}>
                    {context.projectPhase === 'phase2' ? '枫桦景苑二期' : '枫桦景苑一期'}
                  </Tag>
                  <Tag color={context.routeReady ? 'success' : 'error'}>{systemLabel(context.accessSystem)}</Tag>
                </Space>
              </div>
            ) : <Text type="secondary">选择到具体室号后，系统会加载历史卡片和门禁路由。</Text>}
          </Col>
        </Row>
        {contextError && <Alert className="access-card-inline-alert" type="error" showIcon message={contextError} />}
      </Card>

      {context && (
        <>
          <Row gutter={[18, 18]} align="stretch">
            <Col xs={24} xl={10}>
              <Card className="access-card-form-card" title="2. 发卡设置">
                <div className="access-card-field">
                  <label>发卡数量</label>
                  <div className="access-card-stepper">
                    <Button aria-label="减少一张" icon={<MinusOutlined />} disabled={quantity <= 1 || !!batch} onClick={() => setQuantity((value) => Math.max(1, value - 1))} />
                    <strong>{quantity}</strong>
                    <Button aria-label="增加一张" icon={<PlusOutlined />} disabled={quantity >= 6 || !!batch} onClick={() => setQuantity((value) => Math.min(6, value + 1))} />
                    <span>张</span>
                  </div>
                </div>

                {context.projectPhase === 'phase2' && (
                  <div className="access-card-field">
                    <label htmlFor="access-card-extra-buildings">额外授权楼栋</label>
                    <Select
                      id="access-card-extra-buildings"
                      mode="multiple"
                      allowClear
                      value={extraBuildingIds}
                      options={extraOptions}
                      disabled={!!batch}
                      placeholder="默认只授权本楼栋，可按需增加"
                      onChange={setExtraBuildingIds}
                    />
                    <Text type="secondary">本楼栋 {context.house.buildingNo} 号楼已默认授权，无需重复选择。</Text>
                  </div>
                )}

                {!batch ? (
                  <Button
                    type="primary"
                    size="large"
                    block
                    icon={<CreditCardOutlined />}
                    disabled={!canStart}
                    loading={submitting}
                    onClick={() => void start()}
                  >
                    开始发 {quantity} 张卡
                  </Button>
                ) : (
                  <Button block onClick={() => { setBatch(null); setQuantity(1); }} disabled={!batch.deliverable}>
                    开始下一次发卡
                  </Button>
                )}
                {!canStart && <Alert className="access-card-inline-alert" type="error" showIcon message="当前没有可用发卡工作站，或该楼栋路由尚未配置。" />}
              </Card>
            </Col>

            <Col xs={24} xl={14}>
              <Card className="access-card-progress-card" title="3. 放卡与执行进度">
                {!batch ? (
                  <div className="access-card-empty">
                    <CreditCardOutlined />
                    <strong>等待开始发卡</strong>
                    <span>确认房号、数量和额外楼栋后，点击左侧按钮。</span>
                  </div>
                ) : (
                  <div className="access-card-live-task">
                    {duplicateItem ? (
                      <Alert
                        type="error"
                        showIcon
                        message="检测到已经发过的卡，本次发卡已停止"
                        description={duplicateItem.lastErrorMessage || `IC 卡号 ${duplicateItem.icCardNo || '未知'} 已存在，不能重复发卡。`}
                      />
                    ) : batch.deliverable ? (
                      <Alert
                        type="success"
                        showIcon
                        icon={<CheckCircleOutlined />}
                        message="发卡完成，可以交付"
                        description={batch.items.some((item) => item.legacySyncStatus !== 'synced') ? '旧发卡记录仍在同步中，不影响本卡使用。' : '卡片、门禁与旧库记录均已完成。'}
                      />
                    ) : (
                      <div className="access-card-place-card">
                        <span><UsbOutlined /></span>
                        <div>
                          <Text type="secondary">正在制作第 {currentSequence} / {batch.quantity} 张</Text>
                          <Title level={3}>请放一张已加密初始化的门禁卡</Title>
                          <Text>完成后请拿走卡片，系统检测移开后才会等待下一张。</Text>
                        </div>
                      </div>
                    )}

                    {!duplicateItem && activeErrorItem?.lastErrorMessage && (
                      <Alert
                        type="warning"
                        showIcon
                        message="本张卡暂未完成"
                        description={activeErrorItem.lastErrorMessage}
                      />
                    )}

                    {accessFailedItem && (
                      <Alert
                        type="error"
                        showIcon
                        message="下载失败，门禁控制器离线"
                        description={accessFailedItem.lastErrorMessage || '未收到门禁控制器响应，请检查控制器供电、网络或串口连接后重试。'}
                        action={(
                          <Button
                            icon={<ReloadOutlined />}
                            loading={retryingItemId === accessFailedItem.id}
                            onClick={() => void retryAccessUpload(accessFailedItem.id)}
                          >
                            重试
                          </Button>
                        )}
                      />
                    )}

                    <Descriptions size="small" column={{ xs: 1, md: 2 }}>
                      <Descriptions.Item label="房号">{batch.addressSnapshot}</Descriptions.Item>
                      <Descriptions.Item label="处理方式">{batch.projectPhase === 'phase1' ? '一期 · 只写卡' : `二期 · ${systemLabel(batch.accessSystem)}`}</Descriptions.Item>
                    </Descriptions>

                    <div className="access-card-item-strip">
                      {batch.items.map((item) => (
                        <div key={item.id} className={item.cardStatus === 'card_completed' ? 'is-complete' : 'is-waiting'}>
                          <span>{item.cardStatus === 'card_completed' ? <CheckCircleOutlined /> : item.sequence}</span>
                          <small>{item.cardStatus === 'card_completed'
                            ? item.icCardNo
                            : item.cardStatus === 'duplicate_card' ? '重复卡，已停止' : '等待放卡'}</small>
                        </div>
                      ))}
                    </div>

                    {readiness?.simulationEnabled && (
                      <Flex gap={10} wrap="wrap">
                        {!batch.deliverable && (
                          <Button type="primary" icon={<ExperimentOutlined />} loading={simulating} onClick={() => void simulateNext()}>
                            模拟放入第 {currentSequence} 张卡
                          </Button>
                        )}
                        {completedCount > 0 && batch.items.some((item) => item.legacySyncStatus !== 'synced') && (
                          <Button icon={<DatabaseOutlined />} loading={simulating} onClick={() => void simulateLegacySync()}>
                            模拟同步到 .80
                          </Button>
                        )}
                      </Flex>
                    )}
                  </div>
                )}
              </Card>
            </Col>
          </Row>

          <Card
            className="access-card-history-card"
            title={`历史卡片 · ${context.house.roomKey}`}
            extra={(
              <Space wrap>
                <Text type="secondary">{context.historySources.legacy80
                  ? `最新在前，已发 ${history.length} 张`
                  : `正在读取旧库历史，当前显示 ${history.length} 张`}</Text>
                <Button
                  icon={<ReloadOutlined />}
                  loading={contextLoading}
                  onClick={() => void refreshContext()}
                >
                  刷新历史
                </Button>
              </Space>
            )}
          >
            {!context.historySources.legacy80 && (
              <Alert
                className="access-card-history-source"
                type="warning"
                showIcon
                message={context.historySources.message}
              />
            )}
            {context.historySources.legacy80 && !context.historySources.accessPermissions && (
              <Alert
                className="access-card-history-source"
                type="info"
                showIcon
                message={context.historySources.accessPermissionsMessage}
              />
            )}
            <Table<AccessCardHistoryRow>
              rowKey="id"
              columns={columns}
              dataSource={history}
              pagination={{ pageSize: 10, hideOnSinglePage: true, showSizeChanger: false }}
              scroll={{ x: 1080 }}
              locale={{ emptyText: <Empty description="这个房号还没有新系统发卡记录" /> }}
            />
          </Card>
        </>
      )}

      <Modal
        title="注册门禁本地服务"
        open={agentModalOpen}
        width={620}
        onCancel={() => setAgentModalOpen(false)}
        footer={agentCredential
          ? <Button type="primary" onClick={() => setAgentModalOpen(false)}>我已保存安装信息</Button>
          : <Space><Button onClick={() => setAgentModalOpen(false)}>取消</Button><Button type="primary" loading={agentEnrolling} onClick={() => void enrollAgent()}>生成代理密钥</Button></Space>}
      >
        {agentCredential ? (
          <div className="access-card-agent-secret">
            <Alert type="warning" showIcon message="密钥只显示这一次" description={agentCredential.message} />
            <CopyableSecret label="一次性连接密钥" value={agentCredential.token} />
            <Text type="secondary">在对应电脑双击数据同步助手，只需粘贴上方连接密钥。代理 ID 会自动识别并固定保存；不要把密钥发到聊天、截图或配置仓库。</Text>
          </div>
        ) : (
          <div className="access-card-agent-form">
            <div className="access-card-field">
              <label htmlFor="access-card-agent-kind">服务类型</label>
              <Select
                id="access-card-agent-kind"
                value={agentKind}
                onChange={(value) => {
                  setAgentKind(value);
                  setAgentName(value === 'issuer' ? '办公室发卡器接入'
                    : value === 'access_gateway' ? '枫桦二期楼栋门禁系统接入'
                    : '枫桦一二期小区大门门禁系统接入');
                }}
                options={[
                  { value: 'issuer', label: '办公室发卡器接入' },
                  { value: 'access_gateway', label: '枫桦二期楼栋门禁系统接入' },
                  { value: 'legacy_sync', label: '枫桦一二期小区大门门禁系统接入' },
                ]}
              />
            </div>
            <div className="access-card-field">
              <label htmlFor="access-card-agent-name">电脑名称</label>
              <Input id="access-card-agent-name" value={agentName} maxLength={100} onChange={(event) => setAgentName(event.target.value)} />
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
