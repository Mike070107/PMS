import { Layout, Menu, Dropdown, Avatar, Button, Drawer, Select } from 'antd';
import {
  AccountBookOutlined,
  AppstoreOutlined,
  DashboardOutlined,
  HomeOutlined,
  AuditOutlined,
  BarChartOutlined,
  ToolOutlined,
  FileTextOutlined,
  ShoppingOutlined,
  QrcodeOutlined,
  SettingOutlined,
  LogoutOutlined,
  CreditCardOutlined,
  TeamOutlined,
  UserOutlined,
  SafetyCertificateOutlined,
  ApartmentOutlined,
  CloudServerOutlined,
  MonitorOutlined,
  MenuOutlined,
} from '@ant-design/icons';
import { useEffect, useState } from 'react';
import { Link, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { auth as authApi } from '@pms/api-client';
import type { AdminAccess } from '@pms/shared-types';
import { request } from '../lib/api';
import { auth, pagePerm, useAuth } from '../lib/auth';
import BrandLogo from './BrandLogo';
import NotificationBell from './NotificationBell';
import FeedbackButton from './FeedbackButton';

const { Header, Sider, Content } = Layout;

function hasAuthToken() {
  return !!auth.getToken();
}

interface NavItem {
  key: string;
  /** 权限矩阵里的页面 key；null = 不受矩阵控制（平台菜单单独判断） */
  pageKey: string | null;
  icon: React.ReactNode;
  label: string;
}

/**
 * 菜单唯一配置源：可见性、页头标题都从这里取。
 * 新增页面：加一行 + App.tsx 加路由 + 后端 pages.ts 注册 pageKey，别再另开一份映射表。
 */
const NAV_GROUPS: Array<{ title: string; platformOnly?: boolean; items: NavItem[] }> = [
  {
    title: '总览',
    items: [
      { key: '/dashboard', pageKey: 'dashboard', icon: <DashboardOutlined />, label: '工作台' },
      { key: '/reports', pageKey: 'reports', icon: <BarChartOutlined />, label: '报表查询' },
    ],
  },
  {
    title: '报修工单',
    items: [
      { key: '/work-orders', pageKey: 'work-orders', icon: <ToolOutlined />, label: '工单管理' },
      {
        key: '/maintenance-orders',
        pageKey: 'maintenance-orders',
        icon: <FileTextOutlined />,
        label: '养护单',
      },
    ],
  },
  {
    title: '收费业务',
    items: [
      { key: '/business', pageKey: 'business', icon: <CreditCardOutlined />, label: '前台收费' },
      { key: '/fees', pageKey: 'fees', icon: <AccountBookOutlined />, label: '物业费' },
    ],
  },
  {
    title: '材料与库存',
    items: [
      { key: '/materials', pageKey: 'materials', icon: <AppstoreOutlined />, label: '材料 SKU 库' },
      { key: '/inventory', pageKey: 'inventory', icon: <ShoppingOutlined />, label: '库存与采购' },
      { key: '/stocktakes', pageKey: 'stocktakes', icon: <AuditOutlined />, label: '库存盘点' },
    ],
  },
  {
    title: '基础档案',
    items: [
      { key: '/properties', pageKey: 'properties', icon: <HomeOutlined />, label: '房产管理' },
      { key: '/owners', pageKey: 'owners', icon: <AuditOutlined />, label: '业主用户' },
      { key: '/staff', pageKey: 'users', icon: <TeamOutlined />, label: '用户管理' },
      { key: '/roles', pageKey: 'roles', icon: <SafetyCertificateOutlined />, label: '业务角色' },
      { key: '/offices', pageKey: 'offices', icon: <ApartmentOutlined />, label: '管理处' },
      { key: '/qr', pageKey: 'qr', icon: <QrcodeOutlined />, label: '楼栋报修码' },
    ],
  },
  {
    title: '系统',
    items: [
      { key: '/settings', pageKey: 'settings', icon: <SettingOutlined />, label: '系统设置' },
      { key: '/logs', pageKey: 'logs', icon: <MonitorOutlined />, label: '日志管理' },
    ],
  },
  {
    title: '平台管理',
    platformOnly: true,
    items: [
      { key: '/platform/tenants', pageKey: null, icon: <CloudServerOutlined />, label: '物业公司' },
    ],
  },
];

const PAGE_DESCRIPTIONS: Record<string, string> = {
  '/dashboard': '掌握今日待办与物业运营动态',
  '/reports': '工单、人员、库存与材料使用的统计与导出',
  '/work-orders': '登记、调度并跟踪每一张维修工单',
  '/maintenance-orders': '按工单开《房屋修理养护任务单》，签字后打印',
  '/business': '办理停车、门禁与前台收费业务',
  '/fees': '物业费账单、收款登记与欠费催缴',
  '/materials': '维护标准材料、单位与基础价格',
  '/inventory': '管理库存、盘点、采购、收货与仓库调拨',
  '/stocktakes': '发起盘点、办公室复核并查看盘点报告',
  '/properties': '维护小区、楼栋与房屋',
  '/owners': '业主端小程序用户：档案、入驻审核与启停',
  '/staff': '管理员工身份、工种与后台角色',
  '/roles': '配置功能权限与可管理的数据范围',
  '/offices': '划分管理处及其负责的小区范围',
  '/qr': '生成、下载并管理楼栋报修二维码',
  '/settings': '配置通知、识别与工单处理规则',
  '/logs': '查看登录与重要操作，分析使用情况、负载和异常告警',
  '/platform/tenants': '管理平台上的物业公司与功能授权',
};

function visibleGroups(access: AdminAccess | null, isPlatform: boolean, hasTenantScope: boolean) {
  return NAV_GROUPS.map((group) => ({
    ...group,
    items: group.platformOnly
      ? isPlatform
        ? group.items
        : []
      : hasTenantScope
        ? group.items.filter(
            (item) => !item.pageKey || pagePerm(access, item.pageKey).canView,
          )
        : [],
  })).filter((group) => group.items.length > 0);
}

export default function AppLayout() {
  const loc = useLocation();
  const nav = useNavigate();
  const { user, access, actingTenant, actingOffice } = useAuth();
  const [isMobile, setIsMobile] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  useEffect(() => {
    const media = window.matchMedia('(max-width: 900px)');
    const sync = () => setIsMobile(media.matches);
    sync();
    media.addEventListener('change', sync);
    return () => media.removeEventListener('change', sync);
  }, []);

  // 每次进后台刷新一次权限：管理员改了角色配置，用户下次刷新页面即生效
  useEffect(() => {
    (async () => {
      try {
        const meResp = (await authApi.me()) as { access?: AdminAccess };
        if (meResp?.access) {
          auth.setAccess(meResp.access);
          // 本地残留的管理处选择已不在自己可切范围（角色被改、管理处被删）时清掉，
          // 免得顶栏一直显示一个后端已经忽略了的视角
          const office = auth.getActingOffice();
          if (office && !(meResp.access.offices ?? []).some((o) => o.id === office.id)) {
            auth.setActingOffice(null);
          }
        }
      } catch {
        /* 网络异常时沿用本地缓存，后端仍会兜底拦截 */
      }
    })();
  }, [actingTenant?.id, actingOffice?.id]);

  // 页面访问只记业务路由，不含筛选条件；统计失败不影响页面正常使用。
  useEffect(() => {
    if (!hasAuthToken()) return;
    void request({
      method: 'POST',
      url: '/observability/page-view',
      data: { path: loc.pathname, title: document.title },
    }).catch(() => undefined);
  }, [loc.pathname]);

  const isPlatform = user?.role === 'superadmin' || !!access?.isPlatformAdmin;
  const hasTenantScope = !isPlatform || !!actingTenant;
  // 管理处切换器：本人范围覆盖 ≥2 个管理处，或全公司范围（想聚焦单个管理处）时显示
  const offices = access?.offices ?? [];
  const showOfficeSwitcher =
    hasTenantScope && (offices.length >= 2 || (offices.length >= 1 && !!access?.scopeAll));
  const groups = visibleGroups(access, isPlatform, hasTenantScope);
  const allItems = groups.flatMap((g) => g.items);
  const selected =
    allItems.map((i) => i.key).find((key) => loc.pathname.startsWith(key)) || '/dashboard';
  const pageTitle =
    allItems.find((i) => i.key === selected)?.label ?? '工作台';
  const pageDescription = PAGE_DESCRIPTIONS[selected] ?? '邻修物业管理平台';

  const menuItems = groups.flatMap((group) => [
    {
      key: `group-${group.title}`,
      label: <div className="pms-sider-group">{group.title}</div>,
      type: 'group' as const,
      children: group.items.map((item) => ({
        key: item.key,
        icon: item.icon,
        label: <Link to={item.key}>{item.label}</Link>,
      })),
    },
  ]);

  const exitActing = async () => {
    const acting = auth.getActingTenant();
    auth.setActingTenant(null);
    if (acting) {
      try {
        await request({ method: 'POST', url: `/platform/tenants/${acting.id}/exit` });
      } catch {
        /* 审计失败不阻断退出 */
      }
    }
    nav('/platform/tenants', { replace: true });
  };

  const sidebarContent = (
    <div className="pms-sider-inner">
      <div className="pms-sider-brand">
        <BrandLogo dark />
      </div>
      <div className="pms-sider-nav-label">业务导航</div>
      <Menu
        mode="inline"
        theme="dark"
        selectedKeys={[selected]}
        items={menuItems}
        onClick={() => setMobileNavOpen(false)}
        style={{ borderInlineEnd: 0 }}
      />
      <div className="pms-sider-foot">
        <div className="pms-sider-foot-label">当前身份</div>
        <div className="pms-sider-foot-value">
          {/* 顶栏显示他绑的角色名（后端 /auth/me 下发）；没有就退回一句中性称呼 */}
          {user?.roleNames?.join(' · ') || '物业管理人员'}
        </div>
        <div className="pms-sider-foot-meta">邻修物业管理平台 · {new Date().getFullYear()}</div>
      </div>
    </div>
  );

  return (
    <Layout className="pms-app-shell">
      {!isMobile && (
        <Sider className="pms-sider pms-desktop-sider" width={236} theme="dark">
          {sidebarContent}
        </Sider>
      )}
      <Drawer
        className="pms-mobile-drawer"
        placement="left"
        width={280}
        open={isMobile && mobileNavOpen}
        onClose={() => setMobileNavOpen(false)}
        styles={{ body: { padding: 0 } }}
      >
        {sidebarContent}
      </Drawer>
      <Layout className="pms-main-layout">
        {actingTenant && (
          <div className="pms-acting-banner">
            <span>
              正在以「{actingTenant.name}」的公司视角操作，所有改动都会落到该公司，并已记录审计日志
            </span>
            <Button size="small" onClick={exitActing}>
              退出公司视角
            </Button>
          </div>
        )}
        <Header className="pms-header">
          <div className="pms-header-leading">
            {isMobile && (
              <Button
                className="pms-mobile-trigger"
                type="text"
                icon={<MenuOutlined />}
                aria-label="打开导航"
                onClick={() => setMobileNavOpen(true)}
              />
            )}
            <div className="pms-header-copy">
              <span className="pms-header-title">{pageTitle}</span>
              <span className="pms-header-description">{pageDescription}</span>
            </div>
          </div>
          <div className="pms-header-actions">
            {hasTenantScope && <FeedbackButton pageTitle={pageTitle} compact={isMobile} />}
            {showOfficeSwitcher && (
              <Select
                className="pms-office-switcher"
                style={{ minWidth: 168 }}
                value={actingOffice?.id ?? 0}
                options={[
                  { value: 0, label: '全部管理处' },
                  ...offices.map((o) => ({ value: o.id, label: o.name })),
                ]}
                onChange={(id: number) => {
                  const target = offices.find((o) => o.id === id);
                  auth.setActingOffice(target ? { id: target.id, name: target.name } : null);
                }}
                aria-label="切换管理处视角"
              />
            )}
            {hasTenantScope && <NotificationBell />}
            <Dropdown
              menu={{
                items: [
                  {
                    key: 'logout',
                    icon: <LogoutOutlined />,
                    label: '退出登录',
                    onClick: () => {
                      auth.clear();
                      nav('/login', { replace: true });
                    },
                  },
                ],
              }}
            >
              <div className="pms-user-chip">
                <Avatar size={32} icon={<UserOutlined />} className="pms-user-avatar" />
                <div className="pms-user-copy">
                  <span className="pms-user-name">
                    {user?.name || user?.loginAccount || '管理员'}
                  </span>
                  {!!user?.roleNames?.length && (
                    <span className="pms-user-role">{user.roleNames.join(' · ')}</span>
                  )}
                </div>
              </div>
            </Dropdown>
          </div>
        </Header>
        <Content className="pms-main-content">
          {/* key 里带上管理处视角：切换后当前页面整体重挂载重新取数 */}
          <div className="pms-content pms-fadein" key={`${selected}:${actingOffice?.id ?? 0}`}>
            <Outlet />
          </div>
        </Content>
      </Layout>
    </Layout>
  );
}
