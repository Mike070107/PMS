import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { auth as authApi } from '@pms/api-client';
import { auth } from '@/lib/auth';
import { toast } from '@/components/ui';

/**
 * 登录页：设计稿没有给它出图，这里按同一套浅色绿调做，只放账号密码。
 * 会话存在 sessionStorage（和正式后台同一套键），关掉网页即登出。
 */
export default function Login() {
  const nav = useNavigate();
  const [account, setAccount] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const submit = async () => {
    if (!account.trim() || !password) { setErr('请输入账号和密码'); return; }
    setBusy(true);
    setErr('');
    try {
      const resp = await authApi.adminLogin({ account: account.trim(), password });
      auth.setLogin(resp);
      toast('登录成功');
      nav('/today', { replace: true });
    } catch (e) {
      setErr(e instanceof Error ? e.message : '登录失败');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', background: 'var(--bg)', padding: 20 }}>
      <div className="card" style={{ width: 380, padding: '28px 28px 24px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 22 }}>
          <div className="logo" style={{ width: 36, height: 36, fontSize: 18 }}>邻</div>
          <div>
            <b style={{ fontSize: 18 }}>邻修</b>
            <div className="muted" style={{ fontSize: 12.5 }}>物业管理平台 · 新版测试环境</div>
          </div>
        </div>

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

        {err ? <div className="note" style={{ background: 'var(--dang-w)', color: 'var(--dang)', marginBottom: 14 }}>{err}</div> : null}

        <button className="btn p lg" style={{ width: '100%', justifyContent: 'center' }} disabled={busy} onClick={() => void submit()}>
          {busy ? '登录中…' : '登录'}
        </button>

        <p className="muted" style={{ fontSize: 12.5, marginTop: 16, lineHeight: 1.7 }}>
          这是新版界面的测试环境，数据和账号与正式系统完全共用：
          在这里做的增删改会直接落到正式数据上。
        </p>
      </div>
    </div>
  );
}
