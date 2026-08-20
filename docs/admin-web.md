# 管理后台说明（admin-web）

> 工程：[apps/admin-web/](../apps/admin-web/)
> 技术栈：Vite 5 + React 18 + TypeScript + Ant Design 5 + React Router 6
> 共享：[@pms/shared-types](../packages/shared-types/)、[@pms/api-client](../packages/api-client/)（与小程序共用同一套 DTO 和请求封装）

---

## 目录结构

```
apps/admin-web/
  index.html
  vite.config.ts
  tsconfig.json
  src/
    main.tsx          # AntD ConfigProvider + zh_CN + Router
    App.tsx           # 路由 + RequireAuth
    vite-env.d.ts     # ImportMeta 类型扩展
    lib/
      api.ts          # 启动时 configure(api-client)，读取 VITE_API_BASE_URL
      auth.ts         # token / user 本地存储 + useAuth() Hook
    components/
      AppLayout.tsx   # 侧边栏 + 头部 + Outlet
    pages/
      LoginPage.tsx
      DashboardPage.tsx
      PropertiesPage.tsx
      OwnerAuditPage.tsx
      WorkOrdersPage.tsx
      InventoryPage.tsx
      QrPage.tsx
  .env.example        # 复制为 .env.local
```

## 已实现的 6 个视图（与原静态版本对齐）

| 路由 | 页面 | 接入的接口 |
|---|---|---|
| `/dashboard` | 总览 | `GET /dashboard/metrics`，`GET /work-orders` |
| `/properties` | 房产资料 | `POST /communities`、`POST /buildings`、`POST /houses`、`GET /communities` |
| `/owners` | 业主审核 | `GET /audits`、`POST /audits/:id/approve`、`POST /audits/:id/reject` |
| `/work-orders` | 报修工单 | `POST /repair-requests/office`、`GET /work-orders` |
| `/inventory` | 库存采购 | `POST /materials`、`POST /warehouses`、`POST /suppliers`、`GET /purchase-requests` |
| `/qr` | 二维码 | `POST /qr-codes` |

---

## 线上开发与发布

```powershell
# 1. 安装依赖并构建
pnpm install
pnpm web:build

# 2. 打包并上传到线上服务器
.\deploy\pack.ps1 -Only web
scp -i $HOME\.ssh\pms_repair_key.pem .\deploy\pms-web-*.tar.gz ubuntu@1.15.172.131:/tmp/
scp -i $HOME\.ssh\pms_repair_key.pem .\deploy\srv-deploy-web.sh ubuntu@1.15.172.131:/tmp/
ssh -i $HOME\.ssh\pms_repair_key.pem ubuntu@1.15.172.131 "bash /tmp/srv-deploy-web.sh"
```

本地不作为开发入口。修改页面后以线上地址 `https://prsznh.cn/` 验证：

```powershell
curl https://prsznh.cn/
curl https://prsznh.cn/dashboard
```

## 部署

`pnpm web:build` 生成纯静态 `dist/`，丢到任何静态托管：

- Nginx：`location / { try_files $uri /index.html; }` 处理 SPA 路由回退
- 腾讯云 COS 静态网站托管 + 自定义域名
- 直接放在 API 服务器同域名子路径（避免 CORS）

建议生产环境把 API 反代到同域 `/api/v1`，前端 `VITE_API_BASE_URL=/api/v1`，省掉 CORS 配置。

---

## 共享代码协同

- **登录 token** 走 [src/lib/auth.ts](../apps/admin-web/src/lib/auth.ts)：`localStorage` + `useSyncExternalStore`，跨标签页一致。
- **请求** 通过 [@pms/api-client](../packages/api-client/) 的 `request()` 调用。该包**运行时自动检测** `wx.request`，存在则走小程序通道，否则走 `fetch` —— 所以 admin-web、miniapp-owner、miniapp-staff 三端零差异使用。
- **新增端点** 优先在 [packages/api-client/src/endpoints/](../packages/api-client/src/endpoints/) 加函数；admin 独有的复杂操作（如审批、改派）可以在页面里直接 `request({ method, url, data })` 用泛型调用。

---

## UI 布局约束

为避免后台页面反复出现列宽、标题宽度不协调的问题，后续修改 admin-web 必须遵守：

- 表格默认使用 `tableLayout="fixed"`。
- 每一列必须给明确 `width`；摘要/说明列也要固定宽度，不能默认吃掉全部剩余空间。
- 长文本必须用 `whiteSpace: 'nowrap'`、`overflow: 'hidden'`、`textOverflow: 'ellipsis'`，并用 `title` 保留完整内容。
- 同一组详情字段的标题列必须统一宽度，不能逐行自适应导致有的宽有的窄。
- 详情分组如“维修记录”优先使用项目内的紧凑行布局，而不是让 Ant Design `Descriptions` 自动分配标签列宽。
- 修改 `/work-orders` 这类复杂页面后，必须在线上打开页面截图检查：表格列宽、详情标题列、按钮文字、长文本省略都要看一遍。

---

## 待办（W2-W3 业务开发阶段）

- [x] 总览页接入真实指标接口（待审业主、采购待审）
- [ ] 业主审核 / 工单池接搜索 + 分页 + 状态筛选
- [ ] 工单详情抽屉（时间线、图片预览、改派、转单、备注）
- [ ] 采购审批流：物业经理 / 采购经理 两级审批操作（含金额阈值提示）
- [ ] 字典维护（工种、报修类型、常用标签、材料分类）
- [ ] 派单规则配置面板
- [ ] 数据看板（实时大屏 / 状态分布 / SLA / 维修工 KPI / 材料消耗成本）
- [ ] 用户与角色管理（员工账号开通、角色分配、停用）
- [ ] 文件直传 COS（接 `POST /upload/presign`）
- [ ] 包体优化：路由级 `React.lazy` + `manualChunks` 拆 AntD/icons（当前 gzip 354KB）
