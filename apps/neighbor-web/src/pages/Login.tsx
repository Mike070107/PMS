import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { auth as authApi } from '@pms/api-client';
import type { AdminLoginResp } from '@pms/api-client/src/endpoints/auth';
import { auth } from '@/lib/auth';
import { apiBaseURL } from '@/lib/api';
import { wechatLaunchHref } from '@/lib/wechatLaunch';
import Icon from '@/components/Icon';
import { toast } from '@/components/ui';

type Mode = 'qr' | 'pwd';

/**
 * 登录页：默认微信登录（打开本机微信 or 扫码），账号密码作为备用。
 * 微信两条路都复用后端 /auth/qr-login/*：出小程序码 → 本人在【邻修管理】确认 → 轮询换 token。
 * 会话存 sessionStorage（与正式后台同一套键），关掉网页即登出。
 */
export default function Login() {
  const nav = useNavigate();
  // 账号密码登录暂时关闭：默认只显示微信登录。
  // 管理员需要兜底时访问 /login?login=password 才会出现「账号密码」页签（接口本身仍开放）。
  const pwdFallback = typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('login') === 'password';
  const [mode, setMode] = useState<Mode>(pwdFallback ? 'pwd' : 'qr');

  const finishLogin = useCallback(async (accessToken: string, user: AdminLoginResp['user']) => {
    auth.setLogin({ accessToken, tokenType: 'Bearer', user });
    const identity = auth.captureIdentity();
    try {
      const meResp = await authApi.me();
      auth.setAccess(meResp?.access ?? null, identity);
    } catch { auth.setAccess(null, identity); }
    if (!auth.isCurrent(identity)) return;
    toast('登录成功');
    const nextParam = new URLSearchParams(window.location.search).get('next');
  const safeNext = nextParam && nextParam.startsWith('/') && !nextParam.startsWith('//') ? nextParam : '/today';
  nav(safeNext, { replace: true });
  }, [nav]);

  return (
    <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', background: 'var(--bg)', padding: 20 }}>
      <div className="card" style={{ width: '100%', maxWidth: 440, padding: '30px 32px 26px', boxShadow: 'var(--sh-m)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 11, marginBottom: 20 }}>
          <div className="logo" style={{ width: 42, height: 42, fontSize: 20, borderRadius: 12 }}>邻</div>
          <div>
            <b style={{ fontSize: 19 }}>邻修</b>
            <div className="muted" style={{ fontSize: 13.5 }}>物业管理平台</div>
          </div>
        </div>

        {pwdFallback && (
        <div className="seg" style={{ display: 'flex', width: '100%', marginBottom: 20 }}>
          <button className={mode === 'qr' ? 'on' : ''} style={{ flex: 1, height: 38, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6 }} onClick={() => setMode('qr')}>
            <Icon name="wechat" size={18} />微信登录
          </button>
          <button className={mode === 'pwd' ? 'on' : ''} style={{ flex: 1, height: 38, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6 }} onClick={() => setMode('pwd')}>
            <Icon name="shield" size={18} />账号密码
          </button>
        </div>)}

        {mode === 'qr' ? <QrPanel onSuccess={finishLogin} /> : <PwdPanel onSuccess={finishLogin} />}

        <p className="muted" style={{ fontSize: 13, marginTop: 18, lineHeight: 1.7, borderTop: '1px solid var(--line2)', paddingTop: 14 }}>
          操作将直接保存至你有权限访问的正式数据，请核对后再提交。
        </p>
      </div>
    </div>
  );
}

/** 账号密码登录：直接 fetch 以读取 429 的 retryAfterSeconds（ApiError 不带响应体）。 */
async function postAdminLogin(account: string, password: string) {
  const base = (apiBaseURL || '').replace(/\/$/, '');
  const res = await fetch(base + '/auth/admin-login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ account, password }),
  });
  const body = await res.json().catch(() => null) as any;
  const text = (value: unknown) => Array.isArray(value) ? value.join('；') : typeof value === 'string' ? value : '';
  if (res.status === 429) {
    return { kind: 'locked' as const, retryAfterSeconds: Number(body?.retryAfterSeconds) || 0, message: text(body?.message) };
  }
  if (!res.ok) {
    const remaining = Number(body?.remainingAttempts ?? body?.attemptsRemaining ?? body?.remainingTries);
    return { kind: 'error' as const, message: text(body?.message) || ('登录失败（' + res.status + '）'), remainingAttempts: Number.isFinite(remaining) && remaining >= 0 ? remaining : null };
  }
  let data = body;
  if (body && typeof body.code === 'number') {
    if (body.code !== 0) throw new Error(text(body.message) || '登录失败');
    data = body.data;
  }
  if (!data?.accessToken || !data?.user) throw new Error('登录返回数据异常');
  return { kind: 'ok' as const, accessToken: data.accessToken, user: data.user as AdminLoginResp['user'] };
}

function PwdPanel({ onSuccess }: { onSuccess: (t: string, u: AdminLoginResp['user']) => Promise<void> }) {
  const [account, setAccount] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [lockUntil, setLockUntil] = useState(0);
  const [attemptsLeft, setAttemptsLeft] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (!lockUntil) return undefined;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [lockUntil]);
  useEffect(() => {
    if (!lockUntil || now < lockUntil) return;
    setLockUntil(0);
    setNow(Date.now());
    setErr('');
  }, [now, lockUntil]);
  const lockLeft = lockUntil ? Math.max(0, Math.ceil((lockUntil - now) / 1000)) : 0;
  const lockClock = lockUntil ? new Date(lockUntil).toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false, hour: '2-digit', minute: '2-digit' }) : '';

  const submit = async () => {
    if (lockLeft > 0) return;
    if (!account.trim() || !password) { setErr('请输入账号和密码'); return; }
    setBusy(true); setErr(''); setAttemptsLeft(null);
    try {
      const r = await postAdminLogin(account.trim(), password);
      if (r.kind === 'ok') {
        setLockUntil(0);
        await onSuccess(r.accessToken, r.user);
      } else if (r.kind === 'locked') {
        const seconds = r.retryAfterSeconds > 0 ? r.retryAfterSeconds : 900;
        setNow(Date.now());
        setLockUntil(Date.now() + seconds * 1000);
        setAttemptsLeft(null);
      } else {
        setErr(r.message);
        setAttemptsLeft(r.remainingAttempts);
      }
    } catch (e) { setErr(e instanceof Error ? e.message : '登录失败'); }
    finally { setBusy(false); }
  };

  return (
    <>
      <div className="field">
        <label>账号</label>
        <input className="in" value={account} autoFocus onChange={(e) => setAccount(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void submit(); }} placeholder="手机号 / 登录账号" />
      </div>
      <div className="field">
        <label>密码</label>
        <input className="in" type="password" value={password} onChange={(e) => setPassword(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void submit(); }} placeholder="密码" />
      </div>
      {lockLeft > 0 ? (
        <div className="note2 login-lock" role="alert">
          <Icon name="alert" />密码错误次数过多，请在 {lockClock} 后重试（剩余 {Math.floor(lockLeft / 60)}:{String(lockLeft % 60).padStart(2, '0')}）
        </div>
      ) : err ? <div className="note2" style={{ background: 'var(--dang-w)', color: 'var(--dang)', borderColor: '#eccac6', marginBottom: 14 }}><Icon name="alert" />{err}{attemptsLeft != null ? `（还可尝试 ${attemptsLeft} 次）` : ''}</div> : null}
      <button className="btn p lg" style={{ width: '100%', justifyContent: 'center' }} disabled={busy || lockLeft > 0} onClick={() => void submit()}>
        {busy ? '登录中…' : '登录'}
      </button>
    </>
  );
}

