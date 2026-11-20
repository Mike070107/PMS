# 新车登记实际入口修复 / 全部遗漏继续验收（2026-11-17 Asia/Shanghai）
## 目标与授权
- 用户要求补遗漏逐项验收自动上线；最新允许连续任务最后统一发布。整体未完成，不得标goal complete。
- 工作区D:/00项目开发/PMS-release-simplification-20261117，main；只用生产124.223.179.214，禁止旧机1.15.172.131。
## 最新结果（新到旧）
- 用户截图证实Vehicles→新车登记仍是QR-only；之前只完成NewPlateCard，不能称此入口已交付。暂停标准绑定补缺，优先修截图入口。
- task109：Vehicles弹窗已嵌入原Cashier稳定intakeId流程，直接展开工作人员代填；扫码/本地/无附件、授权编号、原CarRenewal/收款同页；亲情保留资料审核。
- Cashier嵌入模式隐藏项目切换/跳登记页/换户；ParkingTab把登记变更回传Cashier防止转类/撤销状态陈旧；收款处理中禁止关闭/再登记。
- 最终job pwsh-804c8b21e7ed4574已收exit0：12/12浏览器（含收款期间Esc/再登记锁/完成不跳页），tsc、Vite4238模块通过。前次新增断言未等React绘制导致2失败，改为等待DOM提交后重跑全绿。
- 当前修复未提交、未上线；最终diff已审一轮。不可拿模拟收款当真实支付/设备开通。截图outputs/vehicle-intake-navigation-20261111/（历史目录名，本轮重跑）。
- task108标准停车绑定UI暂停：API-client+access/ParkingQueryRoutes.tsx+IntegrationRegistration+integrations-browser tests已写，只有tsc/build间接通过，功能测试尚未跑；禁止未验就发布。
## 既有生产状态
- 上次正式Web2.0.20261117-2213、API api-9cb93f1；部署源码9cb93f1da1eed4cbb030e858ba7e46f6730e4821；助手2.5.54/d075f81d，现场升级未验。
- Web源hash c5321e589712eaba990c298037e8b4a88ba402004b48f568de162822e4755296；API源hash2f60a8e72eeb4d81166e18d11fd4b579f3a77a189e9e5239050d344001b58880。
- 22:22公网Chrome扫码登录页200/pageErrors0，仅匿名冒烟；不证明认证业务。证据outputs/release-all-20261117-2134/verification.md。
## 未完成与下一步
- 收最终job；失败修复。保存task109证据并精准提交已验文件，其他未验/历史dirty不混入；等待统一发布，不逐小项上线。
- task108跑node --test test/integrations-browser.test.cjs，查withPage helper新测试参数是否匹配；修复后真实Devices组件桌面/窄屏、错误/未知结果/权限/刷新回读验收。
- task58仍有标准门禁/控制器/停车写操作与厂商适配等实现遗漏；task107全端发布未完成；task101/102认证业务、实卡/.80现场未验。
- 两端小程序开发版1.0.20261117a/4912774f已上传≠体验/正式。公众平台无token，体验保存刷新回读未完成；不重复无改源码上传。
- 不再重复无效查登录；已有CDP9222/PMS login、9223公众平台无token。不存在“都已完成”的证据。
## 关键验证与文件
- 本轮源码：apps/neighbor-web/src/pages/{Vehicles,Cashier}.tsx，components/cashier/{ParkingTab,NewPlateCard}.tsx。
- 测试：apps/neighbor-web/test/vehicle-intake-navigation-browser.test.cjs；vehicle-staff-registration-browser.test.cjs；pnpm run build。
- 原遗漏审计：outputs/omission-release-20261117/delivery-audit-after-upload.md；之前子组件coverage不证明Vehicles入口。
- 保留历史dirty artifacts/release-checks/api-{expected,source,verified}.json、outputs/image-preview-unification-20261117/coverage.md，已有SHA备份，不能覆盖或冒充新证据。
- 正式发布：main推送后./deploy/publish-production.ps1 -Target auto；核身DNS/机器/服务、公网版本hash、deployed标记；不得上传工作区半成品。
- SSH ubuntu@124.223.179.214 -i ~/.ssh/pms_repair_key.pem；VM-4-8-ubuntu/machine-id005acd736e534836bddf1997a7cc0636；/opt/pms-repair/apps/api/pm2 pms-api。

