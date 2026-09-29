# 门禁卡全自动发卡调研与开发交接

> 最后更新：2026-09-29
> 用途：作为 PMS Web 门禁发卡功能后续开发的项目级记忆。
> 证据边界：数据库结构、文件、DLL 导出接口和网络连通性已做只读调查；尚未对实体 IC 卡、发卡器或现场门禁主板执行真实写入/上传。

> **需求变更（2026-09-28，后续开发以此为准）**：不再使用捷顺发卡软件或捷顺发卡 SDK 作为发卡主流程。实体卡由安装在任意办公 Windows 电脑上的 ACR122U 与“PMS 发卡助手”直接写入。`192.168.1.80` 只作为发卡完成后的旧数据库增量同步目标；枫桦景苑一期只写卡，枫桦景苑二期才执行 IC→WG、写入 MjSystem/iCCard 和控制器上传。页面与系统设计见 `docs/access-card-automation-design.md`。本文后续关于捷顺程序和 SDK 的内容只作为旧系统结构与数据库调研证据，不代表当前实现方案。

## 0. 2026-09-29 实现进度与新证据

- 已实现 Web 发卡页、一/二期路由、数量步进、额外楼栋、历史倒序列表、三状态轴和完整模拟流程。
- 已实现 Nest 任务编排、代理注册/心跳/租约/上报，以及 Windows x86 代理的 PC/SC 读卡器检测、DPAPI 凭据和 `.80` 只读历史查询。
- 页面选房后会生成 `.80` 只读查询任务；代理回传 Person NO、尾号、`IDNO`和 `IssueDate`，PMS 与本地新记录按 IC 去重合并。
- 已实库核对：页面 `228/5/301` 对应旧库 `228/05/301`。该房旧库存在 `/5`、`/6`、`/7`、`/8`，其中只有 `/7`、`/8` 有卡记录；因此新用户必须为 `/9`，不能用“已有卡数 + 1”得到 `/3` 或用“记录数 + 1”得到 `/5`。
- 新分配规则已固定为：精确匹配 `旧库房号/数字尾号`，在串行化事务内取 `max(匹配数量, 最大尾号) + 1`。
- `MC.CardInfo` 已核对 20 个字段与历史常量；但 `ICNO` 是卡内的另一个编号，不能从 UID/`IDNO` 稳定推导。在 ACR122U 实卡读出该字段并用旧软件反查前，`legacyDbWrite` 保持关闭，不冒险写真库。
- 2026-09-29 已在 `192.168.1.80` 的 D 盘实际运行 `PMS-LegacySync-0.1.1`：DPAPI 数据库密码安装成功，`--legacy-history 228/5/301` 返回人员尾号数 4、下一序号 9，并读出 `/7`、`/8` 的捷顺编号、IC 卡号与发卡时间；`/5`、`/6` 无卡记录。该验证为真库只读，未修改任何数据。
- 2026-09-29 已在 `192.168.1.88` 的 D 盘实际运行 `PMS-AccessGateway-0.1.2`：自检和 iCCard MDB 密码的 DPAPI 安装成功；`--access-probe` 只读打开真实 `MJDataBase.mdb` 与 `iCCard.mdb`。现场计数为 `Employee=3209`、`MJ_MacPower=10541`、`MJ_MacInfo=20`、`MJ_DoorInfo=20`、`t_b_Consumer=7300`、`t_b_IDCard=7431`、`t_d_Privilege=11768`，与前期调研一致；未写入 MDB，未上传控制器。
- 已构建代理更新包 `PMS-AccessCardAgent-Update-0.1.4.zip`：新增 `--install-agent <代理ID>`（同时写入 ID、用 DPAPI 保存密钥）和只发一次心跳、不领取任务的 `--connect-test`，并为旧版 .NET 4 显式启用 TLS 1.2；PMS 页面按 15 秒心跳有效期判定在线，避免电脑退出后永久显示在线。
- 2026-09-29 现场发现旧版 Windows PowerShell 不会将右键/`Ctrl+V` 粘贴作为逐键字符交给 `Console.ReadKey`，结果报“代理密钥为空”。已在 0.1.5 增加标准输入管道，现场统一使用 `Get-Clipboard | .\Pms.AccessCardAgent.exe --install-agent <代理ID>`；已实测长密钥可写入 DPAPI 文件，且不回显、不进入 PowerShell 历史。更新包为 `PMS-AccessCardAgent-Update-0.1.5.zip`。
- 2026-09-29 代理 0.1.6 改为 Windows 后台服务：开机自启、异常 60 秒自动重启，不依赖 PowerShell 窗口。同时增加当前用户的托盘状态图标，根据 Windows 服务状态和本地最近成功心跳区分“已连接 PMS / 服务运行但连接异常 / 服务已停止”。
- 用户随后明确要求做成可换电脑使用的 Windows 小应用，并命名为“PMS 数据同步助手”，为未来连接其他数据库保留扩展。0.2.0 已实现图形化配置：选择电脑用途、粘贴代理 ID/一次性密钥、保存与连接测试、一键安装 Windows 后台服务；托盘图标显示服务与 PMS 心跳状态。安装包不再预置某台电脑的 config，首次启动由界面生成。
- 2026-09-29 已将提交 `b8015bf` 的 API 与 Web 发布到 `https://prsznh.cn`，生产包分别为 `pms-api-20260929-0902.tar.gz`、`pms-web-20260929-0902.tar.gz`。生产数据库已创建 `access_card_agents`、`access_card_issue_batches`、`access_card_issue_items`、`access_card_legacy_snapshots` 四张表；健康检查为 `ok/db up`，无凭据代理心跳返回 401，`/access-cards` SPA 入口返回 200。下一步是在生产页面分别注册 `.80`、`.88`，把一次性凭据直接装到对应电脑后执行 `--connect-test`。

