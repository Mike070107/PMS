# 全部待发布功能集成验收

## 2026-11-17 最新结果（新到旧）
- 22:22 正式公网Chrome登录页200、二维码/微信确认入口渲染、pageErrors=0。仅允许GET/HEAD及匿名二维码ticket创建，禁止其他POST；没有认证后业务操作。首次错误地期待input导致超时；随后的纯GET诊断阻断了必需的ticket POST而显示Failed to fetch，纠正冒烟边界后通过，非产品故障。证据production-browser-smoke.json、production-login-1440.png。
- 22:19 独立再次verify-live api和web均通过；远端deployed/api、deployed/web均9cb93f1da1eed4cbb030e858ba7e46f6730e4821。mark-deployed status确认API/Web/助手均无运行源码差异；不等于小程序/现场全部完成。
- 22:18 官方auto发布成功，exit0，总耗时325342ms；API及Web上传前分别校验源码未变、健康/静态入口200和公网制品身份。助手无源码变化跳过，保持2.5.54/d075f81d，未验证现场安装。
- Web：2.0.20261117-2213；API：api-9cb93f1；二者产品提交均9cb93f1da1eed4cbb030e858ba7e46f6730e4821。发布日志提交3e755f4e(API)、d069ce1c(Web)已推送main。
- Web sourceHash=c5321e589712eaba990c298037e8b4a88ba402004b48f568de162822e4755296；index SHA256=dbe78f47fa72b6d6ad463dabccb4c7f1557e01ae6044328609c481a6b705a819；assets/index-Dh7q1rM_.js SHA256=9a642cfe88d2fe3c46a7901b203088546ab7e1bec4fd3da9f440b0b05bf067a1。
- API sourceHash=2f60a8e72eeb4d81166e18d11fd4b579f3a77a189e9e5239050d344001b58880；健康status=ok,db=up。限定既有三项标准接入DDL检查businessRowsWritten=0；新车功能无新增schema迁移。
- 22:13 三个历史浏览器fixture校正后5/5：联系人正式入口、自定义月份、车牌审核3项。显式拒绝意外上传；paid使用真实local:/deliyun:键及同小区A01/B01，新增缺编号禁止审核和编号payload断言。提交9cb93f1d已推送。
- 首次官方发布在上传前被旧联系人fixture缺uploadBlobTo阻断，exit1/143秒，未改变生产；修复后重跑官方全流程，没有绕过门禁。首次timings=publish-20261117-220508-29052-timings.json；成功timings=publish-20261117-221858-25868-timings.json。
- 用户21:34授权全部待上线功能。产品45文件提交c81da0c4已推送，并完整进入本轮Web/API。

## 已上线范围
- 新车代登记：鼠标点选车牌、扫码/本地/无附件（付费新车）、同页授权及地库编号绑定→原车位管理、原CarRenewal收费；v2行锁内强制审核后收费；历史已收费单不追溯占位，亲情车保留资料和经理审核。
- round8–20图片预览入口、反馈上传重试/资源回收、多粘贴目标、收银摘要两行字体、前端选房清旧车牌/严格归属过滤、后端已有车牌跨户与ID不符阻断，全部包含。

## 验证证据
- 最终集成：API十文件101/101+tsc；Web十六文件首次36/37（旧串户fixture缺导出），修桩受影响1/1+tsc，其余36项已过且源码未变；最后额外旧fixture5/5。
- 官方门禁：发布器27/27，档案API21/21、真JWT+SQL2/2、Web档案3/3、真实React→JWT→SQL1/1；车位API17/17、Web12/12；发卡227/227、车主更新22/22；限定迁移检查通过。正式Web4237模块构建和API nest build成功。
- 子任务先前API30/30、Web23/23；上述套件有交叉，不将数量相加当独立总覆盖。Lead已审事务/权限/恢复/收款锁与375px同页截图。
- 唯一生产DNS124.223.179.214，hostname VM-4-8-ubuntu，machine-id005acd736e534836bddf1997a7cc0636，/opt/pms-repair/apps/api，pm2 pms-api在线。首次SSH内联引号失败，stdin脚本核对成功。
- 发布前历史dirty api-expected/source/verified复制至preserved-release-evidence，逐个SHA256相同；未覆盖其他任务文件，生成的新发布证据不冒充旧证据。

## 未完成/风险及下一步
- “全部功能完成并全部正式上线”尚未达成：小程序仅此前开发版1.0.20261117a/4912774f上传。Git旧部署标记仍列员工10、业主42个相关提交，不能由它判断平台实际体验/正式状态；本轮未改小程序，不重复开发上传，不伪造标记。
- 已复核现有浏览器：PMS9222仍/login，公众平台9223仍/无token。缺认证，双端体验指针保存→刷新回读、正式发布及认证后Web业务验收未做；下一步需有效管理员登录后继续，不能绕过认证。
- 原六项整体验收仍未完：标准门禁授权/控制器及其余停车路由和真实厂商适配；标准停车绑定管理UI/实际绑定；认证后Web；双端picker手机实测；实卡/.80现场设备；双端体验指针保存刷新回读。前两项仍有实现工作，不能全部归为登录阻塞。
- 没有真实收款、历史流水改写、现场刷卡/设备授权验收；浏览器合成传输、PGlite事务回滚不能替代生产TypeORM全schema、多会话并发或真实设备证据。