## 2026-11-19 地址选择与框架版本显示

- 范围为修复收银等正式入口共用的地址选择器，并在主页左侧导航底部显示 Web 版本。授权为开发与本地验证。实现位于 main 工作目录 D:/00项目开发/PMS-vehicle-release-20261119。
- 楼栋显示省略与小区同名的道路前缀，保留其他道路；三列按可用空间缩放，室号和业主名换行，室号列保留滚动条空间。Chromium 使用隔离的 50 户数据，在 1024/640/375/320px 均能滚动到末户并点选。
- 左下角版本复用页面运行版本。Web 发布脚本按本次发布北京时间生成 2.0.yyyyMMdd-HHmmss，制品核验完整版本。实际 Shell 在 1440/1024/390/320px 核验文字和位置；手机通过导航菜单查看。
- 本地证据：address-picker-browser.test.cjs 6/6，address-picker-shared + apartment-address-picker 19/19，共享地址一致性及房产地址 4/4，erp-browser.test.cjs 1/1（截图 D:/pms-erp-browser-evidence），release-check + neighbor-production + release-cache 27/27。命令均为 node --test，TS 地址测试从 apps/api 加载 ts-node/register。
- Web 构建 pnpm --filter @pms/neighbor-web build 的 tsc 通过，Vite 转换 4247 个模块后，esbuild 在渲染分块阶段删除临时文件收到 Access is denied；独立临时目录定向重试仍失败。日志 D:/00项目开发/pms-build-tmp-824718d52d57489eb60c49b61f85ff56/build.log。未生成经验证的正式制品，待正常构建环境复核。无生产操作、无现场手机验收；Web/API/助手/小程序没有发布新版本。

- 续办：用户已明确授权将地址选择器、左下角版本号一起部署生产 Web，核对线上版本及手机宽度点选室号。生产基线为 2.0.20261119-1001 / 2ee1a9a6，DNS、实例、私网、部署目录和 nginx 已核对。Windows 构建修复改用锁定 esbuild 的管道传入大块源码；生产不需要安装此构建工具。等待正式制品、发布和窄屏核验。

## 2026-11-19 10:44 地址选择器与框架版本号生产 Web 发布
- 已按用户当次授权发布 Web：main bbde3167759163f79798b342e72ac7fddd3ada62；线上版本 2.0.20261119-103949。deployed/web 已远端回读。已比对公网 release.json、首页 HTML、入口 JS 与 CSS 的版本及哈希。API api-78988f8，助手更新清单 2.6.0；均未发布，小程序未发布。
- 构建修复为 esbuild@0.21.3 锁定补丁，Windows 大输入用进程管道。2MB 转换、pnpm --filter @pms/neighbor-web build、正式构建与发布检查通过。
- 生产切换前版本 2.0.20261119-1001 / 2ee1a9a6；已核实服务器 /opt/pms-repair/web.bak.1795056255/release.json 为该版本。需要回退时复核当前版本、保留现版，只切换 Web 静态目录到该备份并复核公网哈希。
- 证据根 D:/00项目开发/PMS-vehicle-release-20261119/outputs/address-release-20261119：publish.log、live-verification.json、mobile-width.log。10:44 从公网取得正式 CSS 并比对 SHA256，配合同源码地址组件和隔离数据执行 node --test apps/neighbor-web/test/address-picker-browser.test.cjs，6/6；320、375px 可完整换行、滚动到第50户、点选并回显150。现场浏览器控制因无法可靠识别当前网址而停止，线上已登录收银页面的实际点选待验。
- 发布耗时 286.7 秒，其中源码及回归 256.7 秒、制品上传 1.29 秒；上一轮 240.8 秒中对应 214.3 秒、1.1 秒。未改生产网络。计时文件 artifacts/release-checks/publish-20261119-104432-45744-timings.json。
## 2026-11-19 公寓 XP-80C 连续卷纸
- 用户授权修复、发布 Web，并验证收费后打印、历史补打、超长和重复拦截。生产基线 bbde3167；历史样式隐藏背景仍参与分页，已在 80mm 宽复现五页。对生产只取制品和版本，收费/补打日志写入用隔离业务数据验证。实机出纸另记。

