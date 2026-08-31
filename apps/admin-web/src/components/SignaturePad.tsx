import { useCallback, useEffect, useRef, useState } from 'react';
import { App as AntdApp, Button, Modal, Space, Typography } from 'antd';
import { auth } from '../lib/auth';

const { Text } = Typography;
const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || '/api/v1';

/**
 * 手写签名板：鼠标、手指、触控笔都能签（pointer 事件一套通吃，平板上直接用手写）。
 *
 * 签完导出成**裁掉空白、背景透明**的 PNG 再上传：养护单上的签名格只有一厘米高，
 * 不裁的话整块白底会把格线盖掉，看着像贴了张纸。
 */

interface Point {
  x: number;
  y: number;
}

export function SignaturePad({
  open,
  title,
  hint,
  confirmText = '确认签名',
  onCancel,
  onDone,
}: {
  open: boolean;
  title: string;
  hint?: string;
  confirmText?: string;
  onCancel: () => void;
  /** 上传完成后回调签名图片地址 */
  onDone: (url: string) => void | Promise<void>;
}) {
  const { message } = AntdApp.useApp();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const strokesRef = useRef<Point[][]>([]);
  const drawingRef = useRef(false);
  const [empty, setEmpty] = useState(true);
  const [saving, setSaving] = useState(false);

  const redraw = useCallback(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = '#111111';
    ctx.lineWidth = 3 * (canvas.width / (canvas.clientWidth || 1));
    for (const stroke of strokesRef.current) {
      if (!stroke.length) continue;
      ctx.beginPath();
      ctx.moveTo(stroke[0].x, stroke[0].y);
      for (const point of stroke.slice(1)) ctx.lineTo(point.x, point.y);
      // 只点一下也要留个点，不然「点」出来的顿笔全丢了
      if (stroke.length === 1) ctx.lineTo(stroke[0].x + 0.1, stroke[0].y);
      ctx.stroke();
    }
    setEmpty(strokesRef.current.every((stroke) => !stroke.length));
  }, []);

  /** 画布按显示尺寸 × dpr 建，笔迹才不是马赛克 */
  const fitCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const width = canvas.clientWidth || 600;
    const height = canvas.clientHeight || 220;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    redraw();
  }, [redraw]);

  useEffect(() => {
    if (!open) return;
    strokesRef.current = [];
    setEmpty(true);
    // Modal 有开场动画，画布这一帧还没有尺寸，等一帧再量
    const timer = window.setTimeout(fitCanvas, 60);
    window.addEventListener('resize', fitCanvas);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('resize', fitCanvas);
    };
  }, [open, fitCanvas]);

  const pointOf = (e: React.PointerEvent<HTMLCanvasElement>): Point => {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    const scale = canvas.width / rect.width;
    return { x: (e.clientX - rect.left) * scale, y: (e.clientY - rect.top) * scale };
  };

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    canvasRef.current?.setPointerCapture(e.pointerId);
    drawingRef.current = true;
    strokesRef.current.push([pointOf(e)]);
    redraw();
  };

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawingRef.current) return;
    e.preventDefault();
    strokesRef.current[strokesRef.current.length - 1]?.push(pointOf(e));
    redraw();
  };

  const stop = () => {
    drawingRef.current = false;
  };

  const undo = () => {
    strokesRef.current.pop();
    redraw();
  };

  const clear = () => {
    strokesRef.current = [];
    redraw();
  };

  const save = async () => {
    const canvas = canvasRef.current;
    if (!canvas || empty) {
      message.error('请先手写签名');
      return;
    }
    setSaving(true);
    try {
      const blob = await trimmedPng(canvas);
      if (!blob) throw new Error('签名导出失败');
      const url = await uploadSignature(blob);
      await onDone(url);
    } catch (e: any) {
      message.error(e?.message || '签名保存失败');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      title={title}
      width={720}
      onCancel={onCancel}
      destroyOnHidden
      footer={
        <Space>
          <Button size="large" onClick={clear} disabled={empty || saving}>
            清空
          </Button>
          <Button size="large" onClick={undo} disabled={empty || saving}>
            撤销一笔
          </Button>
          <Button size="large" onClick={onCancel} disabled={saving}>
            取消
          </Button>
          <Button size="large" type="primary" loading={saving} onClick={save} disabled={empty}>
            {confirmText}
          </Button>
        </Space>
      }
    >
      <Text type="secondary" style={{ display: 'block', marginBottom: 12, lineHeight: 1.6 }}>
        {hint || '在下面的框里手写姓名。用平板或触摸屏可以直接用手指/触控笔签。'}
      </Text>
      <canvas
        ref={canvasRef}
        className="pms-signpad"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={stop}
        onPointerCancel={stop}
        onPointerLeave={stop}
      />
    </Modal>
  );
}

/** 裁掉四周空白，导出透明底 PNG */
function trimmedPng(canvas: HTMLCanvasElement): Promise<Blob | null> {
  const ctx = canvas.getContext('2d');
  if (!ctx) return Promise.resolve(null);
  const { width, height } = canvas;
  const data = ctx.getImageData(0, 0, width, height).data;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (data[(y * width + x) * 4 + 3] > 8) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return Promise.resolve(null);
  const pad = Math.round(4 * (window.devicePixelRatio || 1));
  minX = Math.max(0, minX - pad);
  minY = Math.max(0, minY - pad);
  maxX = Math.min(width - 1, maxX + pad);
  maxY = Math.min(height - 1, maxY + pad);
  const out = document.createElement('canvas');
  out.width = maxX - minX + 1;
  out.height = maxY - minY + 1;
  out.getContext('2d')?.drawImage(
    canvas,
    minX,
    minY,
    out.width,
    out.height,
    0,
    0,
    out.width,
    out.height,
  );
  return new Promise((resolve) => out.toBlob((blob) => resolve(blob), 'image/png'));
}

async function uploadSignature(blob: Blob): Promise<string> {
  const form = new FormData();
  form.append('file', blob, `signature-${Date.now()}.png`);
  const headers: Record<string, string> = {};
  const token = auth.getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  const acting = auth.getActingTenant();
  if (acting) headers['x-acting-tenant-id'] = String(acting.id);
  const res = await fetch(`${API_BASE_URL}/upload`, { method: 'POST', headers, body: form });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.message || `签名上传失败（HTTP ${res.status}）`);
  }
  const body = await res.json();
  const payload = body && typeof body === 'object' && 'code' in body ? body.data : body;
  const url = payload?.displayUrl || payload?.publicUrl;
  if (!url) throw new Error('签名上传失败：服务端没有返回图片地址');
  return url as string;
}
