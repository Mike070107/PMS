import { Suspense, lazy as reactLazy, useEffect, useState, type ComponentType } from 'react';

/** 懒加载失败（发布后旧页面文件已不在）时刷新一次拿新版，而不是白屏 */
function lazy<T extends ComponentType<any>>(load: () => Promise<{ default: T }>) {
  return reactLazy(() => load().catch((e) => {
    const last = Number(sessionStorage.getItem('pms.chunkReload') || 0);
    if (Date.now() - last > 10_000) { sessionStorage.setItem('pms.chunkReload', String(Date.now())); window.location.reload(); }
    throw e;
  }));
}
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { auth as authApi } from '@pms/api-client';
import { auth, useSession, type SessionIdentity } from '@/lib/auth';
import { apiBaseURL } from '@/lib/api';
import { canViewPath, firstAllowedPath, pageForPath } from '@/lib/page-access';
import { can } from '@/lib/perm';
import Shell from '@/components/Shell';
import Login from '@/pages/Login';
import { Loading, Toaster } from '@/components/ui';

const Today = lazy(() => import('@/pages/Today'));
const WorkOrders = lazy(() => import('@/pages/WorkOrders'));
const Cashier = lazy(() => import('@/pages/Cashier'));
const Records = lazy(() => import('@/pages/Records'));
const Pending = lazy(() => import('@/pages/Pending'));
const Standards = lazy(() => import('@/pages/Standards'));
const Houses = lazy(() => import('@/pages/Houses'));
const Owners = lazy(() => import('@/pages/Owners'));
const Experience = lazy(() => import('@/pages/Experience'));
const MigratedApartment = lazy(() => import('@/pages/MigratedApartment'));
const MigratedMeters = lazy(() => import('@/pages/MigratedMeters'));
const Fees = lazy(() => import('@/pages/Fees'));
const ParkingSpaces = lazy(() => import('@/pages/ParkingSpaces'));
const Reports = lazy(() => import('@/pages/Reports'));
const Materials = lazy(() => import('@/pages/Materials'));
const Stocktakes = lazy(() => import('@/pages/Stocktakes'));
const Staff = lazy(() => import('@/pages/Staff'));
const Offices = lazy(() => import('@/pages/Offices'));
const QrCodes = lazy(() => import('@/pages/QrCodes'));
const Intranet = lazy(() => import('@/pages/Intranet'));
const Logs = lazy(() => import('@/pages/Logs'));
const Bills = lazy(() => import('@/pages/Bills'));
const Maintenance = lazy(() => import('@/pages/Maintenance'));
const Vehicles = lazy(() => import('@/pages/Vehicles'));
const Devices = lazy(() => import('@/pages/Devices'));
const Purchase = lazy(() => import('@/pages/Purchase'));
const Stock = lazy(() => import('@/pages/Stock'));
const Settings = lazy(() => import('@/pages/Settings'));
const Plates = lazy(() => import('@/pages/Plates'));
const FamilyCars = lazy(() => import('@/pages/FamilyCars'));
const PlateForm = lazy(() => import('@/pages/PlateForm'));
const ScreenPage = lazy(() => import('@/pages/Screen'));
const ScreenSettings = lazy(() => import('@/pages/ScreenSettings'));

/** 页面访问埋点：30 秒或满 20 条批量发一次；页面隐藏/卸载时 flush，fetch keepalive 失败再走 sendBeacon。 */
type TelemetryView = { path: string; pageKey?: string };
const TELEMETRY_BATCH = 20;
const TELEMETRY_FLUSH_MS = 30_000;
const TELEMETRY_SKIP = ['/login', '/intro', '/screen', '/m/plate'];
const telemetryQueue: TelemetryView[] = [];

