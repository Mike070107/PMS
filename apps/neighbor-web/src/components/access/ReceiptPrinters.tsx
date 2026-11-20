import { useCallback, useEffect, useState } from 'react';
import { request } from '@pms/api-client';
import { auth, useSession } from '@/lib/auth';
import { can } from '@/lib/perm';

type Printer = {
  id: number;
  name: string;
  queue_name: string | null;
  bound: boolean;
  online: boolean;
};
type Inventory = {
  printers: Printer[];
};
export function ReceiptPrinters() {
  const { access } = useSession();
  if (!can('business', 'edit') || !access?.scopeAll || !access.isTenantAdmin)
    return null;
  return <PrinterSettings key={JSON.stringify(auth.captureIdentity())} />;
}
function PrinterSettings() {
  const [open, setOpen] = useState(false),
    [inventory, setInventory] = useState<Inventory>();
  const [name, setName] = useState(''),
    [code, setCode] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const [invalid, setInvalid] = useState(false);
  const load = useCallback(async () => {
    const i = await request<Inventory>({ url: '/receipt-printers/manage' });
    setInventory(i);
  }, []);
  useEffect(() => {
    if (open) void load().catch((e) => setError(e.message));
  }, [load, open]);
  async function save(url: string, data: Record<string, unknown>) {
    if (busy) return;
    setBusy(true);
    setError('');
    setCode('');
    try {
      const result = await request<{ code?: string }>({
        url: '/receipt-printers/' + url,
        method: 'POST',
        data,
      });
      if (result.code) {
        setCode(result.code);
        setName('');
      }
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <details
      className="card"
      onToggle={(e) => setOpen(e.currentTarget.open)}
      style={{ padding: 16, marginBottom: 16 }}
    >
      <summary style={{ cursor: 'pointer', fontWeight: 650 }}>
        公寓小票打印机
      </summary>
      {open && (
        <div style={{ display: 'grid', gap: 12, marginTop: 12 }}>
          <a
            href={
              import.meta.env.BASE_URL +
              'downloads/receipt-printer/PmsReceiptPrinter.exe'
            }
            download
          >
            下载 Windows 打印助手
          </a>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (!name.trim()) {
                setInvalid(true);
                document.getElementById('receipt-printer-name')?.focus();
                return;
              }
              void save('register', { name });
            }}
          >
            <label htmlFor="receipt-printer-name">打印机名称</label>{' '}
            <input
              id="receipt-printer-name"
              className="in"
              maxLength={60}
              value={name}
              aria-invalid={invalid}
              aria-describedby={invalid ? 'printer-name-error' : undefined}
              style={invalid ? { borderColor: '#b42318' } : undefined}
              onChange={(e) => {
                setName(e.target.value);
                setInvalid(false);
              }}
            />
            {invalid && (
              <small id="printer-name-error" role="alert">
                请输入打印机名称
              </small>
            )}{' '}
            <button className="btn p" disabled={busy}>
              生成绑定码
            </button>
          </form>
          {code && (
            <div role="status">
              在打印电脑输入此一次性绑定码，10 分钟内有效。
              <p style={{ overflowWrap: 'anywhere' }}>
                <code>{code}</code>
              </p>
              <button className="btn" onClick={() => setCode('')}>
                隐藏绑定码
              </button>
            </div>
          )}
          {error && <div role="alert">{error}</div>}
          <button
            className="btn"
            style={{ justifySelf: 'start' }}
            onClick={() =>
              void load()
                .then(() => setError(''))
                .catch((e) => setError(e.message))
            }
          >
            刷新打印机状态
          </button>
          {inventory?.printers.map((p) => (
            <details key={p.id}>
              <summary>
                {p.name} · {p.online ? '在线' : p.bound ? '离线' : '待绑定'}
              </summary>
              <p>{p.queue_name}</p>
              <button
                className="btn"
                disabled={busy}
                onClick={() => {
                  if (
                    window.confirm(
                      '解除原助手绑定并取消待打印任务，生成新绑定码？',
                    )
                  )
                    void save(p.id + '/reset', {});
                }}
              >
                重新绑定
              </button>
            </details>
          ))}
        </div>
      )}
    </details>
  );
}
