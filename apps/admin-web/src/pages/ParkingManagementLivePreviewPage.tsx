import type { AccessCardReadiness, ParkingQueryRow } from '@pms/api-client';
import ParkingManagementPage from './ParkingManagementPage';

export default function ParkingManagementLivePreviewPage({ mode }: { mode: 'upgrade' | 'ready' }) {
  const readiness: AccessCardReadiness = {
    simulationEnabled: false,
    features: { cardWrite: false, legacyDbWrite: false, accessDbWrite: false, parkingDbRead: true, parkingDbWrite: mode === 'ready', controllerUpload: false },
    agents: [{
      id: 'parking_gateway-preview',
      kind: 'parking_gateway',
      name: '枫桦景苑停车系统网关',
      version: mode === 'ready' ? '2.4.0' : '2.3.0',
      status: 'online',
      capabilities: { parkingDbRead: true, parkingDbWrite: mode === 'ready' },
      lastSeenAt: new Date().toISOString(),
    }],
  };
  const rows: ParkingQueryRow[] | undefined = mode === 'ready' ? [{
    database: 'parking2',
    fields: {
      P_id: 8842,
      P_plate: '沪A12345',
      Owner_ID: 1264,
      Car_Brand: '住户车',
      Owner__Room_No: '228/5/301',
      Owner__User_Name: '张某某',
      Owner__Mobile: '13800006421',
      Owner__P_note: '白天联系本人',
      P_Spaces: 'DK23',
      End_Time: '2026-12-31 23:59:59',
      Car_Zt: 0,
      P_Effective: '000000000000001010101',
      P_Download: '000000000000001010101',
      P_note: '地库91号',
    },
    historyRef: { database: 'parking2', sourceRecordId: '8842', externalOwnerId: '1264', plate: '沪A12345', pmsUserId: 1264 },
    pmsMatch: {
      userId: 1264,
      houseId: 301,
      name: '张某某',
      phone: '13800006421',
      contactNote: '白天联系本人',
      house: { id: 301, roomNo: '301', areaSqm: '89.50', lane: '228', buildingNo: '5', communityId: 1, communityName: '枫桦景苑' },
      matchedBy: 'phone' as const,
    },
  }, {
    database: 'parking2',
    fields: {
      P_id: 9016, P_plate: '沪B67890', Owner_ID: 1264, Car_Brand: '亲情车',
      Owner__Room_No: '228/5/301', Owner__User_Name: '张某某', Owner__Mobile: '13800006421', Owner__P_note: '白天联系本人',
      End_Time: '2026-09-20 23:59:59', P_Effective: '000000000000001010101', P_Download: '000000000000001010101',
    },
    historyRef: { database: 'parking2', sourceRecordId: '9016', externalOwnerId: '1264', plate: '沪B67890', pmsUserId: 1264 },
    pmsMatch: {
      userId: 1264, houseId: 301, name: '张某某', phone: '13800006421', contactNote: '白天联系本人',
      house: { id: 301, roomNo: '301', areaSqm: '89.50', lane: '228', buildingNo: '5', communityId: 1, communityName: '枫桦景苑' }, matchedBy: 'phone' as const,
    },
  }] : undefined;
  const history = mode === 'ready' ? {
    userHistory: [{
      id: 1, eventType: 'owner_info_update' as const, source: 'pms' as const, database: null, sourceRecordId: null,
      pmsUserId: 1264, externalOwnerId: null, plateBefore: null, plateAfter: null,
      summary: '更新业主资料：电话', changes: [{ field: 'phone', label: '电话', before: '13800001234', after: '13800006421' }],
      operator: '王管理员', occurredAt: '2026-09-30T02:15:00.000Z', timeBasis: 'operation' as const,
    }],
    // 故意先放旧记录，页面必须仍按真实操作时间倒序显示。
    vehicleHistory: [{
      id: 3, eventType: 'plate_change' as const, source: 'parking_gateway' as const, database: 'parking2', sourceRecordId: '8842',
      pmsUserId: 1264, externalOwnerId: '1264', plateBefore: '沪A11111', plateAfter: '沪A54321',
      summary: '车牌由 沪A11111 换为 沪A54321', changes: [{ field: 'plate', label: '车牌', before: '沪A11111', after: '沪A54321' }],
      operator: '系统从旧停车库检测', occurredAt: '2026-08-15T03:20:00.000Z', timeBasis: 'operation' as const,
    }, {
      id: 2, eventType: 'plate_change' as const, source: 'parking_gateway' as const, database: 'parking2', sourceRecordId: '8842',
      pmsUserId: 1264, externalOwnerId: '1264', plateBefore: '沪A54321', plateAfter: '沪A12345',
      summary: '车牌由 沪A54321 换为 沪A12345', changes: [{ field: 'plate', label: '车牌', before: '沪A54321', after: '沪A12345' }],
      operator: '系统从旧停车库检测', occurredAt: '2026-09-29T07:42:00.000Z', timeBasis: 'operation' as const,
    }],
  } : undefined;
  return <ParkingManagementPage readinessOverride={readiness} rowsOverride={rows} historyOverride={history} />;
}
