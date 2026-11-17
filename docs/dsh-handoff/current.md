# 全部待上线功能发布（2026-11-17 Asia/Shanghai）
## 目标/授权
- 用户21:34“做完后把未上线的功能全部上线”；Web/API本轮已成功。原始整体目标仍未完成，goal active rev8，不得标complete。
- 工作区D:/00项目开发/PMS-release-simplification-20261117 main；仅生产124.223.179.214，禁止旧机1.15.172.131。
## 最新结果（新到旧）
- 22:22 正式Chrome登录页200/微信扫码入口/pageErrors0；仅GET/HEAD+匿名QR ticket，无认证业务动作。首个冒烟误等input超时、GET-only阻断QR，放行匿名ticket后通过。证据outputs/release-all-20261117-2134/production-browser-smoke.json及production-login-1440.png。
- 22:19独立verify-live api/web成功，远端deployed/api和web均9cb93f1da1eed4cbb030e858ba7e46f6730e4821。mark-deployed status确认API/Web/助手无运行源码差异；小程序旧标记仍有10/42提交差异，不能冒称全端正式上线。
- 22:18官方auto job pwsh-6ef23cd6065f4e4d exit0/325342ms，已完整收结果。Web2.0.20261117-2213、API api-9cb93f1；发布记录3e755f4e(API)、d069ce1c(Web)已push；助手无源码变动跳过，仍2.5.54/d075f81d。
- Web hash c5321e589712eaba990c298037e8b4a88ba402004b48f568de162822e4755296；JS index-Dh7q1rM_.js SHA9a642cfe88d2fe3c46a7901b203088546ab7e1bec4fd3da9f440b0b05bf067a1。
- API hash2f60a8e72eeb4d81166e18d11fd4b579f3a77a189e9e5239050d344001b58880；健康ok/db up。限定已有3项DDL检查businessRowsWritten0；新功能无schema迁移。
- 官方门禁：发布器27、档案API21/JWT2/Web3/真React→JWT→SQL1、车位API17/Web12、发卡227、车主22全部通过；Web4237模块和API nest build成功。成功timings publish-20261117-221858-25868-timings.json。
- 22:13旧fixture3文件修复5/5，提交9cb93f1d已push；paid改真实通道key+车位编号，新增缺编号禁审断言，未放宽业务。首发在上传前失败（旧stub缺uploadBlobTo），生产未改，修复后未跳过门禁。
- 产品45文件c81da0c4包含新车登记/选择器/可选资料/授权编号/车位绑定/原收费、round8–20图片/反馈/资源/粘贴/摘要、前后端跨户保护，全部已上线。
- lead集成API101/101+tsc；Web36+修桩1/1+tsc；子任务API30/Web23/Vite通过（覆盖有交叉不要相加）。已审事务/权限/撤回/行锁和375截图。child vehicle-registration冻结完成。
## 仍未完成/下一步
- task107 Web/API上线部分完成，但全端正式上线尚未达成；task101/102保留认证后业务验收，不能以部署结案。104/105/106子任务完成。
- 原六项：标准门禁/控制器/其余停车路由及真实厂商适配；标准停车绑定UI/真实绑定；认证Web；双端picker实机；实卡/.80现场；双端体验保存刷新回读。前两项仍有实现工作，不只是登录阻塞。
- 现有CDP9222仍PMS/login，9223公众平台/无token，已再次只读核实。两端开发版1.0.20261117a/4912774f已上传≠体验/正式发布。下一步认证可用后核AppID、版本，保存刷新回读；不重复未变开发上传、不伪造部署标记。
- 全部当前背景job已收：第二次发布、独立verify、Chrome最终冒烟成功；两次失败冒烟已诊断。未执行真实收款、改历史流水或现场设备动作。
- 更新本轮verification/交接后仅提交相关文档，保留其他dirty。然后继续原六项尚可实现工作（阅读原审计task58/原正式事务路线），不要无意义重跑已验源码。
## 证据/环境
- outputs/release-all-20261117-2134/verification.md（完整版本/hash/测试/限制）；outputs/vehicle-registration-20261117/coverage.md；原审计outputs/omission-release-20261117/delivery-audit-after-upload.md。
- 历史dirty api-expected/source/verified已逐个SHA备份至preserved-release-evidence；不要覆盖或当作新证据。保留其他历史dirty outputs/image-preview-unification-20261117/coverage.md。
- 沪M03212只读属于house15=198/3/301，非house1074=228/31/302；唯一流水27/1500元/house15，不证明全部真实收费。
- 生产核身DNS124.223.179.214，VM-4-8-ubuntu，machine-id005acd736e534836bddf1997a7cc0636，/opt/pms-repair/apps/api，pm2 online。
- Node=C:/Users/Administrator/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node.exe；pnpm同dependencies/pnpm/bin/pnpm.mjs；Chrome C:/Program Files/Google/Chrome/Application/chrome.exe。
- 官方默认node/pnpm成功，无需重装。备选PATH outputs/omission-release-20261117/tool-bin再Node/bin；pnpm verify_deps_before_run=warn,node_linker=isolated，virtual_store_dir=D:/00项目开发/PMS-release-batch-eight-20261116/node_modules/.pnpm。
- SSH ubuntu@124.223.179.214 -i ~/.ssh/pms_repair_key.pem；远程Node走stdin避免引号丢失。官方发布需main已push、源码不变、公网回读。
