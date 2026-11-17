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
