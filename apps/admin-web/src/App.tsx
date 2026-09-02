import { lazy, Suspense } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import AppLayout from './components/AppLayout';
import { pagePerm, useAuth } from './lib/auth';

// 每个业务页按路由加载。库存页会带 xlsx、工单页组件也很大，一次全塞进首页会让登录页
// 先下载近 2 MB 脚本；按页拆开后用户只为实际打开的功能付下载和解析成本。
const LoginPage = lazy(() => import('./pages/LoginPage'));
const DashboardPage = lazy(() => import('./pages/DashboardPage'));
const ReportsPage = lazy(() => import('./pages/ReportsPage'));
const BusinessPage = lazy(() => import('./pages/BusinessPage'));
const FeesPage = lazy(() => import('./pages/FeesPage'));
const PropertiesPage = lazy(() => import('./pages/PropertiesPage'));
const OwnerAuditPage = lazy(() => import('./pages/OwnerAuditPage'));
const WorkOrdersPage = lazy(() => import('./pages/WorkOrdersPage'));
const MaintenanceOrdersPage = lazy(() => import('./pages/MaintenanceOrdersPage'));
const SignPage = lazy(() => import('./pages/SignPage'));
const StaffPage = lazy(() => import('./pages/StaffPage'));
const InventoryPage = lazy(() => import('./pages/InventoryPage'));
const StocktakePage = lazy(() => import('./pages/StocktakePage'));
const MaterialsPage = lazy(() => import('./pages/MaterialsPage'));
const QrPage = lazy(() => import('./pages/QrPage'));
const SettingsPage = lazy(() => import('./pages/SettingsPage'));
const LogsPage = lazy(() => import('./pages/LogsPage'));
const RolesPage = lazy(() => import('./pages/RolesPage'));
const OfficesPage = lazy(() => import('./pages/OfficesPage'));
const PlatformTenantsPage = lazy(() => import('./pages/PlatformTenantsPage'));

function RequireAuth({ children }: { children: React.ReactNode }) {
  const { token } = useAuth();
  const loc = useLocation();
  if (!token) {
    const next = encodeURIComponent(loc.pathname + loc.search);
    return <Navigate to={`/login?next=${next}`} replace />;
  }
  return <>{children}</>;
}

/** pageKey → 路由路径（和 AppLayout 的 NAV_GROUPS 保持一致） */
const PAGE_ROUTES: Array<[string, string]> = [
  ['dashboard', '/dashboard'],
  ['reports', '/reports'],
  ['work-orders', '/work-orders'],
  ['maintenance-orders', '/maintenance-orders'],
  ['business', '/business'],
  ['fees', '/fees'],
  ['materials', '/materials'],
  ['inventory', '/inventory'],
  ['properties', '/properties'],
  ['owners', '/owners'],
  ['users', '/staff'],
  ['roles', '/roles'],
  ['offices', '/offices'],
  ['qr', '/qr'],
  ['settings', '/settings'],
  ['logs', '/logs'],
];

function firstVisiblePath(access: ReturnType<typeof useAuth>['access']): string | null {
  const hit = PAGE_ROUTES.find(([key]) => pagePerm(access, key).canView);
  return hit ? hit[1] : null;
}

function isPlatformAccount(
  user: ReturnType<typeof useAuth>['user'],
  access: ReturnType<typeof useAuth>['access'],
): boolean {
  // 登录响应里立刻就有 role；access 还在异步刷新时也必须先拦住，
  // 否则平台超管会短暂挂载业务页并发出一批没有租户范围的请求。
  return user?.role === 'superadmin' || !!access?.isPlatformAdmin;
}

/** 平台超管必须先选一家物业公司，业务接口才有明确的租户边界。 */
function RequireTenantScope({ children }: { children: React.ReactNode }) {
  const { user, access, actingTenant } = useAuth();
  if (isPlatformAccount(user, access) && !actingTenant) {
    return <Navigate to="/platform/tenants" replace />;
  }
  return <>{children}</>;
}

function HomeRedirect() {
  const { user, access, actingTenant } = useAuth();
  if (isPlatformAccount(user, access) && !actingTenant) {
    return <Navigate to="/platform/tenants" replace />;
  }
  return <Navigate to={firstVisiblePath(access) || '/dashboard'} replace />;
}

