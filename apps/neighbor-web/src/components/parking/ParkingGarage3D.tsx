/**
 * 车位 2.5D 示意视图（three.js，正交相机的「伪立体」视角）。
 *
 * 只读：点击车位把整行数据回给页面，由页面打开现有的编辑抽屉；
 * 这里不写库、不调接口。车位档案没有真实坐标，布局按车位号自然顺序
 * 双排 + 车道生成（见 lib/parking-garage-layout.ts），属于示意布局。
 *
 * 性能约定：
 * - 一个 InstancedMesh 渲染全部车位，不逐个建 Mesh；
 * - 地面车位号/车道/阴影一次性画进 CanvasTexture，不额外增加 draw call；
 * - 按需渲染（相机、悬停、筛选变化才重绘），页面隐藏时没有动画循环；
 * - DPR 上限 2，避免高 DPI 手机被像素比拖垮。
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import {
  STATUS_META,
  layoutGarage,
  spaceStatus,
  type GarageLayout,
  type SpaceStatus,
} from '@/lib/parking-garage-layout';
import '@/styles/parking-garage.css';

export interface GarageRow {
  id: number;
  garage: 'main' | 'civil';
  spaceNo: string;
  houseNo?: string | null;
  roomLabel?: string | null;
  address?: string | null;
  plate?: string | null;
  ownerName?: string | null;
  ownerTel?: string | null;
  note?: string | null;
  endDate?: string | null;
}

interface Props {
  /** 全部车位（筛选只改变视觉，不重排列，位置保持稳定） */
  rows: GarageRow[];
  garage: 'main' | 'civil';
  /** 搜索/筛选命中的车位 id；null 表示全部命中 */
  matchIds: Set<number> | null;
  selectedId: number | null;
  onSelect: (row: GarageRow) => void;
}

const GARAGE_LABEL: Record<'main' | 'civil', string> = {
  main: '二期大车库',
  civil: '二期人防车库',
};

const STATUS_ORDER: SpaceStatus[] = ['bound', 'free', 'expiring', 'expired'];

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

function compactPlate(plate?: string | null) {
  return String(plate ?? '').replace(/[·\s.．]/g, '').toUpperCase();
}