function telemetryAllowed(pathname: string) {
  if (!pathname || !pathname.startsWith('/')) return false;
  return !TELEMETRY_SKIP.some((prefix) => pathname === prefix || pathname.startsWith(prefix + '/'));
}
function telemetryPageKey(pathname: string) {
  const page = pageForPath(pathname);
  return page?.keys?.[0] || pathname.split('/').filter(Boolean)[0] || 'root';
}
function telemetryHeaders(): Record<string, string> {
  const headers: Record<string, string> = { 'content-type': 'application/json', 'x-client-source': 'admin-web' };
  const token = auth.getToken();
  if (token) headers.Authorization = 'Bearer ' + token;
  const tenant = auth.getActingTenant();
  if (tenant) headers['x-acting-tenant-id'] = String(tenant.id);
  const office = auth.getActingOffice();
  if (office) headers['x-acting-office-id'] = String(office.id);
  return headers;
}
function flushTelemetry(beacon = false) {
  if (!telemetryQueue.length) return;
  const views = telemetryQueue.splice(0, telemetryQueue.length);
  if (!auth.getToken()) return; // 未登录或 token 失效：静默丢弃，不弹错
  const base = (apiBaseURL || '').replace(/\/$/, '');
  const body = JSON.stringify({ views });
  try {
    void fetch(base + '/telemetry/page-views', { method: 'POST', headers: telemetryHeaders(), body, keepalive: true })
      .then((res) => {
        // 批量接口还没上线时，回退现有单条接口，保持静默、失败丢弃
        if (res.status === 404 || res.status === 405) {
          for (const view of views) {
            void fetch(base + '/telemetry/page-view', { method: 'POST', headers: telemetryHeaders(), body: JSON.stringify({ path: view.path }), keepalive: true }).catch(() => undefined);
          }
        }
      })
      .catch(() => {
        if (beacon && typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
          try { navigator.sendBeacon(base + '/telemetry/page-views', new Blob([body], { type: 'application/json' })); } catch { /* 静默 */ }
        }
      });
  } catch { /* 静默丢弃 */ }
}
function usePageViewTelemetry(pathname: string) {
  useEffect(() => {
    if (typeof window === 'undefined' || typeof document === 'undefined') return;
    const timer = window.setInterval(() => { if (document.visibilityState === 'visible') flushTelemetry(false); }, TELEMETRY_FLUSH_MS);
    const onVisibility = () => { if (document.visibilityState === 'hidden') flushTelemetry(true); };
    const onPageHide = () => flushTelemetry(true);
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', onPageHide);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', onPageHide);
      flushTelemetry(true);
    };
  }, []);
  useEffect(() => {
    if (typeof window === 'undefined' || typeof document === 'undefined') return;
    if (!telemetryAllowed(pathname) || !auth.getToken()) return;
    telemetryQueue.push({ path: pathname, pageKey: telemetryPageKey(pathname) });
    if (telemetryQueue.length >= TELEMETRY_BATCH) flushTelemetry(false);
  }, [pathname]);
}

/** 未登录访问深层链接：带上原始路径，登录后回跳，而不是一律落到 /today。 */
function LoginRedirect() {
  const loc = useLocation();
  usePageViewTelemetry(loc.pathname);
  const next = loc.pathname + loc.search;
  return <Navigate to={'/login?next=' + encodeURIComponent(next)} replace />;
}

/** 静态介绍页：index.html 在 public/intro 下，用整页跳转而不是 SPA 路由。 */
function StaticPage({ to }: { to: string }) {
  useEffect(() => { window.location.replace(to); }, [to]);
  return null;
}

