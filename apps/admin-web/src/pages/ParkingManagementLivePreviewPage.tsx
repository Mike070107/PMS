import type { AccessCardReadiness } from '@pms/api-client';
import ParkingManagementPage from './ParkingManagementPage';

export default function ParkingManagementLivePreviewPage({ mode }: { mode: 'upgrade' | 'ready' }) {
  const readiness: AccessCardReadiness = {
    simulationEnabled: false,
    features: { cardWrite: false, legacyDbWrite: false, accessDbWrite: false, parkingDbRead: true, parkingDbWrite: false, controllerUpload: false },
    agents: [{
      id: 'parking_gateway-preview',
      kind: 'parking_gateway',
      name: '枫桦景苑停车系统网关',
      version: mode === 'ready' ? '0.4.1' : '0.4.0',
      status: 'online',
      capabilities: { parkingDbRead: true, parkingDbWrite: false },
      lastSeenAt: new Date().toISOString(),
    }],
  };
  const rows = mode === 'ready' ? [{
    database: 'parking2',
    fields: {
      P_plate: '沪A12345',
      Owner_ID: 1264,
      Car_Brand: '住户车',
      Owner__Room_No: '228/5/301',
      Owner__User_Name: '张某某',
      Owner__Mobile: '13800006421',
      P_Spaces: 'DK23',
      End_Time: '2026-12-31 23:59:59',
      Car_Zt: 0,
      P_Effective: '000000000000001010101',
      P_Download: '000000000000001010101',
      P_note: '地库91号',
    },
    pmsMatch: {
      userId: 1264,
      houseId: 301,
      name: '张某某',
      phone: '13800006421',
      contactNote: '白天联系本人',
      house: { id: 301, roomNo: '301', areaSqm: '89.50', lane: '228', buildingNo: '5', communityId: 1, communityName: '枫桦景苑' },
      matchedBy: 'phone' as const,
    },
  }] : undefined;
  return <ParkingManagementPage readinessOverride={readiness} rowsOverride={rows} />;
}
