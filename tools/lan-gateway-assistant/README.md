# PMS 内网发布助手

面向财务室、仓库和物业机房等 Windows 电脑的图形化内网代理。它把 `frpc` 作为受管代理核心运行，用户不再需要编辑 TOML 或执行 PowerShell 命令。

1.1 版起 PMS 控制台是唯一配置源：代理通过 10 分钟有效、仅可使用一次的安装码注册，自动领取整份应用配置、检查内网站点并原子替换运行修订。失败时保留上一版可用配置并向 PMS 回报具体原因。完整产品边界与验收见 [`../../docs/lan-gateway-product.md`](../../docs/lan-gateway-product.md)。

## 使用方式

1. 解压发布包，双击 `Pms.LanGatewayAssistant.exe`。安装后台服务时，程序会把正式运行副本放到 `%ProgramData%\PMS\LanGatewayAssistant\bin`，解压目录之后可以删除。
2. 在 PMS 后台添加「代理设备」，复制安装码。
3. 在助手顶部输入安装码，点击「连接并安装」，在 Windows 授权框点「是」。
4. 以后在 PMS 新增、修改或停用应用；助手自动下发，不在本机维护路由。

程序数据位于 `%ProgramData%\PMS\LanGatewayAssistant`。连接凭据使用 Windows DPAPI 本机加密；运行时明文文件只允许 SYSTEM 和管理员读取。

## 新电脑复用

新电脑发布包由 `build-package.ps1` 生成，包内只携带经过 SHA-256 校验的 `frpc.exe`，不再分发长期连接凭据。首次输入 PMS 安装码后，设备凭据和代理凭据才由控制面下发并使用 Windows DPAPI 本机加密。不要通过聊天、源码仓库或日志传递 token。

```powershell
.\build-package.ps1 -FrpcArchive C:\secure\frp_0.71.0_windows_amd64.zip
```

如果只是构建和自检界面程序，可不传参数；此时生成的包适合升级现有电脑，不适合空白电脑首次连接。

## 更新

助手从 `https://prsznh.cn/downloads/pms-lan-gateway-assistant/latest.json` 检查更新，下载后校验 SHA-256，更新失败会恢复旧文件并重新启动服务。

`publish-update.ps1` 默认只生成更新制品，不上传生产。只有明确获准生产发布时才使用 `-Upload`。

## 发布边界

Windows 助手负责“局域网应用 → PMS 网关”的长连接。公网 DNS、TLS 证书、微信扫码授权及网关路由属于 PMS 服务端发布流程，不能只靠新增本机路由完成。服务端自动发布完成前，不应把“配置已保存”显示为“公网已发布”。