/** 路由级权限：直接敲 URL 也进不了无查看权的页面（菜单过滤之外的兜底） */
function RequirePage({ pageKey, children }: { pageKey: string; children: React.ReactNode }) {
  const { access } = useAuth();
  if (!pagePerm(access, pageKey).canView) {
    const fallback = firstVisiblePath(access);
    if (fallback) return <Navigate to={fallback} replace />;
    return (
      <div style={{ padding: 48, textAlign: 'center', color: '#5b7370' }}>
        当前账号没有任何网站页面的查看权限，请联系管理员在「业务角色」页里，给你的角色勾上要用的页面。
      </div>
    );
  }
  return <>{children}</>;
}

/** 平台菜单只属于 superadmin */
function RequirePlatform({ children }: { children: React.ReactNode }) {
  const { user, access } = useAuth();
  if (!isPlatformAccount(user, access)) {
    return <Navigate to="/dashboard" replace />;
  }
  return <>{children}</>;
}

export default function App() {
  return (
    <Suspense fallback={<div style={{ padding: 48, textAlign: 'center', color: '#5b7370' }}>页面加载中…</div>}>
      <Routes>
      <Route path="/login" element={<LoginPage />} />
      {/* 手机扫码签名页：不需要登录，凭据是链接里那串 5 分钟有效的 token */}
      <Route path="/sign/:token" element={<SignPage />} />
      <Route
        path="/"
        element={
          <RequireAuth>
            <AppLayout />
          </RequireAuth>
        }
      >
        <Route index element={<HomeRedirect />} />
        <Route path="dashboard" element={<RequireTenantScope><RequirePage pageKey="dashboard"><DashboardPage /></RequirePage></RequireTenantScope>} />
        <Route path="reports" element={<RequireTenantScope><RequirePage pageKey="reports"><ReportsPage /></RequirePage></RequireTenantScope>} />
        <Route path="business" element={<RequireTenantScope><RequirePage pageKey="business"><BusinessPage /></RequirePage></RequireTenantScope>} />
        <Route path="fees" element={<RequireTenantScope><RequirePage pageKey="fees"><FeesPage /></RequirePage></RequireTenantScope>} />
        <Route path="properties" element={<RequireTenantScope><RequirePage pageKey="properties"><PropertiesPage /></RequirePage></RequireTenantScope>} />
        <Route path="owners" element={<RequireTenantScope><RequirePage pageKey="owners"><OwnerAuditPage /></RequirePage></RequireTenantScope>} />
        <Route path="work-orders" element={<RequireTenantScope><RequirePage pageKey="work-orders"><WorkOrdersPage /></RequirePage></RequireTenantScope>} />
        <Route path="maintenance-orders" element={<RequireTenantScope><RequirePage pageKey="maintenance-orders"><MaintenanceOrdersPage /></RequirePage></RequireTenantScope>} />
        <Route path="staff" element={<RequireTenantScope><RequirePage pageKey="users"><StaffPage /></RequirePage></RequireTenantScope>} />
        <Route path="roles" element={<RequireTenantScope><RequirePage pageKey="roles"><RolesPage /></RequirePage></RequireTenantScope>} />
        <Route path="offices" element={<RequireTenantScope><RequirePage pageKey="offices"><OfficesPage /></RequirePage></RequireTenantScope>} />
        <Route path="platform/tenants" element={<RequirePlatform><PlatformTenantsPage /></RequirePlatform>} />
        <Route path="inventory" element={<RequireTenantScope><RequirePage pageKey="inventory"><InventoryPage /></RequirePage></RequireTenantScope>} />
        <Route path="stocktakes" element={<RequireTenantScope><RequirePage pageKey="inventory"><StocktakePage /></RequirePage></RequireTenantScope>} />
        <Route path="materials" element={<RequireTenantScope><RequirePage pageKey="materials"><MaterialsPage /></RequirePage></RequireTenantScope>} />
        <Route path="qr" element={<RequireTenantScope><RequirePage pageKey="qr"><QrPage /></RequirePage></RequireTenantScope>} />
        <Route path="settings" element={<RequireTenantScope><RequirePage pageKey="settings"><SettingsPage /></RequirePage></RequireTenantScope>} />
        <Route path="logs" element={<RequireTenantScope><RequirePage pageKey="logs"><LogsPage /></RequirePage></RequireTenantScope>} />
        <Route path="*" element={<HomeRedirect />} />
      </Route>
      </Routes>
    </Suspense>
  );
}