## 公寓连续卷纸已发布（2026-11-19 10:58）
- Web 2.0.20261119-105531，源码 055dd865，已核对公网 release.json、入口及 deployed/web 标签。生产范围仅 Web；API、助手及小程序本轮没有发布。
- 收费成功预览与历史补打使用独立票面文档，按实测内容高度定义 80mm 纸张。浏览器打印对话框关闭前加锁，同凭证 15 秒内禁止重复，超过 40 项、4000 字符或 500mm 拦截。异常不自动重试。
- 上线后 PMS_VERIFY_RECEIPT_RELEASE=1 node --test apps/neighbor-web/test/apartment-receipt-print.test.cjs 通过。公网 16 个静态资源与本地制品逐字节一致；隔离收费数据运行正式 /apartment 路由。收费一页 80.1×82.9mm；历史补打一页 80.1×126.0mm；票尾余量均小于 2mm。重复和超长测试通过。现场 XP-80C 未连接到本机，驱动送纸、实际裁切未验。证据在 D:/00项目开发/PMS-vehicle-release-20261119/outputs/apartment-roll-20261119。
- 回退仅针对 Web 静态资源，核对 /opt/pms-repair/web.bak.1795057121 的 release.json 为 2.0.20261119-103949 后恢复该备份并复核公网哈希。

## 2026-11-19 新车登记交互重设计（本地完成）
- 授权为重新设计页面。实际修改车辆管理的新车登记弹层、嵌入登记的收银布局和共用登记卡；登记住户摘要、工作人员/住户扫码切换、车牌键入或点选、逐字段错误及选填附件。亲情车隐藏收款，付费登记生成可收款清单时显示收款区。
- Web 构建 pnpm --filter @pms/neighbor-web build 通过；vehicle-intake-navigation-browser 和 vehicle-staff-registration-browser 共 17/17。隔离业务数据，1440、390、375px 浏览器覆盖登记、扫码、审核、撤销和收费保护。证据 D:/00项目开发/PMS-vehicle-release-20261119/outputs/vehicle-registration-design-20261119。未发布，未写生产业务数据。

## 2026-11-19 新车登记第二版 · 停车证样式
- 范围为 Web 新车登记。住户摘要采用停车证式票头，车牌和联系资料在桌面并排、手机单列，保留扫码、授权及按需收费流程。仅本地改版。
- 当前验证记录目录为 outputs/vehicle-design-permit-20261119；1440px 和 390px 使用浏览器隔离业务数据。验收结果见后续记录。
- 验收通过：pnpm --filter @pms/neighbor-web build（Vite 31.09 秒）；node --test 运行 vehicle-intake-navigation-browser 与 vehicle-staff-registration-browser 共 17/17。证据为上述目录 build.log、browser-final.log 和停车证桌面/手机实页截图。未部署。

## 2026-11-19 新车登记与收银台新增车牌统一主题（本地完成）
- 两个入口共用 PMS 主题变量、住户票头及登记表单；收银台支持直接录入或扫码续办。浏览器使用隔离数据核对手机、桌面、扫码和重复办理。pnpm --filter @pms/neighbor-web build 及三个登记浏览器套件通过，日志与截图在 D:/00项目开发/PMS-vehicle-release-20261119/outputs/vehicle-registration-theme。无生产发布。

