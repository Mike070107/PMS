import { Suspense, lazy, useEffect } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { auth as authApi } from '@pms/api-client';
import { auth, useSession } from '@/lib/auth';
import Shell from '@/components/Shell';
import Login from '@/pages/Login';
import { Loading, Toaster } from '@/components/ui';

const Today = lazy(() => import('@/pages/Today'));
const WorkOrders = lazy(() => import('@/pages/WorkOrders'));
const Cashier = lazy(() => import('@/pages/Cashier'));
const Bills = lazy(() => import('@/pages/Bills'));
const Maintenance = lazy(() => import('@/pages/Maintenance'));
const Vehicles = lazy(() => import('@/pages/Vehicles'));
const Devices = lazy(() => import('@/pages/Devices'));
const Purchase = lazy(() => import('@/pages/Purchase'));
const Stock = lazy(() => import('@/pages/Stock'));
const Settings = lazy(() => import('@/pages/Settings'));

export default function App() {
  const session = useSession();

  // 权限（页面可见性和管理处切换）来自 /auth/me；登录态可能是别的标签页留下的
  useEffect(() => {
    if (!session.token) return;
    authApi.me()
      .then((r) => auth.setAccess(r.access ?? null))
      .catch(() => undefined);
  }, [session.token]);

  if (!session.token) {
    return (
      <>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="*" element={<Navigate to="/login" replace />} />
        </Routes>
        <Toaster />
      </>
    );
  }

  return (
    <>
      <Suspense fallback={<div style={{ padding: 60 }}><Loading /></div>}>
        <Routes>
          <Route path="/login" element={<Navigate to="/today" replace />} />
          <Route element={<Shell />}>
            <Route path="/" element={<Navigate to="/today" replace />} />
            <Route path="/today" element={<Today />} />
            <Route path="/work-orders" element={<WorkOrders />} />
            <Route path="/cashier" element={<Cashier />} />
            <Route path="/bills" element={<Bills />} />
            <Route path="/maint" element={<Maintenance />} />
            <Route path="/vehicles" element={<Vehicles />} />
            <Route path="/devices" element={<Devices />} />
            <Route path="/purchase" element={<Purchase />} />
            <Route path="/stock" element={<Stock />} />
            <Route path="/settings" element={<Settings />} />
            <Route path="*" element={<Navigate to="/today" replace />} />
          </Route>
        </Routes>
      </Suspense>
      <Toaster />
    </>
  );
}
