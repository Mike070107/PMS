import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';

/**
 * 手写签名画布：鼠标、手指、触控笔都能签（pointer 事件一套通吃）。
 *
 * 电脑上的签名弹窗（SignaturePad）和手机上的签名页（SignPage）共用这一块 ——
 * 两处各写一套的话，笔迹粗细、裁白边、透明底这些细节迟早会不一样。
 *
 * 导出的是**裁掉空白、背景透明**的 PNG：养护单上的签名格只有一厘米高，
 * 不裁的话整块白底会把格线盖掉，看着像贴了张纸。
 */

export interface SignatureCanvasHandle {
  clear(): void;
  undo(): void;
  isEmpty(): boolean;
  /** 裁白边、透明底的 PNG；没签就是 null */
  toPngDataUrl(): string | null;
  toPngBlob(): Promise<Blob | null>;
}

interface Point {
  x: number;
  y: number;
}

export const SignatureCanvas = forwardRef<
  SignatureCanvasHandle,
  {
    className?: string;
    /** 笔迹从无到有 / 被清空时回调，用来切换按钮的可用状态 */
    onEmptyChange?: (empty: boolean) => void;
  }
>(function SignatureCanvas({ className = '', onEmptyChange }, ref) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const strokesRef = useRef<Point[][]>([]);
  const drawingRef = useRef(false);
  const [empty, setEmpty] = useState(true);

  const markEmpty = useCallback(
    (next: boolean) => {
      setEmpty((prev) => {
        if (prev !== next) onEmptyChange?.(next);
        return next;
      });
    },
    [onEmptyChange],
  );

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
    markEmpty(strokesRef.current.every((stroke) => !stroke.length));
  }, [markEmpty]);

  /** 画布按显示尺寸 × dpr 建，笔迹才不是马赛克 */
  const fitCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const width = canvas.clientWidth || 600;
    const height = canvas.clientHeight || 220;
    const nextW = Math.round(width * dpr);
    const nextH = Math.round(height * dpr);
    if (canvas.width === nextW && canvas.height === nextH) return;
    canvas.width = nextW;
    canvas.height = nextH;
    redraw();
  }, [redraw]);

  useEffect(() => {
    // 弹窗/页面有进场动画，这一帧画布还没有尺寸，等一帧再量；转屏也要重量
    const timer = window.setTimeout(fitCanvas, 60);
    window.addEventListener('resize', fitCanvas);
    window.addEventListener('orientationchange', fitCanvas);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('resize', fitCanvas);
      window.removeEventListener('orientationchange', fitCanvas);
    };
  }, [fitCanvas]);

  /**
   * 屏幕坐标 → 画布坐标。
   *
   * 用 offsetX/offsetY，**不要**用 clientX - rect.left：手机竖屏时整块签名区是
   * rotate(90deg) 转过来的，getBoundingClientRect 给的是旋转后的外接矩形，
   * 按它换算笔迹会落到画布外（实测：画了一笔，画布上一个像素都没有）。
   * offsetX/offsetY 本来就是相对元素自身坐标系的，转不转都对。
   */
  const pointOf = (e: React.PointerEvent<HTMLCanvasElement>): Point => {
    const canvas = canvasRef.current!;
    const native = e.nativeEvent as PointerEvent;
    const scaleX = canvas.width / (canvas.clientWidth || 1);
    const scaleY = canvas.height / (canvas.clientHeight || 1);
    return { x: native.offsetX * scaleX, y: native.offsetY * scaleY };
  };

  useImperativeHandle(
    ref,
    () => ({
      clear() {
        strokesRef.current = [];
        redraw();
      },
      undo() {
        strokesRef.current.pop();
        redraw();
      },
      isEmpty: () => strokesRef.current.every((stroke) => !stroke.length),
      toPngDataUrl() {
        const out = trimmed(canvasRef.current);
        return out ? out.toDataURL('image/png') : null;
      },
      toPngBlob() {
        const out = trimmed(canvasRef.current);
        if (!out) return Promise.resolve(null);
        return new Promise((resolve) => out.toBlob((blob) => resolve(blob), 'image/png'));
      },
    }),
    [redraw],
  );

  return (
    <canvas
      ref={canvasRef}
      className={`pms-signpad ${className}`}
      data-empty={empty ? '1' : '0'}
      onPointerDown={(e) => {
        e.preventDefault();
        canvasRef.current?.setPointerCapture(e.pointerId);
        drawingRef.current = true;
        strokesRef.current.push([pointOf(e)]);
        redraw();
      }}
      onPointerMove={(e) => {
        if (!drawingRef.current) return;
        e.preventDefault();
        strokesRef.current[strokesRef.current.length - 1]?.push(pointOf(e));
        redraw();
      }}
      onPointerUp={() => {
        drawingRef.current = false;
      }}
      onPointerCancel={() => {
        drawingRef.current = false;
      }}
      onPointerLeave={() => {
        drawingRef.current = false;
      }}
    />
  );
});

/** 裁掉四周空白，返回一块只有笔迹的画布（没笔迹返回 null） */
function trimmed(canvas: HTMLCanvasElement | null): HTMLCanvasElement | null {
  const ctx = canvas?.getContext('2d');
  if (!canvas || !ctx) return null;
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
  if (maxX < 0) return null;
  const pad = Math.round(4 * (window.devicePixelRatio || 1));
  minX = Math.max(0, minX - pad);
  minY = Math.max(0, minY - pad);
  maxX = Math.min(width - 1, maxX + pad);
  maxY = Math.min(height - 1, maxY + pad);
  const out = document.createElement('canvas');
  out.width = maxX - minX + 1;
  out.height = maxY - minY + 1;
  out
    .getContext('2d')
    ?.drawImage(canvas, minX, minY, out.width, out.height, 0, 0, out.width, out.height);
  return out;
}