export default function ParkingGarage3D({ rows, garage, matchIds, selectedId, onSelect }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const ctlRef = useRef<GarageController | null>(null);
  const [hover, setHover] = useState<GarageRow | null>(null);
  const hoverRowRef = useRef<GarageRow | null>(null);
  const pointerRef = useRef({ x: 0, y: 0 });
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');

  /** 窄屏把车库排得更「竖」一点，车位块和编号才有足够像素。 */
  const [narrow, setNarrow] = useState(
    () => typeof window !== 'undefined' && window.matchMedia('(max-width: 640px)').matches,
  );
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const mq = window.matchMedia('(max-width: 640px)');
    const onChange = () => setNarrow(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  const layout = useMemo(
    () =>
      layoutGarage(rows, {
        perRow: narrow ? Math.max(6, Math.round(Math.sqrt(Math.max(1, rows.length)) * 1.5)) : undefined,
      }),
    [rows, narrow],
  );
  const statuses = useMemo(() => {
    const map = new Map<number, SpaceStatus>();
    for (const row of rows) map.set(row.id, spaceStatus(row));
    return map;
  }, [rows]);
  const counts = useMemo(() => {
    const bucket: Record<SpaceStatus, number> = { bound: 0, free: 0, expiring: 0, expired: 0 };
    for (const status of statuses.values()) bucket[status] += 1;
    return bucket;
  }, [statuses]);

  const selectRef = useRef(onSelect);
  selectRef.current = onSelect;
  const matchRef = useRef(matchIds);
  matchRef.current = matchIds;
  const selectedRef = useRef(selectedId);
  selectedRef.current = selectedId;

  const placeTip = useCallback((x: number, y: number) => {
    const tip = tipRef.current;
    if (!tip) return;
    const w = tip.offsetWidth;
    const h = tip.offsetHeight;
    let left = x + 16;
    let top = y + 18;
    if (left + w + 10 > window.innerWidth) left = x - w - 16;
    if (top + h + 10 > window.innerHeight) top = y - h - 14;
    tip.style.left = `${Math.max(8, left)}px`;
    tip.style.top = `${Math.max(8, top)}px`;
  }, []);

  const handleHover = useCallback(
    (row: GarageRow | null, x: number, y: number) => {
      pointerRef.current = { x, y };
      const tip = tipRef.current;
      if (!row) {
        if (hoverRowRef.current) {
          hoverRowRef.current = null;
          setHover(null);
        }
        if (tip) tip.style.display = 'none';
        return;
      }
      if (tip) {
        tip.style.display = 'block';
        placeTip(x, y);
      }
      if (hoverRowRef.current?.id !== row.id) {
        hoverRowRef.current = row;
        setHover(row);
      }
    },
    [placeTip],
  );

  useLayoutEffect(() => {
    if (hover && tipRef.current) placeTip(pointerRef.current.x, pointerRef.current.y);
  }, [hover, placeTip]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let controller: GarageController;
    try {
      controller = createGarageScene(host, layout, garage, {
        onHover: handleHover,
        onSelect: (row) => selectRef.current(row),
        onReady: () => setReady(true),
        onError: (message) => setError(message),
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : '3D 视图初始化失败，请切回卡片或表格视图');
      return;
    }
    ctlRef.current = controller;
    controller.setMatch(matchRef.current);
    controller.setSelected(selectedRef.current);
    return () => {
      ctlRef.current = null;
      controller.dispose();
      setReady(false);
    };
  }, [layout, garage, handleHover]);

  useEffect(() => {
    ctlRef.current?.setMatch(matchIds);
  }, [matchIds]);

  useEffect(() => {
    ctlRef.current?.setSelected(selectedId);
  }, [selectedId]);

  const hoverStatus = hover ? statuses.get(hover.id) : undefined;
  const noMatch = rows.length > 0 && matchIds !== null && matchIds.size === 0;

  return (
    <div
      className="pgarage"
      role="group"
      aria-label={`${GARAGE_LABEL[garage]}车位 2.5D 示意图，可拖动旋转、滚轮缩放、点击车位编辑`}
    >
      <div className="pgarage__stage" ref={hostRef} aria-hidden="true" />

      {!ready && !error ? <div className="pgarage__status">正在搭建立体车位图…</div> : null}
      {error ? (
        <div className="pgarage__status is-error">
          {error}
          <small>请切回「卡片」或「表格」视图继续操作</small>
        </div>
      ) : null}
      {rows.length === 0 ? <div className="pgarage__status">暂无车位数据</div> : null}
      {noMatch ? <div className="pgarage__nomatch">没有匹配的车位，其余车位已淡出</div> : null}

      <div className="pgarage__legend">
        <span className="pgarage__total">共 {rows.length} 位</span>
        {STATUS_ORDER.map((status) => (
          <span key={status} className="pgarage__legend-item">
            <i style={{ background: STATUS_META[status].color }} />
            {STATUS_META[status].label}
            <b>{counts[status]}</b>
          </span>
        ))}
      </div>

      <div className="pgarage__hint">
        <span>拖动旋转 · 滚轮/双指缩放 · 点击车位查看/编辑</span>
        <span className="pgarage__hint-sub">示意布局 · 按车位号顺序排布</span>
      </div>
      <button
        type="button"
        className="pgarage__reset"
        onClick={() => ctlRef.current?.reset()}
        aria-label="复位车位图视角"
      >
        复位视角
      </button>

      <div className="pgarage__tip" ref={tipRef} style={{ display: hover ? 'block' : 'none' }} aria-hidden="true">
        {hover ? (
          <>
            <div className="pgarage__tip-head">
              <b>{hover.spaceNo}</b>
              <span
                className="pgarage__tip-dot"
                style={{ background: hoverStatus ? STATUS_META[hoverStatus].color : STATUS_META.bound.color }}
              />
              <span>{hoverStatus ? STATUS_META[hoverStatus].label : '已绑车牌'}</span>
            </div>
            <div className="pgarage__tip-plate">{hover.plate ? compactPlate(hover.plate) : '空车位'}</div>
            <dl className="pgarage__tip-kv">
              <dt>房号</dt>
              <dd>{hover.houseNo || hover.roomLabel || hover.address || '—'}</dd>
              <dt>业主</dt>
              <dd>{hover.ownerName || '—'}</dd>
              <dt>有效期</dt>
              <dd>{hover.endDate ? String(hover.endDate).slice(0, 10) : '—'}</dd>
              {hover.note ? (
                <>
                  <dt>备注</dt>
                  <dd>{hover.note}</dd>
                </>
              ) : null}
            </dl>
            <div className="pgarage__tip-foot">点击打开编辑</div>
          </>
        ) : null}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* three.js 场景：只依赖传入的布局，页面卸载时整体释放                  */
/* ------------------------------------------------------------------ */

interface GarageCallbacks {
  onHover: (row: GarageRow | null, x: number, y: number) => void;
  onSelect: (row: GarageRow) => void;
  onReady: () => void;
  onError: (message: string) => void;
}

interface GarageController {
  setMatch: (ids: Set<number> | null) => void;
  setSelected: (id: number | null) => void;
  reset: () => void;
  dispose: () => void;
}

const FLOOR_MARGIN = 3.4;
const DIM_COLOR = '#d3dce7';

function createGarageScene(
  host: HTMLDivElement,
  layout: GarageLayout<GarageRow>,
  garage: 'main' | 'civil',
  callbacks: GarageCallbacks,
): GarageController {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.setClearAlpha(0);
  const canvas = renderer.domElement;
  canvas.className = 'pgarage__canvas';
  host.appendChild(canvas);

  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 600);
  const halfW = layout.width / 2 + FLOOR_MARGIN;
  const halfD = layout.depth / 2 + FLOOR_MARGIN;

  const ELEVATION = 0.94; // 俯角约 54°
  const AZIMUTH_MIN = -1.22;
  const AZIMUTH_MAX = 1.22;
  const AZIMUTH_DEFAULT = -0.44;
  const ZOOM_MIN = 0.55;
  const ZOOM_MAX = 3.4;
  let azimuth = AZIMUTH_DEFAULT;

  const disposables: Array<{ dispose: () => void }> = [];
  const track = <T extends { dispose: () => void }>(item: T) => {
    disposables.push(item);
    return item;
  };

  scene.add(new THREE.HemisphereLight(0xffffff, 0xc7d5e5, 1.25));
  const sun = new THREE.DirectionalLight(0xffffff, 2.0);
  sun.position.set(-halfW * 0.7, 34, halfD * 0.75);
  scene.add(sun);
  const fill = new THREE.DirectionalLight(0xdce8f5, 0.75);
  fill.position.set(halfW * 0.9, 16, -halfD * 0.9);
  scene.add(fill);

  const floorTexture = track(new THREE.CanvasTexture(paintFloor(layout, garage)));
  floorTexture.colorSpace = THREE.SRGBColorSpace;
  floorTexture.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  const floorGeometry = track(new THREE.PlaneGeometry(halfW * 2, halfD * 2));
  const floorMaterial = track(new THREE.MeshBasicMaterial({ map: floorTexture, toneMapped: false }));
  const floor = new THREE.Mesh(floorGeometry, floorMaterial);
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = -0.02;
  scene.add(floor);

  // 车位号单独一层，浮在车位块上方：地面贴图会被 3D 车位块盖住，编号必须抬高。
  const labelsTexture = track(new THREE.CanvasTexture(paintLabels(layout)));
  labelsTexture.colorSpace = THREE.SRGBColorSpace;
  labelsTexture.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  const labelsGeometry = track(new THREE.PlaneGeometry(halfW * 2, halfD * 2));
  const labelsMaterial = track(
    new THREE.MeshBasicMaterial({ map: labelsTexture, transparent: true, depthWrite: false, toneMapped: false }),
  );
  const labels = new THREE.Mesh(labelsGeometry, labelsMaterial);
  labels.rotation.x = -Math.PI / 2;
  labels.position.y = 0.48;
  labels.renderOrder = 3;
  scene.add(labels);

  // 选中车位的深色描边框（浮在编号层之上），点击后一眼能看出选中哪一个
  const frameMaterial = track(
    new THREE.MeshBasicMaterial({ color: 0x16324f, toneMapped: false, depthWrite: false }),
  );
  const frameLongGeo = track(new THREE.BoxGeometry(layout.bayW * 1.06, 0.02, 0.16));
  const frameShortGeo = track(new THREE.BoxGeometry(0.16, 0.02, layout.bayD * 1.06));
  const selectFrame = new THREE.Group();
  [
    { geo: frameLongGeo, x: 0, z: -layout.bayD * 0.53 },
    { geo: frameLongGeo, x: 0, z: layout.bayD * 0.53 },
    { geo: frameShortGeo, x: -layout.bayW * 0.53, z: 0 },
    { geo: frameShortGeo, x: layout.bayW * 0.53, z: 0 },
  ].forEach((piece) => {
    const mesh = new THREE.Mesh(piece.geo, frameMaterial);
    mesh.position.set(piece.x, 0, piece.z);
    mesh.renderOrder = 5;
    selectFrame.add(mesh);
  });
  selectFrame.position.y = 0.52;
  selectFrame.visible = false;
  scene.add(selectFrame);

  const statusColor = new Map<SpaceStatus, THREE.Color>();
  for (const key of STATUS_ORDER) statusColor.set(key, new THREE.Color(STATUS_META[key].color));
  const statusOf = new Map<number, SpaceStatus>();
  for (const cell of layout.cells) statusOf.set(cell.row.id, spaceStatus(cell.row));
  const dimColor = new THREE.Color(DIM_COLOR);
  const white = new THREE.Color(0xffffff);

  let bayMesh: THREE.InstancedMesh | null = null;
  let selectedIndex = -1;
  let matchedIds: Set<number> | null = null;

  const bayGeometry = track(new THREE.BoxGeometry(layout.bayW - 0.18, 0.34, layout.bayD - 0.22));
  const bayMaterial = track(
    new THREE.MeshStandardMaterial({ roughness: 0.86, metalness: 0.02 }),
  );

  if (layout.cells.length) {
    bayMesh = new THREE.InstancedMesh(bayGeometry, bayMaterial, layout.cells.length);
    bayMesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);
    const dummy = new THREE.Object3D();
    layout.cells.forEach((cell, index) => {
      dummy.position.set(cell.x, 0.17, cell.z);
      dummy.rotation.set(0, 0, 0);
      dummy.updateMatrix();
      bayMesh!.setMatrixAt(index, dummy.matrix);
    });
    bayMesh.instanceMatrix.needsUpdate = true;
    scene.add(bayMesh);
  }

  const markerMaterial = track(
    new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.45, depthWrite: false }),
  );
  const markerGeometry = track(new THREE.BoxGeometry(layout.bayW * 1.02, 0.03, layout.bayD * 1.02));
  const hoverMarker = new THREE.Mesh(markerGeometry, markerMaterial);
  hoverMarker.position.y = 0.355;
  hoverMarker.visible = false;
  hoverMarker.renderOrder = 2;
  scene.add(hoverMarker);

  const refreshColors = () => {
    if (!bayMesh) return;
    const scratch = new THREE.Color();
    layout.cells.forEach((cell, index) => {
      const base = statusColor.get(statusOf.get(cell.row.id) ?? 'free') ?? statusColor.get('free')!;
      let color: THREE.Color = base;
      if (index === selectedIndex) color = scratch.copy(base).lerp(white, 0.32);
      else if (matchedIds !== null && !matchedIds.has(cell.row.id)) color = scratch.copy(dimColor);
      bayMesh!.setColorAt(index, color);
    });
    if (bayMesh.instanceColor) bayMesh.instanceColor.needsUpdate = true;
    invalidate();
  };

  const refreshMatrices = () => {
    if (!bayMesh) return;
    const dummy = new THREE.Object3D();
    layout.cells.forEach((cell, index) => {
      dummy.position.set(cell.x, index === selectedIndex ? 0.29 : 0.17, cell.z);
      dummy.rotation.set(0, 0, 0);
      dummy.updateMatrix();
      bayMesh!.setMatrixAt(index, dummy.matrix);
    });
    bayMesh.instanceMatrix.needsUpdate = true;
  };

  const setMatch = (ids: Set<number> | null) => {
    matchedIds = ids;
    // 筛选时只把编号整体压淡，命中的彩色车位仍然最醒目
    labelsMaterial.opacity = ids === null ? 1 : 0.55;
    refreshColors();
  };

  const setSelected = (id: number | null) => {
    const next = id === null ? -1 : layout.cells.findIndex((cell) => cell.row.id === id);
    selectedIndex = next;
    const cell = next >= 0 ? layout.cells[next] : null;
    if (cell) {
      selectFrame.position.set(cell.x, 0.52, cell.z);
      selectFrame.visible = true;
    } else {
      selectFrame.visible = false;
    }
    refreshMatrices();
    refreshColors();
  };

  /* ---------- 相机 ---------- */

  let viewW = 1;
  let viewH = 1;

  const fitFrustum = () => {
    camera.updateMatrixWorld();
    const right = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0).normalize();
    const up = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 1).normalize();
    let maxR = 0;
    let maxU = 0;
    const point = new THREE.Vector3();
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        point.set(sx * halfW, 0, sz * halfD);
        maxR = Math.max(maxR, Math.abs(point.dot(right)));
        maxU = Math.max(maxU, Math.abs(point.dot(up)));
      }
    }
    const aspect = viewW / viewH;
    const halfH = Math.max(maxU * 1.04, (maxR * 1.06) / aspect);
    camera.left = -halfH * aspect;
    camera.right = halfH * aspect;
    camera.top = halfH;
    camera.bottom = -halfH;
    camera.updateProjectionMatrix();
  };

  const pushCamera = () => {
    const horizontal = Math.cos(ELEVATION);
    camera.position.set(
      Math.sin(azimuth) * horizontal * 160,
      Math.sin(ELEVATION) * 160,
      Math.cos(azimuth) * horizontal * 160,
    );
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld();
    fitFrustum();
    invalidate();
  };

  const reset = () => {
    azimuth = AZIMUTH_DEFAULT;
    camera.zoom = 1;
    camera.updateProjectionMatrix();
    pushCamera();
  };

  /* ---------- 渲染与拾取 ---------- */

  let raf = 0;
  let disposed = false;

  function render() {
    raf = 0;
    if (disposed) return;
    renderer.render(scene, camera);
  }

  function invalidate() {
    if (disposed || raf) return;
    raf = requestAnimationFrame(render);
  }

  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();

  const pick = (clientX: number, clientY: number) => {
    if (!bayMesh) return null;
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    ndc.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    raycaster.setFromCamera(ndc, camera);
    const hits = raycaster.intersectObject(bayMesh, false);
    const hit = hits[0];
    if (!hit || typeof hit.instanceId !== 'number') return null;
    const cell = layout.cells[hit.instanceId];
    return cell ? { cell } : null;
  };

  const hideHover = () => {
    hoverMarker.visible = false;
    callbacks.onHover(null, 0, 0);
    invalidate();
  };

  const updateHover = (clientX: number, clientY: number) => {
    const hit = pick(clientX, clientY);
    if (!hit) {
      if (hoverMarker.visible) {
        hoverMarker.visible = false;
        callbacks.onHover(null, clientX, clientY);
        invalidate();
      }
      canvas.style.cursor = 'grab';
      return;
    }
    hoverMarker.position.set(hit.cell.x, 0.36, hit.cell.z);
    hoverMarker.visible = true;
    canvas.style.cursor = 'pointer';
    callbacks.onHover(hit.cell.row, clientX, clientY);
    invalidate();
  };

  /* ---------- 交互 ---------- */

  const pointers = new Map<number, { x: number; y: number }>();
  let drag: { startX: number; startY: number; lastX: number; moved: boolean; azStart: number } | null = null;
  let pinch: { distance: number; zoom: number } | null = null;

  const onPointerDown = (event: PointerEvent) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    canvas.setPointerCapture?.(event.pointerId);
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointers.size === 1) {
      drag = { startX: event.clientX, startY: event.clientY, lastX: event.clientX, moved: false, azStart: azimuth };
      pinch = null;
      hideHover();
    } else if (pointers.size === 2) {
      drag = null;
      const [a, b] = [...pointers.values()];
      pinch = { distance: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)), zoom: camera.zoom };
      hideHover();
    }
  };

  const onPointerMove = (event: PointerEvent) => {
    if (!pointers.has(event.pointerId)) {
      if (event.pointerType === 'mouse') updateHover(event.clientX, event.clientY);
      return;
    }
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });

    if (pinch && pointers.size >= 2) {
      const [a, b] = [...pointers.values()];
      const distance = Math.max(1, Math.hypot(a.x - b.x, a.y - b.y));
      camera.zoom = clamp(pinch.zoom * (distance / pinch.distance), ZOOM_MIN, ZOOM_MAX);
      camera.updateProjectionMatrix();
      invalidate();
      return;
    }

    if (!drag) return;
    if (!drag.moved) {
      const dx = event.clientX - drag.startX;
      const dy = event.clientY - drag.startY;
      if (Math.hypot(dx, dy) > 5) drag.moved = true;
    }
    if (drag.moved) {
      const nextAzimuth = drag.azStart + (event.clientX - drag.startX) * 0.006;
      azimuth = clamp(nextAzimuth, AZIMUTH_MIN, AZIMUTH_MAX);
      pushCamera();
    }
  };

  const onPointerUp = (event: PointerEvent) => {
    const wasTap = !!drag && !drag.moved && pointers.size === 1 && event.type === 'pointerup';
    pointers.delete(event.pointerId);
    if (pointers.size === 0) {
      drag = null;
      pinch = null;
    } else if (pointers.size === 1) {
      const rest = [...pointers.values()][0];
      drag = { startX: rest.x, startY: rest.y, lastX: rest.x, moved: true, azStart: azimuth };
      pinch = null;
    }
    if (wasTap) {
      const hit = pick(event.clientX, event.clientY);
      if (hit) {
        hideHover();
        callbacks.onSelect(hit.cell.row);
      }
    }
  };

  const onPointerLeave = () => {
    if (pointers.size === 0) hideHover();
  };

  const onWheel = (event: WheelEvent) => {
    event.preventDefault();
    camera.zoom = clamp(camera.zoom * Math.exp(-event.deltaY * 0.0016), ZOOM_MIN, ZOOM_MAX);
    camera.updateProjectionMatrix();
    invalidate();
  };

  const controller = new AbortController();
  const { signal } = controller;
  canvas.addEventListener('pointerdown', onPointerDown, { signal });
  canvas.addEventListener('pointermove', onPointerMove, { signal });
  canvas.addEventListener('pointerup', onPointerUp, { signal });
  canvas.addEventListener('pointercancel', onPointerUp, { signal });
  canvas.addEventListener('pointerleave', onPointerLeave, { signal });
  canvas.addEventListener('wheel', onWheel, { signal, passive: false });

  const resize = () => {
    viewW = Math.max(1, host.clientWidth);
    viewH = Math.max(1, host.clientHeight);
    renderer.setSize(viewW, viewH, false);
    fitFrustum();
    invalidate();
  };
  const observer = new ResizeObserver(resize);
  observer.observe(host);

  resize();
  reset();
  setMatch(matchedIds);
  setSelected(null);
  callbacks.onReady();

  return {
    setMatch,
    setSelected,
    reset,
    dispose: () => {
      disposed = true;
      controller.abort();
      observer.disconnect();
      if (raf) cancelAnimationFrame(raf);
      for (const item of disposables) item.dispose();
      if (bayMesh) {
        bayMesh.removeFromParent();
        bayMesh.dispose();
      }
      hoverMarker.removeFromParent();
      selectFrame.removeFromParent();
      renderer.dispose();
      canvas.remove();
    },
  };
}

