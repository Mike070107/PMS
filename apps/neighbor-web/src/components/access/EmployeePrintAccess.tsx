import { useEffect, useState } from 'react';
import { request } from '@pms/api-client';
import { useSession } from '@/lib/auth';
import { can } from '@/lib/perm';

type Printer = { id: number; name: string; allowed: boolean };

export function EmployeePrintAccess({
  employeeId,
  active,
}: {
  employeeId: number;
  active: boolean;
}) {
  const { access } = useSession();
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<Printer[]>();
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const [busy, setBusy] = useState(false);
  const permitted =
    !!access?.isTenantAdmin && access.scopeAll && can('users', 'edit');
  useEffect(() => {
    if (!open || !permitted) return;
    let alive = true;
    setItems(undefined);
    setError('');
    request<Printer[]>({ url: '/receipt-printers/employees/' + employeeId })
      .then((rows) => {
        if (alive) setItems(rows);
      })
      .catch((e) => {
        if (alive) setError(e.message || '读取打印授权失败');
      });
    return () => {
      alive = false;
    };
  }, [employeeId, open, permitted, revision]);
  async function toggle(id: number, allow: boolean) {
    setBusy(true);
    setError('');
    try {
      await request({
        method: 'POST',
        url: '/receipt-printers/' + id + '/grants',
        data: { employeeId, allow },
      });
      setItems((rows) =>
        rows?.map((p) => (p.id === id ? { ...p, allowed: allow } : p)),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : '授权结果待确认，请重新读取');
      setItems(undefined);
    } finally {
      setBusy(false);
    }
  }
  if (!permitted) return null;
  return (
    <details
      className="card"
      style={{ padding: 12, marginBottom: 12 }}
      onToggle={(e) => setOpen(e.currentTarget.open)}
    >
      <summary style={{ cursor: 'pointer', fontWeight: 650 }}>打印服务</summary>
      {open && (
        <div style={{ display: 'grid', gap: 8, marginTop: 8 }}>
          {error && (
            <div role="alert">
              {error}{' '}
              <button
                type="button"
                className="btn"
                onClick={() => setRevision((r) => r + 1)}
              >
                重新读取
              </button>
            </div>
          )}
          {!error && !items && <span role="status">读取中…</span>}
          {items?.length === 0 && (
            <span className="muted">
              尚未登记打印机，可在「系统与设备」中添加。
            </span>
          )}
          {!!items?.length && (
            <small className="muted">可用打印机 · 勾选后立即生效</small>
          )}
          {items?.map((p) => (
            <label key={p.id}>
              <input
                type="checkbox"
                checked={p.allowed}
                disabled={busy || (!active && !p.allowed)}
                onChange={(e) => void toggle(p.id, e.target.checked)}
              />{' '}
              {p.name}
            </label>
          ))}
        </div>
      )}
    </details>
  );
}
