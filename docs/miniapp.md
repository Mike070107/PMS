# 小程序工程说明

> 两个小程序工程：
> - [apps/miniapp-owner/](../apps/miniapp-owner/) — 业主端（邻修）
> - [apps/miniapp-staff/](../apps/miniapp-staff/) — 物业端（邻修工作台）
>
> 共享：
> - [packages/shared-types/](../packages/shared-types/) — 枚举与 DTO
> - [packages/api-client/](../packages/api-client/) — wx.request 封装 + 端点函数
> - [packages/miniapp-ui/](../packages/miniapp-ui/) — 自定义组件 + 设计令牌（tokens.wxss）

---

## 目录结构

```
apps/
  miniapp-owner/
    miniprogram/
      app.ts            # 注册 api-client、token 存取
      app.json          # pages + tabBar
      app.wxss          # @import tokens.wxss
      pages/
        index/          # 首页（扫码 / 登录）
        onboard/        # 业主入驻表单
        repair-create/  # 报修提交
        orders/         # 我的报修列表
        order-detail/   # 工单详情 + 验收
        me/             # 个人中心
    package.json        # workspace 依赖 @pms/api-client 等
    project.config.json # 微信开发者工具配置
    tsconfig.json
  miniapp-staff/
    miniprogram/
      app.ts / app.json / app.wxss
      pages/
        login/          # 员工登录
        pool/           # 工单池（待派单）
        my-orders/      # 我的在手工单
        order-detail/   # 接单 / 到场 / 完工
        approvals/      # 采购审批（W3 接入）
        me/
    ...
packages/
  api-client/src/{request.ts, endpoints/*.ts, index.ts}
  miniapp-ui/{tokens.ts, tokens.wxss, status.ts, components/*}
  shared-types/index.ts
```

---

## 本地开发流程

### 1. 安装依赖

```powershell
pnpm install
```

> pnpm workspace 会自动将 `@pms/api-client`、`@pms/miniapp-ui`、`@pms/shared-types` 软链接到两个小程序的 `node_modules/`。

### 2. 用微信开发者工具打开

分别导入：
- `c:\Users\Administrator\pms-repair\apps\miniapp-owner`
- `c:\Users\Administrator\pms-repair\apps\miniapp-staff`

首次打开后需要点 **「工具 → 构建 npm」**，将 `node_modules/@pms/*` 构建到 `miniprogram/miniprogram_npm/@pms/*`。  
之后 `usingComponents: { "pms-tag": "@pms/miniapp-ui/components/status-tag/index" }` 才能解析。

### 3. AppID

`project.config.json` 默认 `appid: "touristappid"`（游客模式，无法真机预览）。  
申请到正式 AppID 后，替换两个工程的 `project.config.json` 中的 `appid`。

### 4. API 地址

`miniprogram/app.ts` 中的 `baseURL` 默认是 `https://api.example.com/api/v1`。  
本地联调时改成局域网 IP（如 `http://192.168.1.100:4000/api/v1`），并在开发者工具的 **「详情 → 本地设置 → 不校验合法域名」** 勾上即可。

生产环境域名需在 **微信公众平台 → 开发 → 服务器域名** 配置（见 [miniapp-registration.md](miniapp-registration.md)）。

### 5. 类型检查

```powershell
pnpm miniapp:owner:typecheck
pnpm miniapp:staff:typecheck
```

---

## 改完怎么在手机上看到（日常最高频）

一条命令搞定「编译共享包 → 构建 npm → 推到手机」，不用再去开发者工具里手点：

```powershell
pnpm mp                              # 业主端，自动预览：直接推到手机，不用扫码
pnpm mp:staff                        # 员工端
pnpm mp -- --qr                      # 改成出二维码图（自动打开），用微信扫
pnpm mp -- --upload --desc "修图片"   # 上传体验版，版本号自动排号（不用手改任何常量）
```

### 微信审核账号

员工端审核账号 `testadmin` 可使用账号密码直接登录，不绑定审核员微信。后端只对
`MINIAPP_REVIEW_ACCOUNTS` 白名单中的账号跳过微信绑定，密码、员工端角色、启用状态仍照常校验；
普通员工首次账号密码登录仍会绑定当前微信。多个审核账号用英文逗号分隔。

脚本：[tools/miniapp-ship.mjs](../tools/miniapp-ship.mjs)

**前置（只配一次）**：开发者工具 → 设置 → 安全设置 → 打开「服务端口」。