## 1. 最终业务目标

办公室人员在 PMS Web 中只需：

1. 选择房号。
2. 选择发卡数量（当前原型限制一次 1–6 张）。
3. 系统根据房号自动识别所属楼栋，默认勾选本楼栋，允许额外勾选其他楼栋。
4. 将已经捷顺加密授权并初始化的 M1 卡放到读写器上，点击发卡。
5. 系统自动完成：授权卡识别 → 写入固定卡镜像 → 回读校验 → 登记用户和 IC 卡号 → IC 转 WG 卡号 → 写入对应门禁系统 → 上传现场主板 → 显示逐步结果。

## 2. 已确认的业务规则

### 2.1 日期和权限

- 默认开始日期：`2000-01-01`。
- 默认结束日期：`2040-12-31`。
- IC 卡内的捷顺门禁权限：使用原系统设定的“全部权限”效果；最终方案为对已授权卡直接写入已提供的固定镜像。
- WG 门禁权限：默认授权房号所属楼栋，操作员可额外勾选其他楼栋。
- Web 显示的是“楼栋”；后端将楼栋展开成实际门、控制器、时段和系统记录。

### 2.2 卡片安全状态

捷顺原流程必须保留为独立的卡片准备阶段：

1. 全新空白 M1 卡。
2. 在捷顺系统中完成“加密授权”。
3. 在捷顺系统中完成“初始化”。
4. 只有这种已授权卡才允许进入 PMS Web 发卡阶段。

Web 发卡时必须先检查：

- 卡型是 MIFARE Classic 1K。
- 能使用捷顺系统密钥认证指定扇区。
- 扇区访问位正确。
- 捷顺格式标记和预期的静态结构一致。
- UID 未被重复发行；已登记或已发行卡默认不得覆盖。

任一检查失败时，不得执行任何写操作，统一向操作员提示：

> 非捷顺加密授权卡，存在安全风险，无法继续发卡。

实际日志需保留可定位的失败阶段（设备不存在、卡型不符、密钥认证失败、格式标记失败、已发行等），但不向前端泄露密钥。

## 3. 192.168.1.80：捷顺 JSOCTNet

### 3.1 程序和数据库

- 主程序：`C:\Program Files (x86)\G3\JSOCTNet\JSOCTNet.UI.WinForm.Main.exe`。
- 共享调查路径：`\\192.168.1.80\Program Files (x86)\G3\JSOCTNet`。
- 产品：JSOCTNet，文件版本 `4.2.0`，32 位 `.NET Framework 4.0`。
- SQL Server：`192.168.1.80`，数据库 `JS0131625`。
- 用户表：`HR.Person`。
- 发卡结果：`MC.CardInfo`，通过 `PersonID` 关联用户，已观察字段包括 `IDNO` 和 `IssueDate`。
- SQL 密码只能通过本机环境变量/安全配置注入，不得进入 Git。

### 3.2 原软件 SDK 已确认能力

管理 SDK 公开了：

- `PersonEdit`：新增/编辑人员。
- `GetPermissionGroups`：读取发卡方案（ID、名称、权限列表）。
- `CardIssue` / `CardEdit`：发卡/改写。
- `Lost` / `UnLost` / `Quit`：挂失/解挂/退卡。
- IC 门禁 DTO 包含 `PermissionGroupNO`、`StartDate`、`EndDate`、`StartHour`、`EndHour`。

底层 `JSIssuer.dll` 为 32 位原生库，已确认导出：

