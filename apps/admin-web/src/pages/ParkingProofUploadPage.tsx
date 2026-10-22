import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { isApiEnvelope } from '@pms/api-client';
import './ParkingProofUploadPage.css';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || '/api/v1';
type Family = {
  lane: string; buildingNo: string; roomNo: string; plate: string;
  carOwnerName: string; carOwnerPhone: string; relation: string; relations: string[]; needsInfo: boolean;
};
type Session = { plate: string; expiresAt: string; status: 'waiting' | 'opened' | 'submitted'; fileName?: string | null; family?: Family | null };

export default function ParkingProofUploadPage() {
  const { token = '' } = useParams();
  const [session, setSession] = useState<Session | null>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [carOwnerName, setCarOwnerName] = useState('');
  const [carOwnerPhone, setCarOwnerPhone] = useState('');
  const [relation, setRelation] = useState('');
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 1000); return () => window.clearInterval(timer); }, []);

  useEffect(() => {
    fetch(`${API_BASE_URL}/parking-proof/session?token=${encodeURIComponent(token)}`)
      .then(readResponse<Session>)
      .then((next) => {
        setSession(next);
        if (next.family) { setCarOwnerName(next.family.carOwnerName); setCarOwnerPhone(next.family.carOwnerPhone); setRelation(next.family.relation); }
      })
      .catch((reason) => setError(reason instanceof Error ? reason.message : '上传链接无法打开'))
      .finally(() => setLoading(false));
  }, [token]);

  const submit = async () => {
    if (session?.family) {
      if (!carOwnerName.trim()) { setError('请填写车主姓名'); return; }
      if (!/^1\d{10}$/.test(carOwnerPhone.trim())) { setError('请填写 11 位车主手机号'); return; }
      if (!relation) { setError('请选择与业主的关系'); return; }
    }
    if (!files.length) { setError('请先拍照或选择证明材料'); return; }
    if (files.length > 10 || files.some((file) => file.size > 20 * 1024 * 1024)) { setError('最多 10 份资料，每份不能超过 20MB'); return; }
    setSaving(true); setError('');
    try {
      const form = new FormData();
      if (session?.family) { form.append('carOwnerName', carOwnerName.trim()); form.append('carOwnerPhone', carOwnerPhone.trim()); form.append('relation', relation); }
      files.forEach((file) => form.append('file', file));
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
            {session.family && <div className="parking-proof-addr">{session.family.lane} 弄 {session.family.buildingNo} 号 {session.family.roomNo} 室</div>}
            <div className="parking-proof-plate">{session.plate}</div>
            {session.family && <div className="parking-proof-form">
              <h2>车主信息</h2>
              <label>车主姓名<input value={carOwnerName} maxLength={50} onChange={(event) => setCarOwnerName(event.target.value)} placeholder="驾驶这辆车的亲属姓名" /></label>
              <label>车主手机号<input value={carOwnerPhone} inputMode="numeric" maxLength={11} onChange={(event) => setCarOwnerPhone(event.target.value.replace(/\D/g, ''))} placeholder="11 位手机号" /></label>
              <label>与业主关系<select value={relation} onChange={(event) => setRelation(event.target.value)}><option value="">请选择</option>{session.family.relations.map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
              <h2>证明资料</h2>
            </div>}
            <p>请拍摄或选择能证明亲情车关系的材料，例如行驶证、身份证、户口本、关系证明。支持照片或 PDF，可传多份。</p>
            <label className="parking-proof-picker" tabIndex={0} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); setFiles(Array.from(event.dataTransfer.files)); }} onPaste={(event) => { const pasted = Array.from(event.clipboardData.files); if (pasted.length) { event.preventDefault(); setFiles(pasted); } }}>
              <span>{files.length ? `已选择 ${files.length} 份：${files.map((file) => file.name).join('、')}` : '拍照、选择、拖入或粘贴材料（最多10份）'}</span>
              <input type="file" multiple accept="image/jpeg,image/png,image/gif,image/webp,image/heic,image/heif,application/pdf" onChange={(event) => setFiles(Array.from(event.target.files || []))} />
            </label>
            <button type="button" disabled={!files.length || saving} onClick={() => void submit()}>{saving ? '正在上传…' : session.family ? '提交给物业' : '确认上传'}</button>
            <small>{remaining(session.expiresAt, now)}；链接只对这辆车有效，提交后失效</small>
          </>
        ) : null}
      </section>
    </main>
  );
}

function remaining(expiresAt: string, now: number) {
  const ms = new Date(expiresAt).getTime() - now;
  if (ms <= 0) return '链接已过期，请联系物业重新生成';
  const minutes = Math.floor(ms / 60000);
  const seconds = Math.floor((ms % 60000) / 1000);
  return `剩余有效时间 ${minutes} 分 ${String(seconds).padStart(2, '0')} 秒`;
}

async function readResponse<T>(response: Response): Promise<T> {
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message = payload && typeof payload === 'object' && 'message' in payload ? String((payload as { message: unknown }).message) : '请求失败';
    throw new Error(message);
  }
  return (isApiEnvelope(payload) ? (payload as { data: unknown }).data : payload) as T;
}