export default function App() {
  const session = useSession();
  const loc = useLocation();
  // 已登录后的页面访问埋点（此前只在未登录重定向里调用，导致登录用户完全没被记录）
  usePageViewTelemetry(loc.pathname);
  const [verifiedIdentity, setVerifiedIdentity] = useState<SessionIdentity | null>(null);
  const [accessFailed, setAccessFailed] = useState(false);
  const [accessRetry, setAccessRetry] = useState(0);

  // 权限（页面可见性和管理处切换）来自 /auth/me；登录态可能是别的标签页留下的
  useEffect(() => {
    if (!session.token) return;
    const identity = auth.captureIdentity();
    let active = true;
    setAccessFailed(false);
    authApi.me()
      .then((r) => {
        if (!active || !auth.isCurrent(identity)) return;
        auth.setAccess(r.access ?? null, identity);
        setVerifiedIdentity(identity);
      })
      .catch(() => { if (active && auth.isCurrent(identity)) setAccessFailed(true); });
    return () => { active = false; };
  }, [session.token, session.generation, accessRetry]);

  // 业主手机扫码填写页：不需要登录，也不套后台外壳
  if (loc.pathname.startsWith('/m/plate/')) {
    return (
      <Suspense fallback={<div style={{ padding: 40, textAlign: 'center' }}>加载中…</div>}>
        <Routes><Route path="/m/plate/:token" element={<PlateForm />} /></Routes>
      </Suspense>
    );
  }

  if (!session.token) {
    return (
      <>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/intro" element={<StaticPage to="/intro/index.html" />} />
          <Route path="/intro/" element={<StaticPage to="/intro/index.html" />} />
          <Route path="/intro/m" element={<StaticPage to="/intro/m/index.html" />} />
          <Route path="/intro/m/" element={<StaticPage to="/intro/m/index.html" />} />
          <Route path="*" element={<LoginRedirect />} />
        </Routes>
        <Toaster />
      </>
    );
  }

  // 必须先拿到当前登录代次的真实权限，再挂载任何后台框架或业务页。
  if (!verifiedIdentity || !auth.isCurrent(verifiedIdentity) || accessFailed) {
    return <main className="empty" role={accessFailed ? 'alert' : 'status'} style={{ padding: 60 }}>
      {accessFailed ? <><p>无法读取页面权限，请重试或重新登录。</p><button className="btn" onClick={() => setAccessRetry(n => n + 1)}>重试</button><button className="btn" onClick={() => auth.clear()}>退出登录</button></> : <Loading text="正在核对页面权限…" />}
    </main>;
  }
  const landing = firstAllowedPath(session.access);
  if (!landing) return <main className="empty" role="status" style={{ padding: 60 }}><p>当前账号未获授任何后台页面权限，请联系管理员。</p><button className="btn" onClick={() => setAccessRetry(n => n + 1)}>重新核对权限</button><button className="btn" onClick={() => auth.clear()}>退出登录</button></main>;
  // 大屏 /screen 不进 Shell 侧边栏，权限沿用 fees:view，不新增页面 key。
  const screenMode = loc.pathname === '/screen' || loc.pathname.startsWith('/screen/');
  const staticPage = loc.pathname === '/intro' || loc.pathname === '/intro/' || loc.pathname.startsWith('/intro/');
  if (!screenMode && !staticPage && !canViewPath(loc.pathname, session.access)) return <Navigate to={landing} replace />;
  const screenAllowed = screenMode && can('fees', 'view');

  return (
    <>
      <Suspense fallback={<div style={{ padding: 60 }}><Loading /></div>}>
        <Routes>
          <Route path="/login" element={<Navigate to={landing} replace />} />
          <Route path="/screen" element={screenAllowed ? <ScreenPage /> : <Navigate to={landing} replace />} />
          <Route element={<Shell />}>
            <Route path="/screen-settings" element={<ScreenSettings />} />
            <Route path="/" element={<Navigate to={landing} replace />} />
            <Route path="/today" element={<Today />} />
            <Route path="/work-orders" element={<WorkOrders />} />
            <Route path="/cashier" element={<Cashier />} />
            <Route path="/records" element={<Records />} />
            <Route path="/pending" element={<Pending />} />
            <Route path="/standards" element={<Standards />} />
            <Route path="/houses" element={<Houses />} />
            <Route path="/owners" element={<Owners />} />
            <Route path="/experience" element={<Experience />} />
            <Route path="/apartment" element={<MigratedApartment />} />
            <Route path="/apartment-cashier" element={<Navigate to="/apartment" replace />} />
            <Route path="/meters" element={<MigratedMeters />} />
            <Route path="/fees" element={<Fees />} />
            <Route path="/parking/main" element={<ParkingSpaces garage="main" />} />
            <Route path="/parking/civil" element={<ParkingSpaces garage="civil" />} />
            <Route path="/reports" element={<Reports />} />
            <Route path="/materials" element={<Materials />} />
            <Route path="/stocktakes" element={<Stocktakes />} />
            <Route path="/staff" element={<Staff />} />
            <Route path="/offices" element={<Offices />} />
            <Route path="/qr" element={<QrCodes />} />
            <Route path="/intranet" element={<Intranet />} />
            <Route path="/logs" element={<Logs />} />
            <Route path="/bills" element={<Bills />} />
            <Route path="/maint" element={<Maintenance />} />
            <Route path="/vehicles" element={<Vehicles />} />
            <Route path="/access-cards" element={<AccessCards />} />
            <Route path="/devices" element={<Devices />} />
            <Route path="/purchase" element={<Purchase />} />
            <Route path="/stock" element={<Stock />} />
            <Route path="/settings" element={<Settings />} />
            <Route path="/plates" element={<Plates />} />
            <Route path="/family-cars" element={<FamilyCars />} />
            <Route path="/intro" element={<StaticPage to="/intro/index.html" />} />
          <Route path="/intro/" element={<StaticPage to="/intro/index.html" />} />
          <Route path="/intro/m" element={<StaticPage to="/intro/m/index.html" />} />
          <Route path="/intro/m/" element={<StaticPage to="/intro/m/index.html" />} />
          <Route path="*" element={<Navigate to={landing} replace />} />
          </Route>
        </Routes>
      </Suspense>
      <Toaster />
    </>
  );
}
import AccessCards from './pages/AccessCards';