- `RFIDGetCardId`
- `LoadICKey`
- `CheckKey`
- `ReadCard` / `WriteCard`
- `ReadOneBlock` / `WriteOneBlock`

这证明捷顺原发卡器具备扇区认证和块读写能力，但还没有在独立进程中调用真实设备。

### 3.3 IC 转 WG26 规则

已从旧站复用并写入本地桥接器：

1. 清理 IC 卡号为大写十六进制。
2. 设 `hex` 为至少 6 位的卡号。
3. 设施码：`hex[4..5]` 转十进制，补足 3 位。
4. 卡内码：将 `hex[2..3] + hex[0..1]` 转十进制，补足 5 位。
5. WG26 卡号 = 3 位设施码 + 5 位卡内码。

现有桥接器已有 3 条自检用例，但上线前还需用历史真实卡号批量对照原系统。

## 4. IC 卡镜像和写卡边界

### 4.1 卡类型与镜像结论

用户已提供一张完整 MIFARE Classic 1K 已发行卡镜像（16 个扇区，每扇区 4 个块）及所需密钥。为避免泄密，本文档不记录密钥和完整块数据；实施时放入发卡电脑的 Windows DPAPI 加密配置，不发给浏览器、不记日志、不进 Git。

已确认：

- 0 扇区 0 块是制造商块，包含样卡 UID 和 BCC，正常 M1 卡不得也不需要写入。
- 新卡必须读取自己的 UID，并以该 UID 生成/记录 IC 卡号和 WG 卡号。
- 普通扇区保持 M1 出厂默认密钥；指定扇区使用捷顺系统密钥。
- 扇区尾块包含 Key A、访问位和 Key B；对已加密授权卡发卡时原则上不重写尾块，只写业务数据块。
- 必须逐块回读并字节比对；校验未通过时不得记为发卡成功。

### 4.2 待做的四阶段差异取证

正式开发写卡适配器前，用同一张可作废测试卡保留四份镜像：

1. 全新空白卡。
2. 捷顺“加密授权”后。
3. 捷顺“初始化”后。
4. 捷顺原软件“发行”后。

对比结果用来确认：

- 哪些块是加密授权标记。
- 哪些块是初始化格式。
- 哪些字段随 UID、日期或用户变化。
- “固定镜像”是否除制造商块外真的完全一致。

## 5. 读写器决策

### 5.1 已选定型号

后续开发按 `ACS ACR122U-A9` 作为通用 USB 读写器目标：

- USB CCID / PC/SC。
- ISO 14443 Type A，支持 MIFARE Classic 1K/4K。
- 支持加载密钥、块认证、16 字节读写和回读。
- Windows 10/11 一般可通过系统 CCID 驱动/Windows Update 识别；如现场不稳定，使用 ACS 官方 PC/SC 驱动。
- ACR122U 已停产且市场仿冒品多，先买 1 台可退货的正品做实机验收，不批量采购。
- 到货检查：背面 `Advanced Card Systems Ltd.`、`P/N: ACR122U-A9`、独立 S/N，以及 PC/SC 读取器名称类似 `ACS ACR122U PICC Interface`。

官方参考：

