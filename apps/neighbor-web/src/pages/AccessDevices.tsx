import { useEffect, useState } from 'react';
import { accessCardIssuance } from '@pms/api-client';
import type { AccessCardReadiness } from '@pms/api-client/src/endpoints/access-card-issuance';
import ToneIcon from '@/components/ToneIcon';
import DoorControlPanel from '@/components/access/DoorControlPanel';
import { Loading } from '@/components/ui';
import { can } from '@/lib/perm';
import '@/styles/access-door.css';

/**
 * 门禁管理 → 设备管理：从门禁发卡页拆出的独立页。
 * 复用 DoorControlPanel：控制器在线状态、重新检查、立即开门 / 常开。
 */
export default function AccessDevices() {
  const canEdit = can('business', 'edit');
  const [readiness, setReadiness] = useState<AccessCardReadiness | null>(null);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setError('');
    accessCardIssuance.readiness()
      .then((result) => { if (!cancelled) setReadiness(result ?? null); })
      .catch((e) => {
        if (cancelled) return;
        setReadiness(null);
        setError(e instanceof Error && e.message ? e.message : '门禁设备范围读取失败');
      });
    return () => { cancelled = true; };
  }, [retry]);

  const communities = readiness?.doorControlCommunities ?? [];

  return (
    <>
      <div className="ph" style={{ marginBottom: 14 }}>
        <div>
          <div className="h1row"><ToneIcon kind="devices" /><h1 style={{ fontSize: 22 }}>设备管理</h1></div>
          <p>二期联网门禁控制器在线状态与远程开门；发卡与卡记录请到「门禁发卡」</p>
        </div>
      </div>

      {readiness === null && !error ? <Loading text="读取门禁设备范围…" /> : null}
      <DoorControlPanel
        communities={communities}
        loaded={readiness !== null}
        loadError={error}
        onReloadScope={() => setRetry((value) => value + 1)}
        canEdit={canEdit}
      />
    </>
  );
}
