# PMS 门禁本地代理

同一份 x86 .NET Framework 4.0 程序支持三种部署身份：

- `issuer`：任意安装 ACR122U 的办公电脑。
- `access_gateway`：`192.168.1.88`，后续加载两套 MDB 和控制器适配器。
- `legacy_sync`：`192.168.1.80`，后续连接旧 SQL 发卡数据库。

当前版本已经实现代理凭据、DPAPI 加密、心跳、带租约任务领取、结果回报和 ACR122U/PCSC 设备枚举。所有真实写入能力仍为关闭状态，代理只会报告“等待验收”，不会修改卡片、数据库或控制器。

## 构建

```powershell
C:\Windows\Microsoft.NET\Framework\v4.0.30319\MSBuild.exe .\AccessCardAgent.csproj /p:Configuration=Release /p:Platform=x86
```

## 安装

1. 在 PMS 后台为对应电脑注册代理，复制只显示一次的代理 ID 和密钥。
2. 使用对应电脑的专用包；包内 `agent.config.json` 已包含服务地址、类型和电脑名称。
3. 在网页复制一次性密钥，然后运行 `Get-Clipboard | .\Pms.AccessCardAgent.exe --install-agent <后台显示的代理ID>`。管道输入可兼容旧版 PowerShell，密钥不会显示或进入命令历史。程序会写入代理 ID，并把密钥保存为本机 DPAPI 密文 `agent.token.dat`。
4. 运行 `Pms.AccessCardAgent.exe --connect-test`。它只向 PMS 发送一次心跳，成功后立即退出，不会领取任务。
5. 发卡电脑可再运行 `Pms.AccessCardAgent.exe --readers`，确认输出包含 `ACR122`。
6. 正常启动程序后，PMS 页面应显示对应代理在线。

`.80` 旧库电脑还需运行 `--install-db-password` 保存数据库密码。接入真实写入前，可用以下只读命令核对房号累计数量与下一序号：

```powershell
.\Pms.AccessCardAgent.exe --legacy-count 228/5/301
.\Pms.AccessCardAgent.exe --legacy-history 228/5/301
```

Web 选中房号后，`legacy_sync` 代理会自动领取只读历史查询，返回精确房号下的 Person NO、数字尾号、卡号与发卡时间。查询会把页面房号 `228/5/301` 规范化为旧库格式 `228/05/301`。

该命令使用参数化查询和 `房号/数字` 精确前缀，事务最后强制回滚，不会修改旧库。

`.88` 门禁电脑使用 `agent.config.access-gateway.example.json`。先保存 iCCard MDB 密码，再执行两套真实数据库的只读探测：

```powershell
.\Pms.AccessCardAgent.exe --install-iccard-password
.\Pms.AccessCardAgent.exe --access-probe
```

`--access-probe` 只读取数据库文件和内置白名单表的记录数，不会写 MDB 或调用控制器。

`agent.config.json`、`agent.token.dat`、`legacy-db-password.dat`、卡片密钥、完整卡镜像和数据库密码均不得进入 Git 或普通日志。
