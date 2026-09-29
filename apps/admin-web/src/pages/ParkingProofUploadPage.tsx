import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { isApiEnvelope } from '@pms/api-client';
import './ParkingProofUploadPage.css';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || '/api/v1';
type Session = { plate: string; expiresAt: string; status: 'waiting' | 'opened' | 'submitted'; fileName?: string | null };

export default function ParkingProofUploadPage() {
  const { token = '' } = useParams();
  const [session, setSession] = useState<Session | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetch(`${API_BASE_URL}/parking-proof/session?token=${encodeURIComponent(token)}`)
      .then(readResponse<Session>)
      .then(setSession)
      .catch((reason) => setError(reason instanceof Error ? reason.message : '上传链接无法打开'))
      .finally(() => setLoading(false));
  }, [token]);

  const submit = async () => {
    if (!file) { setError('请先拍照或选择证明材料'); return; }
    if (file.size > 20 * 1024 * 1024) { setError('文件不能超过 20MB'); return; }
    setSaving(true); setError('');
    try {
      const form = new FormData(); form.append('file', file);
      const next = await fetch(`${API_BASE_URL}/parking-proof/submit?token=${encodeURIComponent(token)}`, { method: 'POST', body: form }).then(readResponse<Session>);
      setSession(next);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '上传失败，请检查网络后重试');
    } finally { setSaving(false); }
  };

  return (
    <main className="parking-proof-page">
      <section>
        <div className="parking-proof-brand">枫桦景苑物业</div>
        <h1>亲情车证明材料</h1>
        {loading && <p>正在确认上传任务…</p>}
        {error && <div className="parking-proof-error">{error}</div>}
        {session?.status === 'submitted' ? (
          <div className="parking-proof-success"><strong>上传成功</strong><span>{session.plate} 的证明材料已经交给办公室，可以关闭页面。</span></div>
        ) : session ? (
          <>
            <div className="parking-proof-plate">{session.plate}</div>
            <p>请拍摄或选择能证明亲情车关系的材料。支持照片或 PDF，仅用于本次亲情车办理。</p>
            <label className="parking-proof-picker">
              <span>{file ? file.name : '拍照或选择材料'}</span>
              <input type="file" accept="image/jpeg,image/png,image/gif,image/webp,image/heic,image/heif,application/pdf" onChange={(event) => setFile(event.target.files?.[0] || null)} />
            </label>
            <button type="button" disabled={!file || saving} onClick={() => void submit()}>{saving ? '正在上传…' : '确认上传'}</button>
            <small>链接有效至 {new Date(session.expiresAt).toLocaleString('zh-CN', { hour12: false })}</small>
          </>
        ) : null}
      </section>
    </main>
  );
}

async function readResponse<T>(response: Response): Promise<T> {
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message = payload && typeof payload === 'object' && 'message' in payload ? String((payload as { message: unknown }).message) : '请求失败';
    throw new Error(message);
  }
  return (isApiEnvelope(payload) ? (payload as { data: unknown }).data : payload) as T;
}
