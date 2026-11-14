import { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { request } from '@pms/api-client';

const API = import.meta.env.VITE_API_BASE_URL || '/api/v1';

interface Session {
  kind: 'paid' | 'family'; status: 'waiting' | 'submitted' | 'reupload' | 'approved' | 'void';
  houseLabel: string; ownerName: string; expiresAt: string; reviewNote: string;
  plate: string; contactName: string; contactPhone: string; relation: string; fileCount: number; relations: string[];
}
interface Pick { file: File; url: string; isImg: boolean; broken?: boolean }

// 与旧停车管理页同一套车牌键盘：省份 → 发牌机关字母 → 序号（不含 I、O）
const PROVINCES = '京津冀晋蒙辽吉黑沪苏浙皖闽赣鲁豫鄂湘粤桂琼渝川贵云藏陕甘青宁新'.split('');
const LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ'.split('');
const ALNUM = '0123456789ABCDEFGHJKLMNPQRSTUVWXYZ'.split('');
const OTHER = '其他';
const isImage = (f: File) => f.type.startsWith('image/') || /\.(jpe?g|png|gif|webp|heic|heif|bmp)$/i.test(f.name) || (!f.type && !/\.pdf$/i.test(f.name));

/**
 * 业主手机扫码填写页（不需要登录）：车牌（车牌键盘）、手机号、关系（亲情车），拍照上传资料。
 * 链接 1 小时有效；提交后物业办公室实时收到。
 */
export default function PlateForm() {
  const { token = '' } = useParams();
  const [s, setS] = useState<Session | null>(null);
  const [err, setErr] = useState('');
  const [plate, setPlate] = useState('');
  const [phone, setPhone] = useState('');
  const [relation, setRelation] = useState('');
  const [otherText, setOtherText] = useState('');
  const [picks, setPicks] = useState<Pick[]>([]);
  const [keep, setKeep] = useState(true);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const pick = useRef<HTMLInputElement>(null);
  const shoot = useRef<HTMLInputElement>(null);

  useEffect(() => {
    document.title = '车辆登记';
    request<Session>({ url: `/vehicle-intake-form/${token}` })
      .then((r) => {
        setS(r);
        if (r.relation) { if (r.relations.includes(r.relation) && r.relation !== '其他亲属') setRelation(r.relation); else { setRelation(OTHER); setOtherText(r.relation); } }
      })
      .catch((e) => setErr(e instanceof Error ? e.message : '链接无效'));
  }, [token]);
  useEffect(() => () => picks.forEach((p) => URL.revokeObjectURL(p.url)), []); // eslint-disable-line react-hooks/exhaustive-deps

  const add = (list: FileList | null) => {
    if (!list) return;
    const next = Array.from(list).map((file) => ({ file, url: URL.createObjectURL(file), isImg: isImage(file) }));
    setPicks((p) => [...p, ...next].slice(0, 10));
  };
  const remove = (i: number) => setPicks((p) => { URL.revokeObjectURL(p[i].url); return p.filter((_, j) => j !== i); });

  const mode = !PROVINCES.includes(plate.slice(0, 1)) ? 'province' : plate.length === 1 ? 'letter' : 'number';
  const keys = mode === 'province' ? PROVINCES : mode === 'letter' ? LETTERS : ALNUM;
  const type = (k: string) => setPlate((p) => (mode === 'province' ? k : `${p}${k}`).slice(0, 8));
  const plateOk = /^[\u4e00-\u9fa5][A-HJ-NP-Z][A-HJ-NP-Z0-9]{5,6}$/.test(plate);
  const phoneOk = /^1\d{10}$/.test(phone);
  const rel = relation === OTHER ? otherText.trim() : relation;
  const keptCount = s?.status === 'reupload' && keep ? s.fileCount : 0;
  const ready = plateOk && phoneOk && (s?.kind !== 'family' || !!rel) && picks.length + keptCount > 0;

  const submit = async () => {
    if (!ready || busy) return;
    setBusy(true); setMsg('');
    try {
      const fd = new FormData();
      fd.append('plate', plate); fd.append('contactPhone', phone);
      if (s?.kind === 'family') fd.append('relation', rel);
      if (keptCount) fd.append('keepFiles', '1');
      picks.forEach((p) => fd.append('file', p.file, p.file.name || 'photo.jpg'));
      const res = await fetch(`${API}/vehicle-intake-form/${token}`, { method: 'POST', body: fd });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(Array.isArray(body.message) ? body.message[0] : body.message || '提交失败，请重试');
      setS(body as Session);
    } catch (e) { setMsg(e instanceof Error ? e.message : '提交失败，请重试'); }
    finally { setBusy(false); }
  };

  const plateBox = (value: string, big = false) => (
    <div className={`pf-plate-box ${value.length === 8 ? 'green' : 'blue'} ${big ? 'big' : ''}`}>
      <span>{value ? `${value.slice(0, 1)} ${value.slice(1, 2)}${value.length > 2 ? '·' : ''}${value.slice(2)}` : '请选择省份简称'}</span>
    </div>
  );

  if (err) return <div className="pf"><div className="pf-card pf-center"><div className="pf-ic bad">!</div><h2>无法填写</h2><p>{err}</p></div></div>;
  if (!s) return <div className="pf"><div className="pf-card pf-center"><p>加载中…</p></div></div>;
  if (s.status === 'submitted' || s.status === 'approved') {
    return (
      <div className="pf"><div className="pf-card pf-center">
        <div className="pf-ic ok">✓</div>
        <h2>{s.status === 'approved' ? '物业已审核通过' : '已提交，等待物业审核'}</h2>
        <p className="pf-line">{s.houseLabel}</p>
        {plateBox(s.plate)}
        <p className="pf-muted" style={{ marginTop: 12 }}>{s.status === 'approved' ? (s.kind === 'family' ? '亲情车登记会在物业经理审核后开通，有效期一年。' : '物业会按缴费办理开通。') : '物业办公室已经收到，如资料不清楚会联系您重新上传。可以关闭此页面。'}</p>
      </div></div>
    );
  }
  if (s.status === 'void') return <div className="pf"><div className="pf-card pf-center"><div className="pf-ic bad">!</div><h2>这条登记已取消</h2><p>如有疑问请联系物业办公室。</p></div></div>;

  return (
    <div className="pf">
      <div className="pf-card">
        <div className="pf-hd">
          <h1>{s.kind === 'family' ? '亲情车登记' : '新车登记'}</h1>
          <p className="pf-line">{s.houseLabel}</p>
          {s.ownerName ? <p className="pf-line">业主 {s.ownerName}</p> : null}
          <p className="pf-muted">请在 {new Date(s.expiresAt).toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hour12: false })} 前提交</p>
        </div>
        {s.status === 'reupload' && s.reviewNote ? <div className="pf-warn">物业退回：{s.reviewNote}</div> : null}

        <label className="pf-label">车牌号</label>
        {plateBox(plate, true)}
        <div className="pf-kb">
          <div className="pf-kb-hd">
            <b>{mode === 'province' ? '第 1 步 · 选省份简称' : mode === 'letter' ? '第 2 步 · 选字母' : '继续输入车牌号'}</b>
            <span>普通 7 位，新能源 8 位</span>
          </div>
          <div className={`pf-keys ${mode}`}>{keys.map((k) => <button key={k} type="button" disabled={mode === 'number' && plate.length >= 8} onClick={() => type(k)}>{k}</button>)}</div>
          <div className="pf-kb-act">
            <button type="button" disabled={!plate} onClick={() => setPlate((p) => p.slice(0, -1))}>退格</button>
            <button type="button" disabled={!plate} onClick={() => setPlate('')}>清空</button>
          </div>
        </div>
        {plate.length >= 7 && !plateOk ? <div className="pf-err">车牌格式不对，请检查</div> : null}

        <label className="pf-label">手机号</label>
        <input className="pf-in" value={phone} type="tel" inputMode="numeric" maxLength={11} onChange={(e) => setPhone(e.target.value.replace(/\D/g, ''))} placeholder="物业联系您用" />
        {phone && !phoneOk ? <div className="pf-err">请填 11 位手机号</div> : null}

        {s.kind === 'family' ? (
          <>
            <label className="pf-label">车主与业主的关系</label>
            <div className="pf-chips">
              {s.relations.filter((r) => r !== '其他亲属').map((r) => <button key={r} type="button" className={relation === r ? 'on' : ''} onClick={() => setRelation(r)}>{r}</button>)}
              <button type="button" className={relation === OTHER ? 'on' : ''} onClick={() => setRelation(OTHER)}>其他</button>
            </div>
            {relation === OTHER ? <input className="pf-in" style={{ marginTop: 8 }} value={otherText} maxLength={12} autoFocus onChange={(e) => setOtherText(e.target.value)} placeholder="请填写关系，例如 表哥、儿媳" /> : null}
          </>
        ) : null}

        <label className="pf-label">上传资料</label>
        <p className="pf-muted">{s.kind === 'family' ? '行驶证、车主身份证、与业主关系证明（户口本 / 结婚证等）' : '行驶证（正副页）、车主身份证或驾驶证'}，可多张，最多 10 张</p>
        {s.status === 'reupload' && s.fileCount ? <label className="pf-keep"><input type="checkbox" checked={keep} onChange={(e) => setKeep(e.target.checked)} />保留上次上传的 {s.fileCount} 张</label> : null}
        <div className="pf-files">
          {picks.map((p, i) => (
            <div key={p.url} className="pf-thumb">
              {p.isImg && !p.broken
                ? <img src={p.url} alt="" onError={() => setPicks((l) => l.map((x, j) => (j === i ? { ...x, broken: true } : x)))} />
                : <span className="pf-doc">{p.isImg ? '照片' : 'PDF'}<small>{p.file.name.slice(-12)}</small></span>}
              <button type="button" aria-label="删除" onClick={() => remove(i)}>×</button>
            </div>
          ))}
          {picks.length < 10 ? (
            <>
              <button type="button" className="pf-add" onClick={() => shoot.current?.click()}>📷<span>拍照</span></button>
              <button type="button" className="pf-add" onClick={() => pick.current?.click()}>🖼<span>相册</span></button>
            </>
          ) : null}
        </div>
        <input ref={shoot} type="file" accept="image/*" capture="environment" style={{ display: 'none' }} onChange={(e) => { add(e.target.files); e.target.value = ''; }} />
        <input ref={pick} type="file" accept="image/*,application/pdf" multiple style={{ display: 'none' }} onChange={(e) => { add(e.target.files); e.target.value = ''; }} />

        {msg ? <div className="pf-err" style={{ marginTop: 12 }}>{msg}</div> : null}
        <button className="pf-submit" disabled={!ready || busy} onClick={submit}>{busy ? '提交中…' : '提交给物业'}</button>
        {!ready ? <p className="pf-muted" style={{ textAlign: 'center' }}>{!plateOk ? '请先输入车牌' : !phoneOk ? '请填写手机号' : s.kind === 'family' && !rel ? '请选择与业主的关系' : '请上传资料照片'}</p> : null}
        <p className="pf-muted" style={{ textAlign: 'center' }}>资料仅用于本小区车辆登记审核</p>
      </div>
    </div>
  );
}
