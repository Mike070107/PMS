# PMS 国内内网访问网关

生产链路：

`Browser -> Tencent Cloud Nginx -> oauth2-proxy/PMS OIDC -> FRP WSS tunnel -> LAN origin`

## 安全边界

- FRP 客户端只主动连接 `gateway.prsznh.cn:443`，局域网不开入站端口；
  使用标准 WSS 出站以兼容禁止非标准端口的企业网络。
- FRP 公开代理端口只绑定腾讯云 `127.0.0.1`，外网不能轰过鉴权层直连用友。
- Nginx 终止 WSS TLS 后只在本机转交 `frps`；`frps` 的 7000 端口也仅监听
  `127.0.0.1`。token 只存于服务器和该局域网安装包。
- Nginx 使用 `auth_request` 调用 oauth2-proxy；OIDC 令牌中的 `external_apps`
  必须包含当前应用 slug，才会建立会话。
- 密钥、token、生产客户端配置和生产 oauth2-proxy 配置不进 Git。

## 用友财务系统端口

- 公网域名：`caiwu.prsznh.cn`
- 内网源站：`http://192.168.110.251:8050`
- 腾讯云回源端口：`127.0.0.1:18050`
- oauth2-proxy：`127.0.0.1:4180`
- FRP WSS 入口：`gateway.prsznh.cn:443`
- FRP server：`127.0.0.1:7000`

## 切换门槛

DNS 从 Cloudflare Tunnel 切换到腾讯云前必须同时满足：

1. `frps` 与 `oauth2-proxy` 系统服务均为 active。
2. 局域网 Windows 主机的 FRP 客户端已在线。
3. 腾讯云 `curl http://127.0.0.1:18050/tplus/view/login.html` 返回 200。
4. `caiwu.prsznh.cn` 证书已签发，`nginx -t` 通过。
5. 未授权请求会 302 到 PMS 扫码页，授权用户可直接进入用友。

生产实际配置使用同目录的 `.example` 作为模板，不回填密钥。