/* ------------------------------------------------------------------ */
/* 地面贴图：车道、车位格、入口、方向箭头一次性烘焙                     */
/* ------------------------------------------------------------------ */

const FONT_FAMILY = '"HarmonyOS Sans SC", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif';

interface CanvasSpec {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  scale: number;
  X: (x: number) => number;
  Z: (z: number) => number;
  spanX: number;
  spanZ: number;
}

function garageCanvas(layout: GarageLayout<GarageRow>): CanvasSpec | null {
  const spanX = layout.width + FLOOR_MARGIN * 2;
  const spanZ = layout.depth + FLOOR_MARGIN * 2;
  const canvas = document.createElement('canvas');
  const cw = 2048;
  const scale = cw / Math.max(1, spanX);
  const ch = Math.max(64, Math.round(spanZ * scale));
  canvas.width = cw;
  canvas.height = Math.min(4096, ch);
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  const X = (x: number) => (x + spanX / 2) * scale;
  const Z = (z: number) => (z + spanZ / 2) * scale;
  return { canvas, ctx, scale, X, Z, spanX, spanZ };
}

/** 车位号字号：先按车位宽度定基准，再缩到不超框。 */
function fittedFont(ctx: CanvasRenderingContext2D, label: string, maxWidth: number, base: number) {
  let size = Math.max(10, Math.round(base));
  ctx.font = `600 ${size}px ${FONT_FAMILY}`;
  while (size > 9 && ctx.measureText(label).width > maxWidth) {
    size -= 1;
    ctx.font = `600 ${size}px ${FONT_FAMILY}`;
  }
  return size;
}

