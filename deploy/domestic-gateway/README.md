# PMS 国内内网访问网关

生产链路：

`Browser -> Tencent Cloud Nginx -> pms-gateway-router (127.0.0.1:4190，每个请求向 PMS 校验) -> FRP WSS tunnel -> LAN origin`

`*.prsznh.cn`（含 `caiwu.`）都由 Nginx 交给 `pms-gateway-router`；oauth2-proxy 已不在链路中，服务已停用。

## 安全边界

- FRP 客户端只主动连接 `gateway.prsznh.cn:443`，局域网不开入站端口；
  使用标准 WSS 出站以兼容禁止非标准端口的企业网络。
- FRP 公开代理端口只绑定腾讯云 `127.0.0.1`，外网不能轰过鉴权层直连用友。
- Nginx 终止 WSS TLS 后只在本机转交 `frps`；`frps` 的 7000 端口也仅监听
  `127.0.0.1`。token 只存于服务器和该局域网安装包。
- 网关路由对每个 HTTP 请求和 WebSocket 升级都调用 PMS `/gateway-access/verify`
  （带路由私钥），会话签名绑定应用，且每次都重新检查授权、账号状态，撤权即时生效。
- 会话 Cookie `__Host-pms_gateway` 只写在当前应用自己的域名上（无 Domain），由网关路由
  用扫码确认后发放的 60 秒一次性交接码换取；不会带到 `*.prsznh.cn` 的其他站点，
  多个应用可以同时保持登录。
- frps 插件 `ops` 含 `NewUserConn`：每条访问连接都再查一次应用是否启用，停用后即使
  代理端旧隧道未断，也接不进内网。
- 扫码票据同时绑定当前浏览器的 HttpOnly Cookie、首次扫码员工和具体应用；手机与
  电脑必须显示相同的应用名称、域名与四位核对码。二维码照片或 ticket 单独泄漏
  不能在另一台浏览器领取会话。
- OIDC 授权码使用 PKCE S256、两分钟过期并只能消费一次；确认、签发授权码和换取
  令牌三个阶段都重新检查当前应用授权，撤权后不能创建新会话。
- 登录有效期可选 4 / 8 / 12 小时，默认 8 小时。停用应用或移除授权后，下一个请求
  即被拒绝（每个请求都实时校验）。
- API 只通过受信任的紧邻反向代理解析客户端地址；`TRUST_PROXY_HOPS` 必须与实际
  代理层数一致，API 业务端口不得直接暴露公网。
- 密钥、token、生产客户端配置和生产 oauth2-proxy 配置不进 Git。

## 主机安全误报处理

FRP 的 `frpc` 具备穿透和代理能力，主机安全产品可能将官方二进制文件
归类为 `HackTool` / `RiskTool`。不得因此直接加全局白名单，也不得只看文件名
就判定是入侵。每次告警按下列顺序核对：

1. 对照 FRP 官方 GitHub Release 校验完整压缩包 SHA-256；
2. 校验已安装 `frps` 与已验证压缩包内的 `frps` 完全一致；
3. 确认云服务器没有 `frpc` 进程，且 `frps` 的管理端口和代理端口均只监听
   `127.0.0.1`；
4. 核对 systemd 进程路径、配置路径和启动时间，不认可任意临时目录中的长驻进程。

服务端安装脚本只从已校验压缩包流式提取 `frps`，不再将 `frpc` 解压到
云服务器临时目录。局域网 Windows 主机才是 `frpc` 的合法运行位置。

## 用友财务系统端口

- 公网域名：`caiwu.prsznh.cn`
- 内网源站：`http://192.168.110.251:8050`
- 腾讯云回源端口：`127.0.0.1:18050`
- 网关路由：`127.0.0.1:4190`（oauth2-proxy 已停用）
- FRP WSS 入口：`gateway.prsznh.cn:443`
- FRP server：`127.0.0.1:7000`

## 切换门槛

DNS 从 Cloudflare Tunnel 切换到腾讯云前必须同时满足：

1. `frps` 与 `oauth2-proxy` 系统服务均为 active。
2. 局域网 Windows 主机的 FRP 客户端已在线。
3. 腾讯云 `curl http://127.0.0.1:18050/tplus/view/login.html` 返回 200。
4. `caiwu.prsznh.cn` 证书已签发，`nginx -t` 通过。
5. 未授权请求会 302 到 PMS 扫码页，授权用户可直接进入用友。

安装脚本会同时配置 certbot 部署钩子：证书续期成功后先执行
`nginx -t`，再热加载 Nginx，无需重启服务器。

生产实际配置使用同目录的 `.example` 作为模板，不回填密钥。
