# Windows PMS 数据同步助手 2.6.0 发布验收

## 结果（2026-11-18，Asia/Shanghai）

- 已完成：固定安装/启动入口、版本目录、统一安装升级事务、本机就绪检查、失败回退及保守旧包清理。
- 已完成：仅助手正式发布；没有发布工作区 Web/API 半成品，没有远程安装现场电脑，没有生产业务写测试。
- 助手源码：`ae8827e24b201f27a31da0315f392a35225c9694`，先合入推送 main，再从该提交重新构建发布。
- 正式入口：`./deploy/publish-production.ps1 -Target assistant`，退出 0，50.203 秒，全部正式阶段通过。
- 发布标记：远端 `deployed/assistant` 已回读为 `ae8827e2`；发布日志提交 `865eeca0` 已推送。
- 安装程序：[Pms.DataSyncAssistant.Setup.exe](https://prsznh.cn/downloads/pms-data-sync-assistant/2.6.0/Pms.DataSyncAssistant.Setup.exe)。下载后双击，按 Windows 管理员权限提示安装，无须自选程序目录。
- 旧客户端兼容包：[Pms.DataSyncAssistant.V2.exe](https://prsznh.cn/downloads/pms-data-sync-assistant/2.6.0/Pms.DataSyncAssistant.V2.exe)。两个入口为相同二进制。
- 公网清单：[latest.json](https://prsznh.cn/downloads/pms-data-sync-assistant/latest.json)，版本 `2.6.0`、文件版本 `2.6.0.0`。
- SHA-256：`2a03e6a81c48d9fc4bd42b51b43301407f9e0650f806f0242a66cc140d422240`。

## 安装方式

- 程序固定在 x86 Program Files 的 `PMS\DataSyncAssistant`；桌面、开始菜单、登录托盘使用固定启动器。
- 版本程序放在 `releases/<version>`；成功就绪后原子提交活动版本。首次启动器字节保持不变，不拿其文件版本当当前已安装版本。
- 新版的前台更新、后台更新及兼容更新命令共用安装事务；通过新鲜健康时间、版本、活进程 PID 和程序路径验证才提交入口，不拿数据库/PMS/设备在线代替本机就绪。
- 更新失败恢复原服务路径和运行/停止状态；回退失败明确报警并保留恢复记录，下次安装先恢复未完成事务。
- 配置、DPAPI 密钥、业务快照继续保存在 ProgramData；仅清理验证通过且不被保护/使用的托管旧程序，以及超过 7 天的已知下载包。未知路径或进程检查不确定时保留。

## 证据（最新在前）

1. 10:54 公网复核：助手 `2.6.0/ae8827e2`；API `status=ok, db=up`，Web/API 版本及提交均未变，隔离测试服务残留数为 0。见[发布后身份](../../artifacts/release-checks/assistant-installation-ae8827e2/production-after.json)。
2. 10:52 正式发布通过：上传 SHA 校验、原子清单切换、回读清单版本/源码提交/安装入口，以及两个公网 EXE 的 SHA 和文件版本校验全部通过。见[正式阶段计时](../../artifacts/release-checks/publish-20261118-105201-2032-timings.json)及[发布日志](../../deploy/DEPLOY_LOG.md#L7597-L7601)。
3. 10:51 最终发布字节的真实 SCM 隔离测试：创建/启动、本机就绪失败注入、旧路径恢复、原停止状态恢复、重试通过；测试服务已删除。该服务是隔离探针，不是现场 PMS 服务。见[结果](../../artifacts/release-checks/assistant-installation-ae8827e2/assistant-scm-test.txt)和[版本/哈希](../../artifacts/release-checks/assistant-installation-ae8827e2/assistant-scm-test.json)。
4. 最终 Release x86 构建 0 错误；完整自检通过，覆盖安装锁、损坏包/路径、就绪/提交失败回退、恢复失败日志、重入恢复、旧包清理及配置/DPAPI 文件不变。见[自检日志](../../artifacts/release-checks/assistant-installation-ae8827e2/assistant-self-test.txt)。
5. 发布门禁回归 27/27 通过；其中故意制造非零退出和 PowerShell 错误的负向子用例显示 false 是预期结果，不是正式发布失败。
6. 10:50 发布前核对 DNS `124.223.179.214`、实例 `ins-2s08wnpd`、私网 `10.0.4.8`、目录 `/opt/pms-repair`、nginx active、PM2 pms-api online。见[身份](../../artifacts/release-checks/assistant-installation-ae8827e2/production-identity.txt)和[发布前版本](../../artifacts/release-checks/assistant-installation-ae8827e2/production-before.json)。未连接退役服务器。

## 线上版本对账

| 目标 | 版本 | 源码提交 | 本次变化 |
| --- | --- | --- | --- |
| 助手 | 2.6.0 | ae8827e24b201f27a31da0315f392a35225c9694 | 已发布安装/兼容更新包；不代表现场安装 |
| Web | 2.0.20261118-0905 | c92428071e112c0fc23b5def5293ad4d66276e06 | 未发布、未改变 |
| API | api-c924280 | c92428071e112c0fc23b5def5293ad4d66276e06 | 未发布、未改变 |

## 剩余风险与未验证项

- 安装包 Authenticode 状态为 NotSigned，可能触发 SmartScreen；没有声称已消除安全提示。
- 构建存在 MSB3644：缺 .NET 4 targeting pack，使用 GAC 引用。真实 Win7/.NET4-only 兼容性尚未验证。
- 现场没有远程安装或升级；真实数据库/PMS 联网、设备回执、刷卡均未验收。本机自检中的 iCCard 查询因缺 MDB 密码跳过，不能当现场业务通过。
- 更早分类型服务保留既有外部连接预检/健康延迟处理；健康延迟但新服务仍运行时保留旧服务注册供确认，不把这一分支冒称完整迁移验收。
- 本次为自安装 EXE，不是 MSI；现有“卸载后台服务”不等于完整产品卸载，不删除程序、快捷方式、HKLM 登录入口或配置。

## 验收清单对账

- [x] 安装与发布入口核对。
- [x] 固定入口、事务、回退、保守清理实现与回归。
- [x] 本机自检、真实 SCM 隔离测试、差异审查、合入并推送 main。
- [x] 助手专用正式发布、公网版本/源码/哈希/文件版本回读、标记与日志。
- [x] Web/API 未改变，其他工作区改动保留。
- [ ] 现场安装及硬件验收：不在本次远程操作授权范围，未执行。
