# PMS Repair · 物业报修管理系统（一期）

SaaS 多物业公司的物业管理系统，一期聚焦报修闭环：业主报修 → 工单流转 → 维修执行 → 材料消耗 → 采购补货 → 数据统计。

完整需求见 [`docs/PRD.md`](docs/PRD.md)。

## 唯一开发入口

- 唯一长期工作目录：`D:\00项目开发\PMS`
- 唯一集成主线：`main`
- `origin/main` 是代码事实来源；线上版本另由 `deployed/api`、`deployed/web`、
  `deployed/miniapp-owner`、`deployed/miniapp-staff` 标签记录。
- 名称带 `PMS-*` 的其它目录都是历史或临时 worktree，不作为后续修改入口。

每次开始修改前先执行：

```powershell
Set-Location 'D:\00项目开发\PMS'
git switch main
git pull --ff-only
git status --short
```

完整的分支、并行开发、合并与部署约定见
[`docs/development-workflow.md`](docs/development-workflow.md)。

## 技术栈

| 端 | 技术 |
|---|---|
| 后端 API | NestJS 10 + TypeORM + PostgreSQL 16 + Redis + MinIO/对象存储 |
| 管理后台 | React + Vite（`apps/admin-web`，已上线） |
| 业主小程序 | 微信小程序「邻修」（`apps/miniapp-owner`，AppID `wx002fde4bfaa4c7d9`） |
| 员工小程序 | 微信小程序「邻修管理」（`apps/miniapp-staff`，AppID `wx8ef4de0e498064c4`） |

## 目录结构

```
pms-repair/
├── apps/
│   ├── api/            # NestJS 后端
│   ├── admin-web/      # React + Vite 管理后台（已上线）
│   ├── miniapp-owner/  # 业主小程序「邻修」
│   └── miniapp-staff/  # 员工小程序「邻修管理」
├── packages/shared-types/   # 跨端共享类型
├── packages/api-client/     # 跨端 HTTP 客户端（小程序/后台共用）
├── docker/docker-compose.dev.yml
└── docs/PRD.md
```

## 开发与验证入口

本项目当前按线上真实环境开发和验收，不再以本地服务作为开发入口：

- 管理后台：`https://prsznh.cn/`
- API：`https://prsznh.cn/api/v1`
- 健康检查：`https://prsznh.cn/api/v1/health`

所有改动完成后直接打包并同步到线上服务器验证。

小程序改完要在手机上看效果，一条命令即可（细节见 [`docs/miniapp.md`](docs/miniapp.md)）：

```powershell
pnpm mp          # 业主端：编译共享包 + 构建 npm + 自动预览推到手机
pnpm mp:staff    # 员工端
```

## 本地启动（仅排障）

默认不使用本地启动。只有在排查编译、依赖或离线问题时，才临时启动本地依赖和服务。

> 前置：Node 20+、pnpm 10+、Docker。仓库已配淘宝镜像（`.npmrc`）。

```bash
# 1. 起依赖（Postgres 5433 / Redis 6380 / MinIO 9100-9101，端口已避开 Osirislist）
pnpm docker:up

# 2. 装依赖
pnpm install

# 3. 配置后端环境变量
cp apps/api/.env.example apps/api/.env
# dev 默认 DB_SYNCHRONIZE=true，首次启动自动建表

# 4. 启动 API（默认 :4000）
pnpm api:dev

# 5. 健康检查
curl http://localhost:4000/api/v1/health
# 期望 { "status":"ok", "db":"up", ... }
```

## 线上服务器环境

当前开发以线上服务器为准：

- 管理后台入口：`https://prsznh.cn/`
- API 公网入口：`https://prsznh.cn/api/v1`
- 健康检查：`https://prsznh.cn/api/v1/health`
- 服务器：`1.15.172.131`
- IP 直连入口（排障备用）：`http://1.15.172.131/`
- 服务器内 API 监听：`127.0.0.1:4000`，由 nginx 反向代理到公网 80 端口
- 服务器内依赖容器：Postgres `127.0.0.1:5433`、Redis `127.0.0.1:6380`

不要再使用其他项目环境地址；本项目统一以 `https://prsznh.cn/` 为线上访问入口，`1.15.172.131` 只作为服务器地址和排障备用入口。

## 关键约定

- **多租户**：业务表均带 `tenant_id` 行级隔离，平台 `superadmin` 的 tenantId 为 null。
- **时间列**：一律 `timestamptz`，新 entity 用 `@CreateDateColumn({ type: 'timestamptz' })`。
- **环境变量**：IP/端口/域名/凭据一律走 `.env`，不写死在源码（生产换环境只改 env）。
- **照片/视频 URL**：用 `MINIO_PUBLIC_BASE_URL` 构造，不从 endpoint+port 拼。
- **生产**：`DB_SYNCHRONIZE=false`，改走 `pnpm --filter @pms/api migration:run`。

## 进度

- [x] Monorepo 骨架 + NestJS API 骨架
- [x] 28 张核心表 entity（租户/组织/账号/工单/材料/采购/字典/通知）
- [x] JWT + RBAC（RolesGuard）骨架、健康检查
- [x] 业主入驻审核 + 二维码解析（基础 API 已上线）
- [x] 楼栋报修码：一栋一张小程序码，微信扫一扫直达报修/入驻，后台批量补齐 + A5 排版打印（见 [`docs/qr-building-codes.md`](docs/qr-building-codes.md)）
- [x] 报修登记 + 工单创建（基础 API 已上线）
- [x] 业主端微信登录 + 入驻（AppID 已接入，线上闭环）
- [x] 员工端微信登录：手机号一键登录 / 账号密码兜底 + 微信绑定与后台解绑
- [x] 小程序业务闭环：扫码报修 → 工单池抢单 → 完工上传 → 业主验收/催单/撤单
- [x] 材料库存、库存盘点、缺料汇总与采购审批
- [x] 订阅消息通知基础闭环 + 数据看板
- [ ] 两个小程序业务页面完善与提审发布
