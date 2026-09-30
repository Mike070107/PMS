# PMS 数据同步助手

可复制到任意 Windows 电脑的 x86 .NET Framework 4.0 小应用。双击 `Pms.DataSyncAssistant.exe` 后可在图形界面选择连接类型、粘贴一次性连接密钥、测试连接并安装后台服务。

当前支持四种部署身份：

- `issuer`：任意安装 ACR122U 的办公电脑。
- `access_gateway`：`192.168.1.88`，后续加载两套 MDB 和控制器适配器。
- `legacy_sync`：`192.168.1.80`，后续连接旧 SQL 发卡数据库。
- `parking_gateway`：连接 `192.168.6.3` 上的 `parking1` / `parking2` 停车数据库。

当前版本已经实现代理凭据、DPAPI 加密、心跳、带租约任务领取、结果回报、ACR122U/PCSC 设备枚举，以及停车双库的实时查询。0.5.0 起会检查停车专用账号是否同时具有一期、二期所需存储过程的执行权限；只有全部通过时才向 PMS 上报 `parkingDbWrite=true`。

## 构建

```powershell
C:\Windows\Microsoft.NET\Framework\v4.0.30319\MSBuild.exe .\AccessCardAgent.csproj /p:Configuration=Release /p:Platform=x86
```

## 安装

1. 在 PMS 后台为对应电脑注册代理，复制只显示一次的连接密钥。固定服务再次生成密钥时会沿用原代理 ID。
2. 使用对应电脑的专用包；包内 `agent.config.json` 已包含服务地址、类型和电脑名称。
3. 双击 `Pms.DataSyncAssistant.exe`，只需粘贴一次性连接密钥。代理 ID 会自动识别，密钥保存为仅本机可解密的 DPAPI 密文 `agent.token.dat`。
4. 点击“保存并测试连接”。
5. 点击“保存并安装后台服务”，在 Windows 授权框点“是”。
6. 正常启动程序后，PMS 页面应显示对应代理在线。

## 配置保存与升级

- 一个目录只绑定一种服务；`.80旧库同步` 与 `枫桦景苑停车系统网关` 必须放在两个独立目录，设置完成后用途会锁定，防止互相覆盖。
- `agent.config.json` 保存固定代理 ID 和非敏感连接参数；`agent.token.dat`、`legacy-db-password.dat`、`parking-db-password.dat` 使用 Windows DPAPI 加密，只能在保存它们的同一台电脑上解密。
- 日常升级不要删除上述文件。双击现有助手，点“安装更新”并选择新版程序；助手会自动停止对应服务、备份旧程序、替换并重启，所有参数保持不变。
- 增加新功能不会要求重新填写旧服务参数。只有首次安装、主动轮换密钥，或加密文件已经丢失/被覆盖时才需要重新输入。

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
.\Pms.DataSyncAssistant.exe --parking-procedure-info
```

`--parking-probe` 读取 `Car_Issue` / `Car_Download` 记录数，并检查停车存储过程是否存在。网关会另外验证两个库的存储过程执行权限，网页显示“受控写入测试已开放”后，才允许下一步用指定测试车牌验证登记、续期、换牌、注销和设备下载。
`--parking-procedure-info` 只读取一期、二期各个存储过程的参数名和类型，用于核对新增车辆时是否同时维护授权和下载队列，不执行写入。

0.4.1 起，停车网关会从 `Car_Issue.Owner_ID` 自动识别并联查旧库住户主表；车牌查询可同时返回住户字段，房号、姓名和电话也可反向查到车辆。查询使用参数化 SQL，一期、二期各最多返回 50 条；`228/5/301` 与 `198-5-201` 会同时尝试斜杠和横线形式，整个过程不执行写入语句。

`agent.config.json`、`agent.token.dat`、`legacy-db-password.dat`、`parking-db-password.dat`、卡片密钥、完整卡镜像和数据库密码均不得进入 Git 或普通日志。
