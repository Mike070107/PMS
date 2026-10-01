# 内网应用发布网关

## 目标架构

`https://<子域名>.prsznh.cn` 先经过 Cloudflare Access，再由 Cloudflare Tunnel 转发到目标局域网的 HTTP/HTTPS 网站。访问者只会看到独立微信扫码页，在「邻修管理」小程序确认后直接回到目标内网站点，不进入 PMS 后台框架。

PMS 管理员在「内网应用发布」页配置：

- 应用名称
- 外网子域名
- `cloudflared` 能访问的内网 URL
- PMS 人员档案中的授权用户
- Cloudflare 会话有效期

内部权限标识由域名自动生成，不要求管理员填写。

## Cloudflare 一次性配置

1. 创建或选定一条远程管理的 Cloudflare Tunnel。
2. 在 Zero Trust 中添加一个 Generic OIDC 身份提供方：
   - Auth URL：`https://prsznh.cn/api/v1/auth/oidc/authorize`
   - Token URL：`https://prsznh.cn/api/v1/auth/oidc/token`
   - Certificate URL：`https://prsznh.cn/api/v1/auth/oidc/jwks`
   - Scopes：`openid email profile`
   - Email claim：`email`
   - Custom OIDC claim：`external_apps`
   - PKCE：可开启，PMS 只接受 `S256`
3. 把 Cloudflare 显示的 callback URL 完整填入 `EXTERNAL_OIDC_REDIRECT_URIS`。
4. 把 IdP ID 填入 `CLOUDFLARE_ACCESS_IDP_ID`。
5. 配置专用 API Token，只授予 Access Apps and Policies Write、Cloudflare Tunnel Edit 和 Zone DNS Edit。

服务器变量模板见 `apps/api/.env.production.example`。密钥、API Token 和 Tunnel Token 不得进 Git。

## 自动发布顺序

保存一条应用时，API 按以下顺序同步：

1. 创建或接管同域名的 Access 应用。
2. 建立 `external_apps` 精确值匹配的 Allow 策略，并启用单一 IdP 即时认证。
3. 创建指向 `<tunnel-id>.cfargotunnel.com` 的代理 CNAME。
4. 合并 Tunnel ingress，保留其他模块管理的路由，最后固定为 `http_status:404`。

先建 Access 保护，再建 DNS/Tunnel 路由，避免发布过程中出现短暂裸露。如果同名 DNS 已指向其他目标，系统会拒绝覆盖并显示具体原因。

### 策略更新入口

Cloudflare 应用策略列表会同时返回应用专属策略和账号级可复用策略。同步时必须先按策略 ID 判断类型：应用专属策略使用 `/accounts/{account}/access/apps/{app}/policies/{id}`，可复用策略使用 `/accounts/{account}/access/policies/{id}`。把可复用策略误用应用级入口会返回 `can not update reusable policies through this endpoint`，页面应保留具体错误并允许重试。

## 局域网连接器

每个目标局域网至少需有一台能访问内网站点的常开主机运行 `cloudflared` 守护进程。这个守护进程只建立出站连接，无需在路由器开入站端口。

验收时需确认：

- Tunnel 连接器在 Cloudflare 显示在线。
- 连接器主机可直接打开配置的内网 URL。
- 未授权用户被 Access 拒绝，授权用户扫码后直接进入目标站点。
- 目标站点的登录、下载、WebSocket 和绝对 URL 资源在新域名下均正常。
- 取消授权后，新会话立即被拒绝；已签发会话在 Access 会话有效期到期后失效。
