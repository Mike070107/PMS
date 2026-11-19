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