function paintFloor(layout: GarageLayout<GarageRow>, garage: 'main' | 'civil'): HTMLCanvasElement {
  const spec = garageCanvas(layout);
  if (!spec) {
    const empty = document.createElement('canvas');
    empty.width = 8;
    empty.height = 8;
    return empty;
  }
  const { canvas, ctx, scale, X, Z, spanX, spanZ } = spec;

  ctx.fillStyle = '#e7eef7';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // 外围边界
  ctx.strokeStyle = 'rgba(148, 167, 190, .45)';
  ctx.lineWidth = 2;
  ctx.strokeRect(X(-spanX / 2 + 0.6), Z(-spanZ / 2 + 0.6), (spanX - 1.2) * scale, (spanZ - 1.2) * scale);

  // 车道（比地面更亮）+ 行车方向箭头
  for (let index = 0; index < layout.aisles.length; index += 1) {
    const aisle = layout.aisles[index];
    const top = Z(aisle.zStart);
    const height = aisle.depth * scale;
    ctx.fillStyle = '#eef4fb';
    ctx.fillRect(0, top, canvas.width, height);

    const centerZ = top + height / 2;
    ctx.strokeStyle = 'rgba(122, 143, 168, .42)';
    ctx.lineWidth = Math.max(1.4, scale * 0.08);
    const direction = index % 2 === 0 ? 1 : -1;
    const step = 9;
    for (let x = -spanX / 2 + 4.5; x <= spanX / 2 - 4.5; x += step) {
      const cx = X(x);
      const size = scale * 0.55;
      ctx.beginPath();
      ctx.moveTo(cx - size * 0.55 * direction, centerZ - size * 0.6);
      ctx.lineTo(cx + size * 0.45 * direction, centerZ);
      ctx.lineTo(cx - size * 0.55 * direction, centerZ + size * 0.6);
      ctx.stroke();
    }
  }

  // 车位格：自由车位更浅，已登记车位更亮
  for (const cell of layout.cells) {
    const status = spaceStatus(cell.row);
    const bx = X(cell.x - layout.bayW / 2 + 0.09);
    const by = Z(cell.z - layout.bayD / 2 + 0.09);
    const bw = (layout.bayW - 0.18) * scale;
    const bh = (layout.bayD - 0.22) * scale;

    ctx.save();
    ctx.shadowColor = 'rgba(38, 54, 78, .18)';
    ctx.shadowBlur = scale * 0.26;
    ctx.shadowOffsetY = scale * 0.1;
    roundRect(ctx, bx, by, bw, bh, scale * 0.12);
    ctx.fillStyle = '#f9fbfe';
    ctx.fill();
    ctx.restore();

    roundRect(ctx, bx, by, bw, bh, scale * 0.12);
    ctx.fillStyle = status === 'free' ? '#edf2f9' : '#fcfdff';
    ctx.fill();
    ctx.strokeStyle = status === 'free' ? '#c9d5e3' : '#bccbdd';
    ctx.lineWidth = Math.max(1.2, scale * 0.055);
    ctx.stroke();
  }

  // 入口 / 出口
  const entryZ = Z(layout.depth / 2 + FLOOR_MARGIN * 0.58);
  ctx.fillStyle = '#7e8da3';
  ctx.font = `600 ${Math.round(scale * 0.62)}px ${FONT_FAMILY}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('入 口 / 出 口', canvas.width / 2, entryZ);
  ctx.strokeStyle = 'rgba(126, 141, 163, .85)';
  ctx.lineWidth = Math.max(1.4, scale * 0.06);
  ctx.beginPath();
  ctx.moveTo(canvas.width / 2 - scale * 2.4, entryZ);
  ctx.lineTo(canvas.width / 2 - scale * 0.9, entryZ);
  ctx.moveTo(canvas.width / 2 + scale * 0.9, entryZ);
  ctx.lineTo(canvas.width / 2 + scale * 2.4, entryZ);
  ctx.stroke();

  // 左下角说明（字号小，远看只是纹理）
  ctx.fillStyle = 'rgba(126, 141, 163, .75)';
  ctx.font = `500 ${Math.round(scale * 0.5)}px ${FONT_FAMILY}`;
  ctx.textAlign = 'left';
  ctx.fillText(`${GARAGE_LABEL[garage]} · 车位示意`, X(-spanX / 2 + 1.2), Z(-spanZ / 2 + 1.4));

  return canvas;
}

/* 车位号浮层：透明底，只画编号；白字压在彩色车位块上。 */
function paintLabels(layout: GarageLayout<GarageRow>): HTMLCanvasElement {
  const spec = garageCanvas(layout);
  if (!spec) {
    const empty = document.createElement('canvas');
    empty.width = 8;
    empty.height = 8;
    return empty;
  }
  const { canvas, ctx, scale, X, Z } = spec;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  for (const cell of layout.cells) {
    const status = spaceStatus(cell.row);
    const label = String(cell.row.spaceNo);
    fittedFont(ctx, label, (layout.bayW - 0.6) * scale, scale * 0.78);
    const cy = Z(cell.z + layout.bayD * 0.14);
    if (status === 'free') {
      ctx.fillStyle = 'rgba(84, 99, 121, .92)';
      ctx.shadowColor = 'transparent';
    } else {
      ctx.fillStyle = 'rgba(255, 255, 255, .95)';
      ctx.shadowColor = 'rgba(23, 32, 51, .28)';
      ctx.shadowBlur = Math.max(2, scale * 0.1);
      ctx.shadowOffsetY = Math.max(1, scale * 0.03);
    }
    ctx.fillText(label, X(cell.x), cy);
  }
  ctx.shadowColor = 'transparent';
  return canvas;
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  radius: number,
) {
  const r = Math.min(radius, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