**自动预览怎么在手机上打开**：微信里搜「微信开发者工具」这个官方小程序（推过一次后会留在最近使用里），
进去就是刚推上去的代码。不用扫码、不用清缓存，改一次跑一次命令，手机上刷新即可。

### 三种测试方式怎么选

| 方式 | 命令 / 入口 | 什么时候用 | 要不要清手机缓存 |
|---|---|---|---|
| 自动预览 | `pnpm mp` | 日常改完看效果，最快 | 不用 |
| 真机调试 | 开发者工具工具栏「真机调试」 | 要看真机 console / 网络请求 / 复现只在真机出现的 bug | 不用 |
| 体验版 | `pnpm mp -- --upload` | 给别人试用、验收、模拟真实用户 | 装上带自动更新的那版之后就不用了 |

> 真机调试和预览跑的都是**本地当前代码**，不经过版本管理，所以「我的」页显示的是
> `utils/buildStamp.ts` 里的占位 `dev`；只有上传出去的包才带真版本号。

### 版本号和「手机上这版到底是哪份代码」

版本号**不用手改**，`pnpm mp -- --upload` 会自己排：`1.0.<日期><字母>`。脚本同时读取随主线同步的
`deploy/DEPLOY_LOG.md` 和本机台账 `.ship-log.json`，按当天已发过的最大序号继续往后排
（只往后，不回填空位 —— 回填会和历史版本撞号）。

`upload` 成功只代表版本进入公众平台“开发版本”，不代表手机上的体验版已经切换。发布任务只有在
公众平台体验版指向本次 hash、并在手机真实入口核对版本号后才算完成。

原理：`miniprogram/utils/buildStamp.ts` 在 git 里永远是 `dev` 占位，上传前脚本把真版本号和
git 短 hash 写进去，传完立刻还原。**所以发版不产生任何代码改动**，多个开发会话并行时
不会再抢同一行常量（2026-08-26 踩过：一个会话排到 d、另一个排到 g，最后传出去的是 g，
于是「手机上的版本号」和「以为发的那份代码」对不上）。

「我的」页最下面显示 `1.0.20260826i · b3454a2`，后面那个 hash 就是发版时的提交：
公众平台的版本备注里是同一个 hash，`git show <hash>` 就是那份代码。
同版本号有多条时**认 hash，别认版本号** —— 认错就是「体验版怎么退回旧版本了」。

上传前脚本会打印「这一包装了什么」：基线提交，加上会被一起打进包里的未提交文件清单
（`upload` 打的是**磁盘快照**而不是 git 提交，所以别人还没提交的改动也会进去）。
多个会话并行开发时，发版前一定扫一眼这份清单。

同一时刻只允许一个上传在跑（`.ship.lock`）；撞上了会直接告诉你另一个发版在进行中。

---

## 共享代码使用约定

### packages/shared-types

枚举与 DTO 的单一来源。新增字段时：
1. 修改 [packages/shared-types/index.ts](../packages/shared-types/index.ts)
2. 同步修改 [apps/api/src/common/enums.ts](../apps/api/src/common/enums.ts)（暂时手动同步，后续视情况让 API 也直接消费 shared-types）

### packages/api-client

每个小程序在 `app.ts` 的 `onLaunch` 中调用一次 `configure({ baseURL, getToken, onUnauthorized })`，之后任意页面 `import { repairs } from '@pms/api-client'` 即可。

新增端点：
1. 在 `packages/api-client/src/endpoints/<module>.ts` 添加函数
2. 在 `packages/api-client/src/index.ts` 中 `export * as <module>` 暴露

### packages/miniapp-ui

- **设计令牌**：`tokens.wxss`（CSS 变量）+ `tokens.ts`（TS 常量）。修改一处需双向同步。
- **自定义组件**：放 `components/<name>/index.{js,json,wxml,wxss}`。  
  组件必须用 `.js` 而非 `.ts`（小程序构建 npm 不处理 TS），逻辑简单的就用 JS 即可。

---

## 待办（W2–W3 业务开发阶段）

- [ ] 接入真实 baseURL，移除 `https://api.example.com` 占位
- [ ] 业主端 `onboard` 页接入小区/楼栋选择器（依赖 API：GET /communities, GET /buildings）
- [ ] 业主端 `repair-create` 接入二维码解析（POST /qr/resolve）
- [ ] 物业端 `approvals` 接入采购申请列表 + 审批动作
- [ ] 订阅消息模板 ID 配置化（统一放 `packages/shared-types` 的常量表）
- [ ] 两端引入埋点 SDK（一期可先用 console + 后端日志）