## 2026-11-19 车辆登记蓝灰主题已发布生产
- 本次仅部署 Web。域名 prsznh.cn 解析 124.223.179.214，VM-4-8-ubuntu / 10.0.4.8，nginx 静态目录 /opt/pms-repair/web。公网版本 2.0.20261119-145128，源码 d0c2c7ca，远端 deployed/web 已核对。
- 发布回归修正旧提示文字断言，继续验证业主只读和无业务写入。线上两入口验收使用公网制品、隔离业务数据；车辆管理 1440px，收银台 390px，主题、车牌输入及切换扫码均通过。与构建逐字节核对 30 个文件。证据 outputs/vehicle-registration-theme/production-final.log、online-verification.log、online-vehicles.png、online-cashier.png。
- 回退时仅恢复 Web 静态资源，备份 /opt/pms-repair/web.bak.1795071364 已核实为 2.0.20261119-135242 / c3bbeb20。API api-78988f8，助手更新清单 2.6.0。本次未发布 API、助手或小程序，未提交真实登记或收费。

## 2026-11-19 车辆类别单选与授权期限（本地验收）
- 车辆管理和收银台共用原生 radio，每类单独一行、跨行只选一种。住户车1/2/3 同行，旧收费分组“产权车位”显示为“产权车”，锁定只显示结果。
- 亲情车默认 12 个整月，可选快捷月数、手输 1～60 个月或自定义日期。工作人员提交的期限随登记原子保存；已关联亲情车从办理详情核对及按原权限修改。付费新车在类别与授权期限内按原收费规则试算。
- 本地 pnpm --filter @pms/neighbor-web build、API tsc --noEmit 通过；18 项浏览器回归、27 项服务及 SQL 测试通过，含 375px 同行、跨行单选，以及自定义五个月保存和重读。证据 outputs/vehicle-class-term。未部署。

## 2026-11-19 单一车牌号码输入（本地完成）
- 车辆管理与收银台使用同一个蓝色牌照样式输入框。支持中文输入法、键盘输入/粘贴、展开字符键选填和替换选区，展开区去掉重复号码。
- Web 构建和三个浏览器回归套件通过。1440px、390px、375px 覆盖输入、退位、7/8 位和业务入口；展开时检查面板边界。证据 outputs/single-plate/build.log、browser-final.log 及单一车牌桌面/手机截图。未部署。
## 2026-11-19 新车登记资料、收费与审批

- 本次授权为开发及隔离验收，范围为车辆管理、收银台、扫码填写页和登记/收款 API。
- 办公室录入与扫码录入互斥。付费车资料审核后设置车类、车库与期限；亲情车核对资料后选择车库与期限并提交经理。回家补交保留同一车牌、登记和流水，二维码有效一小时。办公室收到补交待办，标准金额通过资料审核后进入停车队列；手填金额还须经理审核。
- 在 PMS-vehicle-release-20261119 完成 pnpm --filter neighbor-web build、API pnpm typecheck、pnpm test:vehicle-intake（61/61）和 node --test test/vehicle-intake-browser.test.cjs。390px、1440px Chrome 隔离回归通过；390px 验证回家登记、三个月试算和手机提交附件。证据为该工作区 outputs/vehicle-intake-workflow/。
- 当前交付为本地源码与隔离验收。生产 Web/API 未部署，未进行真实收费、真实停车库写入或道闸设备核验。

## 今日工作 · 分项收入（2026-11-20，开发验证，待临停数据源）

- 授权范围为 Web/API 开发、只读对账。本项未部署，生产现行 Web/API/助手与小程序版本不因本项变更。
- 六项固定展示。MIS 当日未退正金额按 01 物业、04 泊位、14 车辆管理；PMS 单独办理的停车月租凭交易快照区分产权车，逐笔计费；不叠加另行写回 MIS 的 mis_property/mis_berth 流水。门禁卡取已收费办理记录；维修取完工登记收费（作废和软删除排除）。MIS 历史镜像未保存时间和备注的行保留空缺，新增字段需先执行迁移 1796800000000。
- 11 月 20 日 PMS 的 MIS 镜像只读核对：01 为 34,746 元/168 条，04 为 11,100 元/72 条，14 为 1,620 元/24 条；02 租金 8,190 元排除。同日查询时 PMS business_transactions 为 0 条。这是当时镜像快照，非全天封账。
- 临停未接通。现场报表显示二期临时现金 230 元、非现金 0 元、全部现金 590 元。现有助手只查出场应收，当前机器已安装助手的登记连接为 0，旧库的只读报表定义/实收字段待核验。另见 docs/parking-management-implementation.md。待打通后分别核对一期二期、同窗逐笔合计及权限范围。
- Web 构建、API 类型检查通过。API 的 today-income、mis-mirror、bill-mirror 21 项回归通过；node --test test/today-income-browser.test.cjs 在 Chrome 1440/923/390 宽度验证逐项金额边界、五栏明细和翻页，数据为合成。未做生产部署或现场操作。


