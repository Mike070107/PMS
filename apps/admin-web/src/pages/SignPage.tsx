import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { SignatureCanvas, type SignatureCanvasHandle } from '../components/SignatureCanvas';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || '/api/v1';

interface SignSession {
  slot: string;
  slotLabel: string;
  paperNo: string | null;
  orderNo: string;
  addressText: string;
  repairItem: string | null;
  unitName: string | null;
  signed: boolean;
  signerName: string | null;
}

/**
 * 手机签名页（`/sign/:token`）—— **不需要登录**，凭据就是链接里那串 5 分钟有效的 token。
 *
 * 办公室在电脑上点「发到手机签」→ 屏幕出二维码 → 微信扫一扫直接到这一页 →
 * 手机横过来签字 → 提交后页面自动关掉（微信里调 WeixinJSBridge.closeWindow）。
 *
 * 竖屏时整页 rotate(90deg)：手机浏览器锁不了屏幕方向（screen.orientation.lock 在微信里没用），
 * 只能把签名区转过来，让人把手机横过来写 —— 竖着写出来的字塞进 2cm 的签名格根本看不清。
 */
export default function SignPage() {
  const { token = '' } = useParams();
  const padRef = useRef<SignatureCanvasHandle | null>(null);
  const [session, setSession] = useState<SignSession | null>(null);
  const [error, setError] = useState('');
  const [empty, setEmpty] = useState(true);
  const [saving, setSaving] = useState(false);
  const [done, setDone] = useState(false);
  const [portrait, setPortrait] = useState(
    typeof window !== 'undefined' ? window.innerHeight > window.innerWidth : false,
  );

  useEffect(() => {
    const onResize = () => setPortrait(window.innerHeight > window.innerWidth);
    window.addEventListener('resize', onResize);
    window.addEventListener('orientationchange', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      window.removeEventListener('orientationchange', onResize);
    };
  }, []);

  useEffect(() => {
    let alive = true;
    fetch(`${API_BASE_URL}/sign/session?token=${encodeURIComponent(token)}`)
      .then(async (res) => {
        const body = await res.json().catch(() => null);
        const payload = body && typeof body === 'object' && 'code' in body ? body.data : body;
        if (!res.ok) throw new Error(body?.message || '链接无效');
        return payload as SignSession;
      })
      .then((data) => {
        if (alive) setSession(data);
      })
      .catch((e) => {
        if (alive) setError(e?.message || '链接已过期，请回电脑上重新生成二维码');
      });
    return () => {
      alive = false;
    };
  }, [token]);

  const submit = useCallback(async () => {
    const image = padRef.current?.toPngDataUrl();
    if (!image) {
      setError('请先写上名字');
      return;
    }
    setSaving(true);
    setError('');
    try {
      const res = await fetch(`${API_BASE_URL}/sign/submit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, image }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.message || '提交失败，请重试');
      setDone(true);
      // 微信里直接把页面关掉；不是微信就留在「已签好」那一屏
      window.setTimeout(closeWebView, 900);
    } catch (e: any) {
      setError(e?.message || '提交失败，请重试');
    } finally {
      setSaving(false);
    }
  }, [token]);

  const body = done ? (
    <div className="pms-sign__done">
      <div className="pms-sign__done-mark">✓</div>
      <div className="pms-sign__done-text">签名已提交</div>
      <div className="pms-sign__done-sub">页面即将关闭，可以把手机还回去了</div>
    </div>
  ) : !session ? (
    <div className="pms-sign__done">
      <div className="pms-sign__done-text">{error || '正在打开签名页…'}</div>
      {error && <div className="pms-sign__done-sub">链接 5 分钟有效，过期请在电脑上重新生成</div>}
    </div>
  ) : (
    <>
      <div className="pms-sign__head">
        <div className="pms-sign__title">
          请 <b>{session.slotLabel}</b> 在下面签名
        </div>
        <div className="pms-sign__meta">
          {[session.paperNo ? `单号 ${session.paperNo}` : '', session.addressText, session.repairItem]
            .filter(Boolean)
            .join(' · ')}
        </div>
        {session.signed && <div className="pms-sign__warn">这一格已经签过了，重新签会覆盖原来的</div>}
      </div>

      <SignatureCanvas ref={padRef} className="pms-sign__pad" onEmptyChange={setEmpty} />

      {error && <div className="pms-sign__error">{error}</div>}

      <div className="pms-sign__foot">
        <button
          type="button"
          className="pms-sign__btn"
          disabled={empty || saving}
          onClick={() => padRef.current?.clear()}
        >
          清空
        </button>
        <button
          type="button"
          className="pms-sign__btn"
          disabled={empty || saving}
          onClick={() => padRef.current?.undo()}
        >
          撤销一笔
        </button>
        <button
          type="button"
          className="pms-sign__btn pms-sign__btn--primary"
          disabled={empty || saving}
          onClick={submit}
        >
          {saving ? '提交中…' : '提交签名'}
        </button>
      </div>
    </>
  );

  return (
    <div className={`pms-sign ${portrait ? 'pms-sign--portrait' : ''}`}>
      {portrait && !done && <div className="pms-sign__rotate-tip">把手机横过来写，字更舒展</div>}
      <div className="pms-sign__stage">{body}</div>
    </div>
  );
}

/** 微信里关掉当前页；不在微信里就尽力而为 */
function closeWebView() {
  const w = window as unknown as {
    WeixinJSBridge?: { call: (name: string) => void };
    close: () => void;
  };
  const call = () => {
    try {
      w.WeixinJSBridge?.call('closeWindow');
    } catch {
      /* 不在微信里，忽略 */
    }
  };
  if (w.WeixinJSBridge) call();
  else document.addEventListener('WeixinJSBridgeReady', call, { once: true });
  window.setTimeout(() => {
    try {
      w.close();
    } catch {
      /* 浏览器不让脚本关非脚本打开的页面，留在「已签好」那一屏就行 */
    }
  }, 400);
}
