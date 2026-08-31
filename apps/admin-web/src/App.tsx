import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import AppLayout from './components/AppLayout';
import LoginPage from './pages/LoginPage';
import DashboardPage from './pages/DashboardPage';
import ReportsPage from './pages/ReportsPage';
import BusinessPage from './pages/BusinessPage';
import FeesPage from './pages/FeesPage';
import PropertiesPage from './pages/PropertiesPage';
import OwnerAuditPage from './pages/OwnerAuditPage';
import WorkOrdersPage from './pages/WorkOrdersPage';
import MaintenanceOrdersPage from './pages/MaintenanceOrdersPage';
import StaffPage from './pages/StaffPage';
import InventoryPage from './pages/InventoryPage';
import MaterialsPage from './pages/MaterialsPage';
import QrPage from './pages/QrPage';
import SettingsPage from './pages/SettingsPage';
import RolesPage from './pages/RolesPage';
import OfficesPage from './pages/OfficesPage';
import PlatformTenantsPage from './pages/PlatformTenantsPage';
import { pagePerm, useAuth } from './lib/auth';

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
    <Routes>
      <Route path="/login" element={<LoginPage />} />
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
        <Route path="materials" element={<RequireTenantScope><RequirePage pageKey="materials"><MaterialsPage /></RequirePage></RequireTenantScope>} />
        <Route path="qr" element={<RequireTenantScope><RequirePage pageKey="qr"><QrPage /></RequirePage></RequireTenantScope>} />
        <Route path="settings" element={<RequireTenantScope><RequirePage pageKey="settings"><SettingsPage /></RequirePage></RequireTenantScope>} />
        <Route path="*" element={<HomeRedirect />} />
      </Route>
    </Routes>
  );
}
