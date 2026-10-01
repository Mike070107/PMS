# PMS 内网发布助手

面向财务室、仓库和物业机房等 Windows 电脑的图形化内网代理。它把 `frpc` 作为受管代理核心运行，用户不再需要编辑 TOML 或执行 PowerShell 命令。

## 使用方式

1. 解压发布包，双击 `Pms.LanGatewayAssistant.exe`。安装后台服务时，程序会把正式运行副本放到 `%ProgramData%\PMS\LanGatewayAssistant\bin`，解压目录之后可以删除。
2. 旧电脑会自动识别并导入 `C:\ProgramData\PMSGateway` 中的用友配置和连接凭据。
3. 点击“安装后台服务”。管理员确认一次后，代理随电脑开机启动，异常退出会自动恢复。
4. 在“内网应用”中添加名称、外网域名和局域网网址；保存前会验证域名格式、内网地址和 HTTP 连通性。

程序数据位于 `%ProgramData%\PMS\LanGatewayAssistant`。连接凭据使用 Windows DPAPI 本机加密；运行时明文文件只允许 SYSTEM 和管理员读取。

## 新电脑复用

新电脑发布包由 `build-package.ps1` 生成，包内可以携带 `frpc.exe` 与一次性下发的 `frp-token`。首次启动后凭据会被加密导入。不要通过聊天、源码仓库或日志传递 token。

```powershell
.\build-package.ps1 -FrpcArchive C:\secure\frp_0.71.0_windows_amd64.zip -TokenFile C:\secure\frp-token
```

如果只是构建和自检界面程序，可不传这两个参数；此时生成的包适合升级现有电脑，不适合空白电脑首次连接。

## 更新

助手从 `https://prsznh.cn/downloads/pms-lan-gateway-assistant/latest.json` 检查更新，下载后校验 SHA-256，更新失败会恢复旧文件并重新启动服务。

`publish-update.ps1` 默认只生成更新制品，不上传生产。只有明确获准生产发布时才使用 `-Upload`。

## 发布边界

Windows 助手负责“局域网应用 → PMS 网关”的长连接。公网 DNS、TLS 证书、微信扫码授权及网关路由属于 PMS 服务端发布流程，不能只靠新增本机路由完成。服务端自动发布完成前，不应把“配置已保存”显示为“公网已发布”。
