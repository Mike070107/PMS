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
      version: mode === 'ready' ? '0.4.0' : '0.3.0',
      status: 'online',
      capabilities: { parkingDbRead: true, parkingDbWrite: false },
      lastSeenAt: new Date().toISOString(),
    }],
  };
  const rows = mode === 'ready' ? [{
    database: 'parking2',
    fields: {
      Car_No: '沪A12345',
      Room_No: '228/5/301',
      User_Name: '张某某',
      Mobile: '13800006421',
      Park_No: 'DK23',
      End_Date: '2026-12-31 23:59:59',
      Car_Zt: '正常',
    },
  }] : undefined;
  return <ParkingManagementPage readinessOverride={readiness} rowsOverride={rows} />;
}