- [ACR122U 产品和驱动](https://www.acs.com.hk/en/products/3/acr122u/)
- [ACR122U API](https://www.acs.com.hk/download-manual/419/API-ACR122U-2.03.pdf)
- [Windows USB CCID 类驱动](https://learn.microsoft.com/en-us/windows-hardware/drivers/usbcon/supported-usb-classes)

### 5.2 发卡助手架构

不允许网页直接持有密钥或任意块写入能力。每台可连接读写器的 Windows 电脑安装本地发卡助手：

```text
PMS Web
  ↓ 仅发送房号、数量和经授权的发卡任务
https/wss://127.0.0.1 本地发卡助手
  ↓ Windows PC/SC
ACS ACR122U-A9
  ↓ MIFARE Classic 密钥认证、读块、写块、回读
已捷顺加密授权的 M1 卡
```

安全要求：

- 只监听 `127.0.0.1`，不在局域网开放通用写卡端口。
- 仅允许 PMS 管理站点来源，发卡任务带服务端签名、过期时间和唯一 nonce。
- 密钥由 Windows DPAPI 保护，不从浏览器下发。
- API 不接受前端提供的任意扇区、块号、密钥或块数据；写入模板由本地受保护配置固定。
- 操作日志记录用户、房号、UID/WG、阶段、结果和错误编号，不记密钥和卡内完整数据。

## 6. 192.168.1.88：MjSystem

### 6.1 实际运行库

- 程序目录：`\\192.168.1.88\c\Program Files (x86)\MjSystem`。
- 程序目录中的 2014 年 MDB 是模板，不是当前运行库。
- 当前运行库来自 UAC VirtualStore：
  `\\192.168.1.88\c\Users\Port1\AppData\Local\VirtualStore\Program Files (x86)\MjSystem\Database\ChineseSimple\MJDataBase.mdb`
- 调研时同目录存在 `.ldb`，说明原软件正在使用该库。正式写入必须备份、避免与原软件并发修改，并验证 Access 锁。

### 6.2 主要表及关系

- `Employee(vEmp_id, vEmp_name, vCardNo, vDepart, vDoorPassword, dBeginDate, dEndDate, ..., EId, ...)`
- `MJ_MacPower(cCardNo, cDoorId, cTimeId)`
- `MJ_MacInfo(cMacId, cMacSn, vConnType, vIP, vCom, ..., vExposition)`
- `MJ_DoorInfo(cMacId, cDoorId, vDoorName, ...)`

关系：

- WG 卡号直接写在 `Employee.vCardNo`。
- 权限直接按卡号关联：`MJ_MacPower.cCardNo = Employee.vCardNo`。
- 这套系统不是通过独立卡表 ID 关联用户。

调研快照：

- Employee：3,209。
- MJ_MacPower：10,541。
- 控制器/门：20/20。
- `Employee.vCardNo` 均为 8 位，Employee 中未发现重复。
- 816 条权限已无对应 Employee。
- 128 条权限引用未知/旧门记录。
- 未发现重复 `(cCardNo, cDoorId)`。

### 6.3 楼栋和通信

MjSystem 负责：

`01、02、03、05、06、07、08、09、10、18、19、20、21、22、23、25、26、32、36`，另有“监控中心门禁”。

- 19 个楼栋控制器通过 COM1/RS232/485。
- 监控中心门禁通过 TCP/IP `192.168.1.87:60000`。
- 目录存在 `ECardDerviceSDKMJ.dll`，上传接入有技术基础，但尚未发送真实上传命令。

### 6.4 权限映射的重要限制

历史数据表明，一个“楼栋权限”有时需展开成多个实体门，不能简单地每楼栋只插入一条 `MJ_MacPower`。调研出的常见组合包括：

- 01→01+09，02→02+09，03→03+09，05→05+09，06→06+09，07→07+09，08→08+09。
- 09→09。
- 18→09+18，19→09+19，21→09+21，22→09+22，23→09+23，32→09+32。
- 20→09+20+26，25→09+20+25，26→09+20+26。
- 10 号和 36 号存在旧/异常数据，不能直接以历史众数作为最终规则。

实施时优先顺序：

1. 完全复制同房号当前有效卡的权限集合。
2. 无同房有效卡时，使用经人工确认的“逻辑楼栋 → 实体门”配置。
3. 两者均无时停止自动发卡并提示管理员，不可猜测。

## 7. 192.168.1.88：iCCard

### 7.1 实际运行库

- 程序目录：`\\192.168.1.88\c\Program Files (x86)\iCCard`。
- 当前运行目录：`\\192.168.1.88\c\Users\Port1\AppData\Local\VirtualStore\Program Files (x86)\iCCard`。
- 当前数据库：上述目录的 `iCCard.mdb`。
- MDB 密码已由用户提供并用于只读调研，不得写入本文档、Git 或前端。

### 7.2 主要表及正确关系

- `t_b_Consumer.f_ConsumerID`：用户主键。
- `t_b_Consumer.f_ConsumerNO`：用户编号，**不是卡号**。
- `t_b_IDCard.f_CardID`：卡记录主键。
- `t_b_IDCard.f_CardNO`：真实 WG 卡号。
- `t_b_IDCard.f_ConsumerID`：卡与用户的关联。
- `t_d_Privilege.f_ConsumerID`：权限所属用户。
- `t_d_Privilege.f_DoorID`：实体门。

正确写入顺序：

1. 新增 `t_b_Consumer`，取回 `f_ConsumerID`。
2. 新增 `t_b_IDCard`，`f_CardNO = WG`，关联相同 `f_ConsumerID`，卡状态为正常。
3. 按用户 ID 新增 `t_d_Privilege`。
4. 上传控制器并核验设备回应。

调研快照：

- Consumer：7,300。
- IDCard：7,431。
- Privilege：11,768。
- 控制器：23。
- 门记录：40。
- 410 条卡记录引用已不存在用户。
- 280 个用户无卡。
- 96 条孤立权限。
- 卡号字段无唯一索引；当前用户关联卡中仍有 347 组重复卡号。自动发卡必须在应用层严格防重，不能信任 MDB 约束。

### 7.3 楼栋、网络控制器和权限组合

iCCard 负责：

`04、11、12、13、15、16、17、31、33、35、37、40、41、42、45、46、47、48、49、50、51、52、53`。

与 MjSystem 的楼栋列表无重叠，可按楼栋自动路由到对应系统。

网络控制器均使用端口 `60000`：

- 45→`192.168.1.151`，13→`.152`，17→`.153`，11→`.154`。
- 46→`.156`，47→`.157`，41→`.158`，33→`.159`。
- 37→`.160`，12→`.161`，16→`.162`，04→`.163`。
- 15→`.164`，35→`.165`，40→`.166`，42→`.167`，31→`.168`。

调研时 35（`.165`）和 40（`.166`）不可达，上线前需现场复测。48–53 号较旧控制器主要通过 192.168.1.88 本机 COM1。

不能忽略的多门权限：

- 45 号：`45号大门` + 历史 `45号大门600001`。
- 51 号：`51号大门` + 3 号地下车库出/入口 + 10 号地下车库出/入口。
- 53 号：`53号大门` + `53-1号门600006` + `53-2号门600006`。

程序目录有 `iCCard-WGComm.dll`，且原 EXE 包含上传方法；尚未对真实控制器执行写卡上传。

## 8. 当前代码原型现状

目录：`tools/access-card-bridge`。

已实现：

- 本机桥接服务默认监听 `127.0.0.1:17880`。
- 连通性检查 `192.168.1.80` SQL Server。
- 使用参数化 SQL 和串行化事务向 `HR.Person` 新增用户。
- 以房号生成 `房号/序号` 用户名，避免重用已占用序号。
- 按本次 Person ID 轮询 `MC.CardInfo`。
- IC 转 WG26 及自检。
- CORS/PNA 限制和 `observe` / `active` 模式；默认 `observe` 不写库。
- PMS 管理端已有“收费业务 → 门禁发卡”页面、房号/数量表单和进度显示。

尚未实现/验收：

- ACR122U-A9 PC/SC 设备适配器。
- 已授权卡识别、固定镜像写入和回读。
- 直接将卡号和用户关系登记到 JSOCTNet，避免依赖原软件人工发卡后再轮询。
- MjSystem / iCCard 真实 MDB 写入适配器。
- MjSystem / iCCard 现场主板上传适配器。
- 同房有效卡模板与人工维护楼栋映射的后端配置。

## 9. 建议的任务状态机

```text
created
  → person_created
  → waiting_for_card
  → reader_detected
  → card_uid_read
  → authorization_verified
  → card_written
  → card_readback_verified
  → jieshun_recorded
  → wg_converted
  → access_db_written
  → controller_uploaded
  → completed
```

任何阶段失败必须保留前面已成功的证据和可重试位置，不可整流程从头盲目重做。特别是物理卡已写成功、但 MDB 或主板上传失败时，必须标记为“待续传”，不能再次写卡。

## 10. 开发和实机验收顺序

1. 到货验证 ACR122U-A9 真伪、PC/SC 名称、驱动和固件。
2. 只读验证：已授权卡通过，空白/错密钥卡被拒绝，全程不写卡。
3. 获取四阶段卡镜像并完成差异报告。
4. 用一张可作废卡完成单块写入/回读、断电/拿走卡片异常测试。
5. 完成固定镜像写入，用捷顺原软件反向读取确认卡被正确识别。
6. 完成 JSOCTNet 人员/卡关系登记，验证原软件中可查。
7. 对 MjSystem 和 iCCard 分别备份真实 MDB，先对备份库执行完整事务和数据质量断言。
8. 选一扇测试门执行主板上传，在设备端确认真实权限。
9. 分别测试单楼栋、额外勾选多楼栋、多实体门楼栋、重复卡、中途拿卡、MDB 锁、控制器离线和续传。
10. 保留 `observe` 模式为默认；只在实机证据齐全后逐段开启 `cardWriter`、`accessDatabase`、`controllerUpload`。

## 11. 严禁事项

- 禁止在浏览器代码、API 返回值、日志、截图、Markdown 或 Git 中记录写卡密钥、MDB 密码或 SQL 密码。
- 禁止写入 M1 `0 扇区 0 块`。
- 禁止对未通过捷顺授权验证的卡进行“顺便加密”或初始化。
- 禁止在未备份、未验证真实路径时直接修改 192.168.1.88 的 MDB。
- 禁止将“数据库已写入”当作“现场主板已上传”。
- 禁止仅凭 SDK/DLL 存在就宣布实体写卡或主板上传已验收。
