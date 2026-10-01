# PMS 数据同步助手

本版本把旧版每台电脑一个代理程序，合并为一个可管理多种连接的 Windows 应用和后台服务。

## 已接入能力

- 从旧版 `agent.config.json`、`agent.token.dat` 和数据库密码文件自动迁移配置。
- 使用 Windows DPAPI（本机范围）保存 PMS 代理密钥和数据库密码。
- 按连接分别向 PMS 发送心跳、领取任务并回报结果。
- 支持 `.80` 旧库历史查询、`.88` 的 MjSystem / iCCard MDB 真实读取检测，以及停车库查询。
- 2.3.0 支持从 PMS 正式更新一期、二期旧停车库住户姓名、电话、房号和备注；写入前核对旧值，写入后读回验证，并在备注追加 PMS 操作来源。
- 2.4.0 将房号、车牌、车牌尾号、电话和姓名分开查询；房号按分隔符边界匹配，`6/502` 不再误查 `36/502`，并从旧库换牌流水读取真实操作时间。
- 2.5.0 增加停车业务操作队列：新增、续期收费、换牌、变更绑定用户、车库授权、设备下载和注销均调用旧系统存储过程，支持失败重试、操作审计和安全回滚。
- 后台服务开机自启；右下角状态图标显示服务和连接在线数量。
- 安全替换旧服务：先验证本地数据库和 PMS 身份，再停旧服务；新版验证在线后才删除旧服务，失败会自动恢复旧服务。
- 2.5.0 起右上角“检查更新”会读取 HTTPS 更新清单，自动下载并校验新版 EXE；确认后停止服务、备份旧程序、替换并重启。`ProgramData\PMS\DataSyncAssistant` 下的配置、代理 ID、数据库密码不会被覆盖。
- 2.5.1 修复升级验证延迟时误卸载正在运行的新版服务；回滚前会先确认旧服务真正恢复，避免升级后新旧服务同时离线。
- 2.5.2 支持从 PMS 历史卡片为已发卡追加其他楼栋权限，并将权限写入旧门禁数据库后上传现场控制器。
- 后台服务每 6 小时检查新版，自动下载、校验、切换并在失败时回滚；前台窗口无需手工关闭。
- 窗口显示当前版本、目标版本、更新阶段和下载进度，可手动重试或在完成后打开新版。

## 从旧版升级

1. 将 `Pms.DataSyncAssistant.V2.exe` 放到 D 盘的固定目录，不要放在临时目录。
2. 双击打开。程序会扫描旧版目录并自动迁移已有的代理 ID、代理密钥、MDB 路径和数据库密码。
3. 在连接卡片中确认本地数据库检测正常。
4. 展开“助手信息”，点击“安装 / 安全升级后台服务”。
5. 管理员授权后，程序会完成验证、切换和旧服务清理。成功提示出现前不要关机。

配置保存在 `%ProgramData%\PMS\DataSyncAssistant`。卸载后台服务不会删除连接配置或加密密码。

## 发布更新清单

更新清单默认地址为 `https://prsznh.cn/downloads/pms-data-sync-assistant/latest.json`，格式见 `update-manifest.example.json`。清单和 EXE 必须通过 HTTPS 发布，且 `sha256` 必须填写发布 EXE 的完整 SHA-256。测试环境可设置 `PMS_ASSISTANT_UPDATE_MANIFEST_URL`，或把 `latest.json` 放到 `%ProgramData%\PMS\DataSyncAssistant\updates\` 做离线验收。

## 命令行诊断

```powershell
.\Pms.DataSyncAssistant.V2.exe --self-test
```

退出代码 `0` 表示配置、DPAPI、运行参数映射、旧版 `.88` 迁移、停车住户栏位映射和更新器测试通过。

## 发布新版

`publish-update.ps1` 会从 Release x86 重新构建，运行自检，然后生成带 SHA-256 的 `release/latest.json` 和版本目录。默认只在本地生成；只有明确要求发布生产时才使用：

```powershell
.\publish-update.ps1 -Upload
```

客户端只接受 `https://prsznh.cn/downloads/pms-data-sync-assistant/` 下的文件，且必须同时通过 SHA-256 和 Windows 文件版本校验。
