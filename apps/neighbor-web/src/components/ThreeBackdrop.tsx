import { useEffect, useRef, useState } from 'react';

let warnedWebGL = false;

/**
 * 大屏背景装饰：Three.js 粒子 + 缓慢光带。
 * 只做装饰，不承载任何数据；数据图表仍用 SVG/2D。
 * - 动态 import('three')，只有 /screen 会加载，构建为独立 chunk
 * - reduced-motion / 无 WebGL 时回退静态 CSS 背景
 * - 页面隐藏时暂停 rAF；卸载时 dispose
 */
export default function ThreeBackdrop({ reducedMotion }: { reducedMotion: boolean }) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [fallback, setFallback] = useState(reducedMotion);

  useEffect(() => {
    if (reducedMotion) { setFallback(true); return undefined; }
    setFallback(false);
    let disposed = false;
    let cleanup = () => {};

    import('three').then((THREE) => {
      if (disposed) return;
      const host = hostRef.current;
      if (!host) return;

      let renderer: InstanceType<typeof THREE.WebGLRenderer>;
      try {
        renderer = new THREE.WebGLRenderer({ alpha: true, antialias: false, powerPreference: 'low-power' });
        if (!renderer.getContext()) throw new Error('no webgl context');
      } catch {
        if (!warnedWebGL) {
          warnedWebGL = true;
          console.warn('[ThreeBackdrop] WebGL 不可用，已回退静态背景');
        }
        setFallback(true);
        return;
      }
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
      renderer.setSize(window.innerWidth, window.innerHeight);
      renderer.setClearColor(0x000000, 0);
      renderer.domElement.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:block;pointer-events:none';
      host.appendChild(renderer.domElement);

      const scene = new THREE.Scene();
      const camera = new THREE.OrthographicCamera(-window.innerWidth / 2, window.innerWidth / 2, window.innerHeight / 2, -window.innerHeight / 2, 0.1, 100);
      camera.position.z = 10;

      // 粒子：约 780 个，主题蓝/青，低透明度，极慢流动
      const COUNT = 900;
      const positions = new Float32Array(COUNT * 3);
      const colors = new Float32Array(COUNT * 3);
      const speeds = new Float32Array(COUNT);
      const drift = new Float32Array(COUNT);
      const palette = [new THREE.Color('#7dbdff'), new THREE.Color('#6ef0d8'), new THREE.Color('#b8e4ff')];
      for (let i = 0; i < COUNT; i += 1) {
        positions[i * 3] = (Math.random() - 0.5) * window.innerWidth;
        positions[i * 3 + 1] = (Math.random() - 0.5) * window.innerHeight;
        positions[i * 3 + 2] = Math.random() * 2;
        const color = palette[i % palette.length];
        colors[i * 3] = color.r;
        colors[i * 3 + 1] = color.g;
        colors[i * 3 + 2] = color.b;
        speeds[i] = 1.2 + Math.random() * 3.2; // px/s，极慢
        drift[i] = (Math.random() - 0.5) * 0.5;
      }
      const particleGeometry = new THREE.BufferGeometry();
      particleGeometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      particleGeometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
      const particleMaterial = new THREE.PointsMaterial({
        size: 2.8,
        vertexColors: true,
        transparent: true,
        opacity: 0.55,
        depthWrite: false,
        sizeAttenuation: false,
        blending: THREE.AdditiveBlending,
      });
      const particles = new THREE.Points(particleGeometry, particleMaterial);
      scene.add(particles);
      // 简单加色光晕：同一粒子几何放大一层低透明度点，不引后处理库
      const glowMaterial = new THREE.PointsMaterial({ size: 6.2, vertexColors: true, transparent: true, opacity: 0.10, depthWrite: false, sizeAttenuation: false, blending: THREE.AdditiveBlending });
      const glow = new THREE.Points(particleGeometry, glowMaterial);
      scene.add(glow);

      // 一条从左向右缓慢横穿的光带（约 12 秒），多层叠加做出拖尾
      const bandWidth = Math.max(240, window.innerWidth * 0.26);
      const bandLayers = [
        { width: bandWidth, opacity: 0.11, color: 0x2f8fd0 },
        { width: bandWidth * 0.55, opacity: 0.10, color: 0x5fc8ff },
        { width: bandWidth * 0.16, opacity: 0.14, color: 0xa6ecff },
      ].map((layer) => {
        const geometry = new THREE.PlaneGeometry(layer.width, window.innerHeight * 1.25);
        const material = new THREE.MeshBasicMaterial({ color: layer.color, transparent: true, opacity: layer.opacity, depthWrite: false, blending: THREE.AdditiveBlending });
        const mesh = new THREE.Mesh(geometry, material);
        scene.add(mesh);
        return { mesh, geometry, material, width: layer.width };
      });

      let raf = 0;
      let last = performance.now();
      let visible = document.visibilityState !== 'hidden';
      let infoLogged = false;
      const loop = (now: number) => {
        const dt = Math.min(0.05, (now - last) / 1000);
        last = now;
        const halfW = window.innerWidth / 2;
        const halfH = window.innerHeight / 2;
        if (visible) {
          for (let i = 0; i < COUNT; i += 1) {
            let x = positions[i * 3] + speeds[i] * dt;
            if (x > halfW + 8) x = -halfW - 8;
            positions[i * 3] = x;
            positions[i * 3 + 1] += drift[i] * dt;
            if (positions[i * 3 + 1] > halfH) positions[i * 3 + 1] = -halfH;
            if (positions[i * 3 + 1] < -halfH) positions[i * 3 + 1] = halfH;
          }
          particleGeometry.attributes.position.needsUpdate = true;
          const cycle = ((now / 1000) % 12) / 12;
          for (let i = 0; i < bandLayers.length; i += 1) {
            const layer = bandLayers[i];
            layer.mesh.position.x = -halfW - layer.width / 2 + cycle * (window.innerWidth + layer.width) - i * layer.width * 0.22;
          }
          renderer.render(scene, camera);
        }
        raf = requestAnimationFrame(loop);
      };
      raf = requestAnimationFrame(loop);

      const onVisibility = () => {
        visible = document.visibilityState !== 'hidden';
        last = performance.now();
        if (!visible && !infoLogged) {
          infoLogged = true;
          console.info('[ThreeBackdrop] 页面隐藏，渲染循环已暂停');
        } else if (visible) {
          infoLogged = false;
          console.info('[ThreeBackdrop] 页面恢复，渲染循环继续');
        }
      };
      const onResize = () => {
        renderer.setSize(window.innerWidth, window.innerHeight);
        camera.left = -window.innerWidth / 2;
        camera.right = window.innerWidth / 2;
        camera.top = window.innerHeight / 2;
        camera.bottom = -window.innerHeight / 2;
        camera.updateProjectionMatrix();
      };
      document.addEventListener('visibilitychange', onVisibility);
      window.addEventListener('resize', onResize);

      cleanup = () => {
        cancelAnimationFrame(raf);
        document.removeEventListener('visibilitychange', onVisibility);
        window.removeEventListener('resize', onResize);
        particleGeometry.dispose();
        particleMaterial.dispose();
        glowMaterial.dispose();
        bandLayers.forEach((layer) => { layer.geometry.dispose(); layer.material.dispose(); });
        renderer.dispose();
        renderer.forceContextLoss();
        renderer.domElement.remove();
      };
    }).catch((error) => {
      if (!warnedWebGL) {
        warnedWebGL = true;
        console.warn('[ThreeBackdrop] three 加载失败，已回退静态背景', error);
      }
      setFallback(true);
    });

    return () => { disposed = true; cleanup(); };
  }, [reducedMotion]);

  return <div ref={hostRef} className={'scr-three' + (fallback || reducedMotion ? ' static' : '')} aria-hidden="true" />;
}