## 收银台待收费列表、车位管理费与捷顺发卡历史（2026-11-20）

- 本次限 Web。待缴项横排展示项目、账期、备注和金额；窄栏换行，空备注收起。MIS 14 停车管理费独立为「车位管理费」，待缴、历史和收款篮按同一分类筛选，仍以原单 ID 办理。
- 收银台与门禁发卡共用本户捷顺卡清单、分页及操作抽屉，按小区、弄、楼、室请求现有现场助手接口。未触发真实收款、发卡或门禁授权。
- pnpm build 通过；node --test test/business-owner-contact-browser.test.cjs test/mis-remarks.test.cjs test/cashier-household-isolation.test.cjs 共 9 项通过。access-status-browser.test.cjs 的发卡历史翻页用例通过。Chrome 合成验收覆盖 1440 和 390 宽、分项选择和本户卡清单；截图位于 outputs/business-owner-entry-implemented/cashier-garage-desktop.png 和 cashier-card-mobile.png。未部署生产，未核对真实住户现场回传。


## 今日工作临时停车应收（2026-11-20，开发验证，待现场核对）

用户已确认改按出场应收，替代前项中的临停实收要求。Web 单列应收、明细加车类；API 复用原全公司停车报表授权和查询队列；助手 2.6.3 读取两期当日出场正金额，按历史车类纳入临时车、亲情车，汇总与明细使用同一批数据。按账号授权和助手版本检查，缺库、纯车型编码及现场字段歧义不以零回传。
验证命令为 Web pnpm build、API pnpm exec tsc --noEmit、parking-fee-report 和 parking-query.util 两套接口回归（23 项）、today-income-browser.test.cjs（1440/923/390 宽）及 2.6.3 Release 构建和 --self-test。自检不连接真实岗亭。未部署生产或升级现场设备；旧库字段是否包含可识别的历史车型、两期同日总额与现场收费记录尚待核对。


## 共用车牌输入框八位绿牌（2026-11-20）

点选和键盘原先都可输入八位，但牌面固定蓝底白字。现由共用 PlateNumberField 的已提交车牌值决定配色，八位渐变绿底深色字，退至七位或清空回蓝。Chrome 1440 与 375 像素宽用 node --test test/plate-number-color-browser.test.cjs 先复现回填八位仍是蓝牌，再通过回填、点选、键入、退位、清空与八位不裁切回归。本次仅 Web 源码，未发布生产。


## 2026-11-20 21:17 四项生产发布

用户确认一并部署 Web、API、迁移及共用助手。目标公网 prsznh.cn（124.223.179.214）、VM-4-8-ubuntu、/opt/pms-repair。迁移 IncomeReceiptFields1796800000000 在事务内仅添加两个可空列并登记版本，已回读；API 环境文件切换前后 SHA-256 相同。物业费 34,746 元、泊位费 11,100 元、停车管理费 1,620 元的当日镜像金额与发布前一致。
生产 Web 2.0.20261120-211133（cc763465），API api-9495bd5（9495bd5f），共用助手包 2.6.3（cc763465，SHA256 b24f78af2d5bd999d271b0ab298241c296276aefd495da8f493f8e5cdb6c4d6e）。Web 首次测试分配到 Chrome 禁用的本地端口 3659，按原流程重跑通过。公网入口、绿牌 JS/CSS、收银台和今日工作分包逐个比对哈希一致。证据为 artifacts/release-checks/publish-20261120-211630-5784-timings.json 及各端 verified JSON。小程序未发布。
21:16:57 生产最近三分钟内门禁、捷顺和停车网关心跳均为 2.6.2，未有新版 exit_due 查询回执。需等现场自动升级或从原客户端检查更新后刷新今日工作。现场明细、真实捷顺清单和登录态绿牌交互未实测；桌面控制因当前 Chrome 网址无法可靠识别而停止。回退依据为 /opt/pms-repair/web.bak.1795180452、前 API 4d19157c 的确定源码/发布记录和共用助手 2.6.2 历史包。代码回退可保留新增可空字段，避免影响发布后数据。


