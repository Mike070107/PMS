import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { isApiEnvelope } from '@pms/api-client';
import { SignatureCanvas, type SignatureCanvasHandle } from '../components/SignatureCanvas';
import { MaintenanceSheets } from './maintenance/MaintenanceSheet';
import type { MaintenanceOrder, SignSlot } from './maintenance/types';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || '/api/v1';
const SIGN_FIELD: Record<SignSlot, keyof MaintenanceOrder> = {
  filler: 'fillerSignUrl', repairer: 'repairerSignUrl', inspector: 'inspectorSignUrl', owner: 'ownerSignUrl',
};

interface SignSession {
  slot: SignSlot; slotLabel: string; paperNo: string | null; orderNo: string;
  addressText: string; repairItem: string | null; unitName: string | null;
  signed: boolean; signerName: string | null; expiresAt: string; order: MaintenanceOrder;
}

/** 外部移动签字页：完整预览 → 手写 → 回单据核对 → 一次性提交。 */
export default function SignPage() {
  const { token = '' } = useParams();
  const padRef = useRef<SignatureCanvasHandle | null>(null);
  const [session, setSession] = useState<SignSession | null>(null);
  const [draftSign, setDraftSign] = useState('');
  const [mode, setMode] = useState<'preview' | 'sign'>('preview');
  const [scale, setScale] = useState(0.52);
  const [error, setError] = useState('');
  const [empty, setEmpty] = useState(true);
  const [saving, setSaving] = useState(false);
  const [done, setDone] = useState(false);
  const [closeFailed, setCloseFailed] = useState(false);
  const [portrait, setPortrait] = useState(typeof window !== 'undefined' ? window.innerHeight > window.innerWidth : false);

  useEffect(() => {
    const onResize = () => {
      setPortrait(window.innerHeight > window.innerWidth);
      // 227mm 约 858px；初次打开和横竖屏切换时自动适配屏宽。
      setScale(Math.min(1, Math.max(0.35, (window.innerWidth - 20) / 858)));
    };
    onResize();
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
        const payload = isApiEnvelope(body) ? body.data : body;
        if (!res.ok) throw new Error(body?.message || '链接无效');
        return payload as SignSession;
      })
      .then((data) => alive && setSession(data))
      .catch((e) => alive && setError(e?.message || '链接已过期，请重新生成'));
    return () => { alive = false; };
  }, [token]);

  const previewOrder = useMemo(() => {
    if (!session) return null;
    return draftSign ? { ...session.order, [SIGN_FIELD[session.slot]]: draftSign } : session.order;
  }, [draftSign, session]);

  const keepSignature = useCallback(() => {
    const image = padRef.current?.toPngDataUrl();
    if (!image) return setError('请先写上名字');
    setDraftSign(image);
    setError('');
    setMode('preview');
  }, []);

  const submit = useCallback(async () => {
    if (!draftSign) return setError(`请先点击下方“签署${session?.slotLabel || ''}”完成手写签名`);
    setSaving(true); setError('');
    try {
      const res = await fetch(`${API_BASE_URL}/sign/submit`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, image: draftSign }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.message || '提交失败，请重试');
      setDone(true);
      window.setTimeout(closeWebView, 900);
      window.setTimeout(() => setCloseFailed(true), 3000);
    } catch (e: any) {
      setError(e?.message || '提交失败，请重试');
    } finally { setSaving(false); }
  }, [draftSign, session?.slotLabel, token]);

  if (done) return <ResultScreen mark="✓" title="养护单已签署并提交" text={closeFailed ? '已经保存，可以关闭这个页面' : '页面马上自动关闭'} />;
  if (error && !session) return <ResultScreen mark="⏱" title="链接不可用" text={`${error}。请让发送人重新生成一次性链接。`} warn />;
  if (!session || !previewOrder) return <ResultScreen mark="" title="正在打开养护单…" text="" />;

  if (mode === 'sign') {
    return (
      <div className={`pms-sign pms-sign--writing ${portrait ? 'pms-sign--portrait' : ''}`}>
        {portrait && <div className="pms-sign__rotate-tip">把手机横过来写，签名更清楚</div>}
        <div className="pms-sign__stage">
          <div className="pms-sign__head">
            <div className="pms-sign__title">请手写：<b>{session.slotLabel}</b></div>
            <div className="pms-sign__meta">写完返回整张养护单，还可以核对签字位置</div>
          </div>
          <SignatureCanvas ref={padRef} className="pms-sign__pad" onEmptyChange={setEmpty} />
          {error && <div className="pms-sign__error">{error}</div>}
          <div className="pms-sign__foot">
            <button type="button" className="pms-sign__btn" onClick={() => setMode('preview')}>返回预览</button>
            <button type="button" className="pms-sign__btn" disabled={empty} onClick={() => padRef.current?.clear()}>清空</button>
            <button type="button" className="pms-sign__btn" disabled={empty} onClick={() => padRef.current?.undo()}>撤销一笔</button>
            <button type="button" className="pms-sign__btn pms-sign__btn--primary" disabled={empty} onClick={keepSignature}>签好，返回养护单</button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="pms-sign-preview">
      <header className="pms-sign-preview__head">
        <div><h1>养护单预览</h1><p>{[session.paperNo ? `单号 ${session.paperNo}` : session.orderNo, session.addressText].filter(Boolean).join(' · ')}</p></div>
        <div className="pms-sign-preview__zoom" aria-label="预览缩放">
          <button type="button" onClick={() => setScale((v) => Math.max(0.35, v - 0.1))}>－</button>
          <span>{Math.round(scale * 100)}%</span>
          <button type="button" onClick={() => setScale((v) => Math.min(1.6, v + 0.1))}>＋</button>
        </div>
      </header>
      <div className="pms-sign-preview__notice">
        <strong>{draftSign
          ? `${session.slotLabel}已签，请核对后提交`
          : session.signed
            ? `${session.slotLabel}已有签名，本次提交将覆盖原签名`
            : `请签署：${session.slotLabel}`}</strong>
        <span>可双指缩放或使用右上角按钮放大查看，链接提交一次后立即失效</span>
      </div>
      <main className="pms-sign-preview__viewport">
        <div className="pms-sign-preview__paper" style={{ zoom: scale } as React.CSSProperties}>
          <MaintenanceSheets order={previewOrder} editable={false} fontId="zhaizaijia" />
        </div>
      </main>
      {error && <div className="pms-sign-preview__error">{error}</div>}
      <footer className="pms-sign-preview__actions">
        <button type="button" className="pms-sign-preview__sign" onClick={() => { setError(''); setMode('sign'); }}>
          {draftSign ? `重新签署${session.slotLabel}` : `签署${session.slotLabel}`}
        </button>
        <button type="button" className="pms-sign-preview__submit" disabled={!draftSign || saving} onClick={submit}>
          {saving ? '提交中…' : '确认无误并提交'}
        </button>
      </footer>
    </div>
  );
}

function ResultScreen({ mark, title, text, warn = false }: { mark: string; title: string; text: string; warn?: boolean }) {
  return <div className="pms-sign pms-sign--result"><div className="pms-sign__done">
    {mark && <div className={`pms-sign__done-mark ${warn ? 'pms-sign__done-mark--warn' : ''}`}>{mark}</div>}
    <div className="pms-sign__done-text">{title}</div>{text && <div className="pms-sign__done-sub">{text}</div>}
  </div></div>;
}

function closeWebView() {
  const w = window as unknown as { WeixinJSBridge?: { call: (name: string) => void }; close: () => void };
  const call = () => { try { w.WeixinJSBridge?.call('closeWindow'); } catch { /* 非微信环境 */ } };
  if (w.WeixinJSBridge) call(); else document.addEventListener('WeixinJSBridgeReady', call, { once: true });
  window.setTimeout(() => { try { w.close(); } catch { /* 浏览器可能拒绝 */ } }, 400);
}
