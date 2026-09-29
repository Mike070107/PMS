# PMS 数据同步助手

可复制到任意 Windows 电脑的 x86 .NET Framework 4.0 小应用。双击 `Pms.DataSyncAssistant.exe` 后可在图形界面选择连接类型、配置代理 ID 和密钥、测试连接并安装后台服务。门禁是当前首组适配器，后续可继续增加其他数据库。

当前支持四种部署身份：

- `issuer`：任意安装 ACR122U 的办公电脑。
- `access_gateway`：`192.168.1.88`，后续加载两套 MDB 和控制器适配器。
- `legacy_sync`：`192.168.1.80`，后续连接旧 SQL 发卡数据库。
- `parking_gateway`：连接 `192.168.6.3` 上的 `parking1` / `parking2` 停车数据库。

当前版本已经实现代理凭据、DPAPI 加密、心跳、带租约任务领取、结果回报和 ACR122U/PCSC 设备枚举。所有真实写入能力仍为关闭状态，代理只会报告“等待验收”，不会修改卡片、数据库或控制器。

## 构建

```powershell
C:\Windows\Microsoft.NET\Framework\v4.0.30319\MSBuild.exe .\AccessCardAgent.csproj /p:Configuration=Release /p:Platform=x86
```

## 安装

1. 在 PMS 后台为对应电脑注册代理，复制只显示一次的代理 ID 和密钥。
2. 使用对应电脑的专用包；包内 `agent.config.json` 已包含服务地址、类型和电脑名称。
3. 双击 `Pms.DataSyncAssistant.exe`，直接粘贴代理 ID 和一次性密钥。密钥会保存为本机 DPAPI 密文 `agent.token.dat`。
4. 点击“保存并测试连接”。
5. 点击“保存并安装后台服务”，在 Windows 授权框点“是”。
6. 正常启动程序后，PMS 页面应显示对应代理在线。

## 后台服务与托盘状态

连接测试成功后，右键 PowerShell 选择“以管理员身份运行”，进入代理目录并执行：

```powershell
.\Pms.DataSyncAssistant.exe --install-service
```

该命令会安装并启动 Windows 服务，设为开机自启和异常自动重启，同时在当前用户右下角启用状态图标。托盘菜单会区分“已连接 PMS”、“服务运行中，PMS 连接异常”和“后台服务已停止”。关闭 PowerShell 或退出托盘图标不会停止后台服务。

托盘进程和设置窗口都有 Windows 会话级单实例锁。重复双击应用或重复点击“安装后台服务”不会再创建右下角图标；托盘正常退出时会显式隐藏并释放 `NotifyIcon`。

`.80` 旧库电脑还需运行 `--install-db-password` 保存数据库密码。接入真实写入前，可用以下只读命令核对房号累计数量与下一序号：

```powershell
.\Pms.DataSyncAssistant.exe --legacy-count 228/5/301
.\Pms.DataSyncAssistant.exe --legacy-history 228/5/301
```

Web 选中房号后，`legacy_sync` 代理会自动领取只读历史查询，返回精确房号下的 Person NO、数字尾号、卡号与发卡时间。查询会把页面房号 `228/5/301` 规范化为旧库格式 `228/05/301`。

该命令使用参数化查询和 `房号/数字` 精确前缀，事务最后强制回滚，不会修改旧库。

`.88` 门禁电脑使用 `agent.config.access-gateway.example.json`。先保存 iCCard MDB 密码，再执行两套真实数据库的只读探测：

```powershell
.\Pms.DataSyncAssistant.exe --install-iccard-password
.\Pms.DataSyncAssistant.exe --access-probe
```

`--access-probe` 只读取数据库文件和内置白名单表的记录数，不会写 MDB 或调用控制器。

停车网关使用 `agent.config.parking-gateway.example.json`。数据库用户应先配置为只读权限，然后保存密码并探测一期、二期双库：

```powershell
Get-Clipboard | .\Pms.DataSyncAssistant.exe --install-parking-db-password
.\Pms.DataSyncAssistant.exe --parking-probe
```

`--parking-probe` 只读取 `Car_Issue` / `Car_Download` 记录数，并检查停车存储过程是否存在。当前 `parkingDbWrite=false`，不会登记、续期、换牌、注销或创建设备下载任务。

`agent.config.json`、`agent.token.dat`、`legacy-db-password.dat`、`parking-db-password.dat`、卡片密钥、完整卡镜像和数据库密码均不得进入 Git 或普通日志。