/**
 * 微信登录面板：
 *  - 「打开本机微信登录」：有 launchScheme 时直接唤起本机微信到确认页（手机/装了微信的电脑）。
 *  - 扫码：出一张【邻修管理】小程序码，本人扫开在手机点确认。
 * 两分钟过期且不自动续：无人看管的机器上挂一张长期有效的码等于把入口摆桌面上，刷新留给人点。
 */
function QrPanel({ onSuccess }: { onSuccess: (t: string, u: AdminLoginResp['user']) => Promise<void> }) {
  const [qrImage, setQrImage] = useState('');
  const [launchScheme, setLaunchScheme] = useState<string | null>(null);
  const [expiresAt, setExpiresAt] = useState(0);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState<'pending' | 'scanned' | 'expired' | 'cancelled'>('pending');
  const [errorMsg, setErrorMsg] = useState('');
  const timerRef = useRef<number | null>(null);
  const aliveRef = useRef(true);

  const stopPolling = () => { if (timerRef.current) { window.clearInterval(timerRef.current); timerRef.current = null; } };

  const load = useCallback(async () => {
    stopPolling();
    setLoading(true); setLaunchScheme(null); setErrorMsg(''); setStatus('pending');
    try {
      const requestedAt = Date.now();
      const t = await authApi.qrLoginTicket();
      if (!aliveRef.current) return;
      setQrImage(t.qrImage);
      setLaunchScheme(t.launchScheme ?? null);
      const deadline = requestedAt + t.expiresIn * 1000;
      setExpiresAt(deadline);
      setLoading(false);
      timerRef.current = window.setInterval(async () => {
        if (Date.now() >= deadline) { stopPolling(); setStatus('expired'); return; }
        try {
          const r = await authApi.qrLoginStatus(t.ticket);
          if (!aliveRef.current) return;
          if (r.status === 'confirmed' && r.accessToken && r.user) { stopPolling(); await onSuccess(r.accessToken, r.user); return; }
          if (r.status === 'expired' || r.status === 'cancelled') { stopPolling(); setStatus(r.status); return; }
          if (r.status === 'pending' || r.status === 'scanned') setStatus(r.status);
        } catch { /* 轮询抖动，下一轮再问 */ }
      }, 2000);
    } catch (e) {
      if (!aliveRef.current) return;
      setLoading(false);
      setErrorMsg(e instanceof Error ? e.message : '二维码加载失败');
    }
  }, [onSuccess]);

  useEffect(() => {
    aliveRef.current = true;
    void load();
    return () => { aliveRef.current = false; stopPolling(); };
  }, [load]);

  const dead = status === 'expired' || status === 'cancelled';
  const launchHref = wechatLaunchHref(launchScheme, status, loading, expiresAt);
  const hint = status === 'scanned' ? '已打开微信，请在手机上点「确认登录」'
    : status === 'cancelled' ? '你在微信中拒绝了这次登录'
      : status === 'expired' ? '二维码已过期，点上方刷新'
        : '用微信扫码，在【邻修管理】里确认';

  if (errorMsg) {
    return (
      <div style={{ textAlign: 'center', padding: '24px 8px' }}>
        <div className="note2" style={{ background: 'var(--dang-w)', color: 'var(--dang)', borderColor: '#eccac6', marginBottom: 16, textAlign: 'left' }}><Icon name="alert" />{errorMsg}</div>
        <button className="btn" onClick={() => void load()}><Icon name="refresh" size={18} />重试</button>
      </div>
    );
  }

  return (
    <div style={{ textAlign: 'center' }}>
      <a
        className="btn p lg"
        style={{ width: '100%', justifyContent: 'center', marginBottom: 10, opacity: launchHref ? 1 : 0.5, pointerEvents: launchHref ? 'auto' : 'none' }}
        href={launchHref}
        onClick={(e) => { if (!launchHref) { e.preventDefault(); if (Date.now() >= expiresAt) setStatus('expired'); } }}
      >
        <Icon name="wechat" size={20} />打开本机微信登录
      </a>
      <div className="muted" style={{ fontSize: 13, margin: '0 0 16px', lineHeight: 1.6 }}>
        {dead ? '本次登录已失效，请刷新二维码后重试。' : !loading && !launchScheme ? '暂时无法唤起微信，请用下方二维码。' : '在微信中确认后自动登录；未唤起请扫码。'}
      </div>

      <div style={{ position: 'relative', width: 196, height: 196, margin: '0 auto', display: 'grid', placeItems: 'center', border: '1px solid var(--line)', borderRadius: 14, overflow: 'hidden', background: 'var(--sunken)' }}>
        {loading ? <span className="muted">生成中…</span> : (
          <>
            <img src={qrImage} alt="微信扫码登录" style={{ width: '100%', height: '100%', objectFit: 'contain', filter: dead ? 'blur(3px)' : undefined }} />
            {dead ? (
              <div style={{ position: 'absolute', inset: 0, background: 'rgba(255,255,255,.82)', display: 'grid', placeItems: 'center' }}>
                <button className="btn p" onClick={() => void load()}><Icon name="refresh" size={18} />刷新二维码</button>
              </div>
            ) : null}
          </>
        )}
      </div>

      <div style={{ marginTop: 14, fontSize: 14, fontWeight: status === 'scanned' ? 700 : 400, color: status === 'scanned' ? 'var(--acc-t)' : 'var(--ink3)' }}>{hint}</div>
      <div className="muted" style={{ marginTop: 8, fontSize: 12, lineHeight: 1.7 }}>
        首次使用请先在【邻修管理】小程序用微信手机号登录一次；手机号需与管理员登记的一致。
      </div>
    </div>
  );
}