## 收银台车辆操作、查询反馈与换牌历史（2026-11-20，Web 本地验收）

- 车辆管理回车提交立即收起候选，保留关键词。车辆查询与收银台综合查询使用翻书 GIF，空结果等待当前请求成功返回。
- 收银台停车缴费选车后可展开该车的车辆管理，复用六个原抽屉。变更完成清理购物车及旧车型，重新读取本户车辆。
- 同一分钟、同库、同源车辆编号、相同旧新牌的历史归组，显示原车牌、新车牌和记录时间，原始来源可展开。无充分标识单列。
- 已通过 Web 的 pnpm build；node --test test/address-picker-browser.test.cjs test/unisearch-display.test.cjs test/parking-browser.test.cjs test/parking-household-isolation-browser.test.cjs。Chrome 用合成数据核对回车收起、慢查询 GIF 与空态、1440/375 宽停车缴费六个抽屉、跨户隔离和历史分组。未部署本批 Web，无真实收费、换牌或设备写入。
- 临停应收另项排查：用户已更新助手。现有生产 Web、API、共用包及口径见上次发布记录。当前未取得现场成功回执或具体失败原因，金额尚未核对。诊断 SSH 普通用户无 Docker 访问权限。已请求正式页面错误提示。


## 临停分期应收与现场车类映射（2026-11-20）

用户回报助手已升级，实际错误为 parking1 出场记录缺少历史车类字段；要求首页两期应收合计，点开先分期，再按所选期查看明细。本次为开发和只读核对，无生产发布授权。
核对 2026-09-30 两期 SQL 备份元数据和车类字典：Car_Out.Car_Lei 为数值编码，P_lei(l_id,l_name) 有 0 临时车、1 月租车；旧登记还有 Car_Issue.Car_Brand，Up_Issue 保存旧新牌、旧新身份与变更时间。助手 2.6.4 增加数值车类、月租细分身份按出场时点核对。上线前无法用备份确定今天分期实际金额。现场 SQL 的 Windows 集成登录被拒，未变更凭据或数据。
Web 每期单独请求、分页，只在两期齐全时显示合计，单期失败保留另一期金额与明细。API 按任务库校验回执；分期查询要求助手 2.6.4。验证使用隔离浏览器、API 分期回归与助手自检；生产和真实出场逐笔对账待验。
新增待办：调整为地库授权时同步产权车收费类别。新反馈提到旧车库类型改产权车，此前确认 PMS 产权车、旧库住户车，已询问旧库写入目标。待决定后实施和验证，不调整现有生产收费。


## 地库授权与产权车收费（2026-11-20）

用户确认地库（大车库或人防）授权后 PMS 自动使用既有产权车收费档位，所选旧停车库办住户车。Web 两个入口复用同一抽屉，办前检查可用收费规则，授权回执成功后按库核对车牌、记录号、房号，沿用保护原值的车型任务，最后一个成功回执落 PMS 收费档位。完成前重查旧库身份与 PMS 档位，失败可区分已办理的授权与未确认的收费档位。仅地面授权不调整收费档位。
验收范围为 Web 构建及 garage-selection-browser.test.cjs 隔离浏览器；未执行生产授权、收费或现场写入。192.168.6.3:1433 从本机 TCP 可达，当前 Windows 集成身份不受该 SQL Server 信任；两期结构依据本地备份核实，当天旧库金额与 PMS 合计的现场对账尚待上线验证。


## 金额输入与新车登记收款入口（2026-11-20）
Web 金额控件隐藏步进并关闭滚轮改值；Chrome 合成原生与 Ant 输入框聚焦滚动后均保留 750.50。新车登记试算前显示禁用的收费并办理入口，自定义日期已填金额时单独提示补原因。本批未部署或执行真实收款。


