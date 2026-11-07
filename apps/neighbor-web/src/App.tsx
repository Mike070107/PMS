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
import { canViewPath, firstAllowedPath } from '@/lib/page-access';
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

/** 未登录访问深层链接：带上原始路径，登录后回跳，而不是一律落到 /today。 */
function LoginRedirect() {
  const loc = useLocation();
  const next = loc.pathname + loc.search;
  return <Navigate to={'/login?next=' + encodeURIComponent(next)} replace />;
}

export default function App() {
  const session = useSession();
  const loc = useLocation();
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
  if (!canViewPath(loc.pathname, session.access)) return <Navigate to={landing} replace />;

  return (
    <>
      <Suspense fallback={<div style={{ padding: 60 }}><Loading /></div>}>
        <Routes>
          <Route path="/login" element={<Navigate to={landing} replace />} />
          <Route element={<Shell />}>
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
            <Route path="*" element={<Navigate to={landing} replace />} />
          </Route>
        </Routes>
      </Suspense>
      <Toaster />
    </>
  );
}
import AccessCards from './pages/AccessCards';
