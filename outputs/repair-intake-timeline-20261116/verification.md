# 报修登记与倒序时间线验收（2026-11-16，北京时间）

## 结果与逐项对账

源码提交 `74e332d00514b17ee2f753f76a8a498628781bf2` 已先合入并推送 main，再冻结、构建和上传。以下四项均已实现并验证；**生产 API/Web 尚未部署，不表示当前线上页面已经更新**。

| 用户要求 | 状态 | 实际交付 |
|---|---|---|
| 永南150弄6号201，不要号/201 | 已完成 | 共享格式器与API镜像统一；永北同样处理；不改变南北小区、楼栋、住户ID或历史地址快照。独立房号格式、办公路名层级及公区分隔保留。 |
| 网页可选小区级公区并提交 | 已完成 | 正式选址器增加“本小区公共区域”叶子；没有楼栋的小区仍能提交，只有communityId；楼栋公区、住户选择保持原ID。后端既有权限/DTO不放宽。 |
| 照片附件接通 | 已完成 | 正式登记点击/拖拽/Ctrl+V→既有multipart上传→附件URL→创建载荷→详情读取；等待与未处理失败阻止提交；重试/放弃、失败保留、关闭重开隔离与单粘贴目标均验证。 |
| 进度时间线最新在上，记住偏好 | 已完成 | 工单、收费/催缴、审核与执行历史展示最新优先；两小程序共用时间线先按真实时间计算停留再倒序；不改变存储/调用顺序、不反转未来计划。偏好写入[CLAUDE.md](<../../CLAUDE.md>)。 |

## 证据

### 回归与审查
- 共享/API **152/152**，前端/小程序 **66/66**，合计 **218/218**；[API日志](<regression-api.log>)、[前端日志](<regression-front.log>)。
- API测试调用实际service创建/事务/详情方法，以内存repository替身验证社区公区、附件保存与读取、跨租户/未知社区拒绝、原ID/快照保留；没有真实数据库写入或通知发送。
- [五端最终类型检查](<typechecks-final.log>)：API、neighbor-web、admin-web、miniapp-staff、miniapp-owner均PASS。
- 独立只读审查无新增P0/P1；另修正提交未决时关闭表单的旧响应风险及无楼号办公地址分隔回归。
- [时间线专项报告](<timeline/report.md>)；消费者16项包含真实运行函数/组件和正式渲染入口契约，不把静态契约冒充原生设备验收。

```powershell
# cwd apps/api
$env:TS_NODE_PROJECT='tsconfig.json'
node -r ts-node/register/transpile-only --test --test-concurrency=2 ../../packages/shared-types/src/address*.test.ts ../../packages/shared-types/src/property-address.test.ts ../../packages/shared-types/src/timeline.test.ts ../../packages/shared-types/src/work-order-sort.test.ts src/common/address*.test.ts src/modules/repairs/repair-address*.test.ts src/modules/qr/qr-address.test.ts src/modules/maintenance/maintenance-address.util.test.ts
# cwd repository root
node --test apps/neighbor-web/test/repair-intake-public.test.cjs apps/neighbor-web/test/repair-intake-photos.test.cjs apps/neighbor-web/test/repair-location-options.test.cjs apps/neighbor-web/test/work-order-stages.test.cjs apps/miniapp-staff/test/timeline-order.test.mjs
```

### 真实浏览器交互（隔离合成API，不是生产业务验收）
- [完整报告](<browser/report.md>)、[结构化结果](<browser/result.json>)、[上传头/创建载荷/读取边界](<browser/captured-boundary.json>)、[受测源码指纹](<browser/tested-source-hashes.json>)。
- 最终Chrome **1/1**集成用例通过，含15主交互边界；1440与375视口，9次实际multipart HTTP上传、5次合成create和5次合成detail读取。
- 实际组件/实际uploadImage，三种入口含系统剪贴板PNG与真实Control+V；可解码合成PNG显示正常。模拟创建失败后4张照片和表单保留，重试与刷新读取相同URL；双上传区每次仅一个接收目标；迟到上传不污染新草稿。
- 截图：[桌面小区公区](<browser/desktop-community-public.png>)、[窄屏照片保留](<browser/narrow-retained-photos.png>)、[窄屏详情照片](<browser/narrow-created-detail.png>)、[桌面最新优先](<browser/desktop-timeline-newest-first.png>)、[窄屏最新优先](<browser/narrow-timeline-newest-first.png>)。

```powershell
node --test outputs/repair-intake-timeline-20261116/browser/acceptance.test.cjs
```

### 本地构建与官方CLI开发版上传
- Nest API构建成功；实际编译地址模块对南北小区直接连接房号的冒烟通过：[API制品证明](<api-build-proof.json>)。
- 两Web生产模式本地构建成功：[来源证明](<web-build-proof.json>)、[构建日志](<build-web.log>)。实际渲染的address和timeline模块来自本工作树，未借用旧目录源码；未启动替代PMS服务器或部署。
- Web保留既有默认压缩/target；使用进程级不存在TEMP规避Windows esbuild管道问题，未改依赖/ACL。仅有非阻塞chunk体积警告。
- [源文件冻结](<source-freeze.json>)含643文件；[上传审计](<upload-audit.json>)确认上传前后源码不变、两端各58个运行文件SHA匹配、buildStamp恢复、实际编译地址和倒序时间线断言通过。

| 开发版 | AppID | 版本 | 上传时间（北京） | CLI包体 |
|---|---|---|---|---|
| 员工端 | wx002fde4bfaa4c7d9 | 1.0.20261116b | 10:33:30 | 1,115,958 bytes |
| 业主端 | wx8ef4de0e498064c4 | 1.0.20261116b | 10:33:55 | 351,778 bytes |

[员工CLI日志](<cli-upload-staff.log>)与[业主CLI日志](<cli-upload-owner.log>)均有明确 `√ upload`；[可入库CLI原文回执](<cli-upload-receipts.json>)保留两端AppID、成功行、包体与源码基线。旧包装器文案“上传体验版”不代表设置了体验版本；描述中的“+本地改动”来自源码范围外的输出文件，独立审计确认产品源码干净且等于冻结提交。

```powershell
node outputs/repair-intake-timeline-20261116/audit-upload.cjs verify
```

## 剩余风险／未授权或未验证
1. **未部署生产API/Web**：网页登记、线上通知及服务端展示须另行取得当次部署授权后才线上生效；本批没有连接生产、改生产数据或发送真实通知，也没有数据迁移/南北小区合并。
2. 两小程序只上传开发版。需人工到公众平台选择对应版本/源码74e332d0为体验版；未代设体验版、提审或正式发布，未进行原生手机验收。
3. 浏览器API/身份/创建/详情为明确隔离合成适配，API service持久读取测试用内存事务替身；未验证真实对象存储、生产权限/通知/数据库现场。附件读取沿用现有key代理，不冒称新增逐工单读取鉴权。
4. 非阻塞既有UX：长表单提交错误提示位于顶部，停在底部时可能需要上滚；已验证错误后输入和照片完整保留。
5. 助手/设备本批未修改、未发布、未现场验收。