## 新车登记主动提交校验（2026-11-20）
收费并办理在无有效应收时可点击校验。展开缺项所在折叠区，定位首个错误；自定日期的金额、原因、期限及车库选择就近展示错误。资料、试算与正式收费守卫沿用。Chrome parking-browser.test.cjs 核实点击后焦点与必填提示，garage-selection-browser.test.cjs 回归通过。本批未发布生产，未实际收款。

## 车辆管理续期收费抽屉 · 自定义截止日
- 已实现日期提前、当日和延后；人工确认实收，旧库将目标日期传给 Palte_extend，人防按选定目标同步并回读。
- 已验证 Web build、API tsc、德立云隔离测试 28 项及 Chrome 320/390/1440 宽回归；未部署生产，现场收费与设备未验证。

## 新办车牌下载超时后的重试核对
- 已修正 API 重试复用失败回执及助手误用 P_Download。确认依据见本机 D:/PMS-Parking-Analyze.json 中 Add_DownloadCard；通道成功写 Car_Download.Car_Zt=0，全部确认后发行表 Car_Zt=0。人工重试按原任务车辆主键、车牌、有效期、授权和旧库汇总状态只读核对。
- API tsc 与 paid-registration.test.ts 17 项通过；助手 Release 编译和 --self-test 退出 0。当前 Windows 身份不能登录现场 SQL，未读取该笔通道实时值，未发布或修改生产流水。


## 2026-11-20 22:55 生产核对及商铺停车开发验证
- 已授权整批发布。Web 2.0.20261120-224833 / 3f38e04b，API api-100f5d8 / 100f5d8e，助手共用清单 2.6.4。已读生产 release.json、API health 和更新清单，数据库 up，API 配置指纹与发布前一致。设备页枫桦停车网关仍报 2.6.3。原停车任务未人工重发。耗时约371秒，见 artifacts/release-checks/publish-20261120-225434-13624-timings.json。
- 回退依据：/opt/pms-repair/web.bak.1795186384、/opt/pms-backups/api/before-100f5d8e-dist.tgz、downloads/pms-data-sync-assistant/latest.previous.json。仅回退对应程序文件，保留现有运行配置与数据。
- 开发验证、未追加发布：精确车牌和 PMS 房产绑定回查、商铺地址新办及原任务幂等、上下文预填小区和明确的收费档位、七位新能源车牌片段、续期调整原因、待审核/人工状态的静态提示。助手开发版 2.6.5。API 两个相关测试文件 40 项通过；Web 六个相关测试文件 19 项通过，另两文件 8 项通过（含重复测试），实测 Chrome 1440/375 重新打开商铺，含有效期、非本户车辆隔离；API tsc、独立助手 Release 构建和自检通过。合成业务数据，无生产收费或下发。
- 现场案例：原收据 PK202611202252232375 已收款，729 商铺的车牌浙F18U8U 待处理。新办在旧版地址转换处抛错，早于停车任务创建。未替现场重试，真实旧库写入及设备放行未验。


## 2026-11-20 车牌尾号与通用房产地址（开发验证）
- 收银台 2199：复现电话或其他地址命中带回非匹配车辆、进而阻止查现场库。按车牌后缀查现场并精确筛选，命中车牌直接列全牌和所属房号，唯一命中回车进车；保留电话搜索。Chrome 1440/375 真实组件验证点击、回车和过滤。
- 商铺、公寓：新办按原交易和登记单的房产 ID、租户、小区读楼栋/单元/室号，保留住宅旧格式。非标准门牌用唯一房产编号作为旧库短键，地址字段保存原门牌，避免不同小区的同名店铺互串。新小区的停车场接入仍按已配置车库办理；没有协议不写其他场。授权为开发验证，未部署或重试现场订单。
- 证据：停车搜索、收银台浏览器及地址选择测试 45 项；paid-registration、parking-search-context.persistence 等 API 合计 25 项。PGlite 查重名商铺和 B座/2/A-009 归属范围；合成登记验证重试幂等。Web 构建与 API 类型检查通过。现场原单浙F18U8U 尚待此次修复发布及核对回执。
