# 地址去重交付对账（2026-11-16，Asia/Shanghai）

## 结果
- 源码87bb63e0已合入并推送main，随后才构建与上传；未部署生产API/Web、未改生产数据库、未发真实微信通知。
- 保留永南150弄/永北150弄独立小区名称与ID；推荐分别配置弄号150、楼号6、房号201，不合并、不清空弄号、不把整段地址塞进楼号。
- 示例：永南140弄/140弄6号 大门 → 永南140弄6号 大门。仅删除相邻且完全相同的完整数字弄号；不同弄号、南北名称、公区位置与emoji保留。
- 共享格式器、7类工单通知地址、工单详情返回副本/列表回退、公区识别、两小程序选址、QR新文案/旧码展示、Web收费流水/统一搜索、员工今日收费均接入同一规则。
- 详情编辑往返不把展示去重回写为历史地址更正；位置ID未变且仅去重时保留旧snapshot，真正改地点仍保存/记日志。

## 验收清单
日志为本地忽略制品，可从本工作区打开；JSON审计、源码冻结、验证runner与本对账随main保存，未强制改变仓库忽略日志的约定。
| 验收项 | 状态 | 证据 |
|---|---|---|
| 调查通知真实双通道及配置 | 已完成 | 独立只读调查与公众号/订阅fallback18条内存真链验证，无外发 |
| 去重且保护南北身份、权限、原快照 | 已完成 | [137/137共享/API回归](<D:/00项目开发/PMS-vehicle-type-20261114/outputs/address-dedupe-20261116/regression.utf8.log>)；修复前失败保留于[编辑往返基线](<D:/00项目开发/PMS-vehicle-type-20261114/outputs/address-dedupe-20261116/intake-before.utf8.log>) |
| Web实际纯函数/员工真Page与旧收费流程 | 已完成 | [30/30前端回归](<D:/00项目开发/PMS-vehicle-type-20261114/outputs/address-dedupe-20261116/frontend-tests.utf8.log>)，其中收费测试使用America/New_York检查北京日期行为 |
| API、两Web、两小程序类型检查 | 已完成 | 五端tsc --noEmit成功静默exit0；miniapp显式typeRoots指向既有miniprogram-api-typings@3.12.0；工具已收任务pwsh-34a20f601de84119（API/两小程序）与pwsh-775a8e56d87a4b48（两Web），静默Tee未生成日志文件 |
| API编译与真实JS冒烟 | 已完成 | nest build exit0；[编译产物冒烟](<D:/00项目开发/PMS-vehicle-type-20261114/outputs/address-dedupe-20261116/compiled-api-smoke.utf8.log>) |
| 两Web构建、本树helper真实进入bundle | 已完成 | [两端Rollup来源证明](<D:/00项目开发/PMS-vehicle-type-20261114/outputs/address-dedupe-20261116/web-build-proof.json>)；[成功构建日志](<D:/00项目开发/PMS-vehicle-type-20261114/outputs/address-dedupe-20261116/web-build-protocol.utf8.log>) |
| 两小程序共享包/npm构建及CLI开发版上传 | 已完成 | [员工CLI](<D:/00项目开发/PMS-vehicle-type-20261114/outputs/address-dedupe-20261116/cli-upload-staff.utf8.log>)/[业主CLI](<D:/00项目开发/PMS-vehicle-type-20261114/outputs/address-dedupe-20261116/cli-upload-owner.utf8.log>)均有真实√ build-npm、√ upload |
| 上传前后源码/运行包一致 | 已完成 | [310源文件冻结](<D:/00项目开发/PMS-vehicle-type-20261114/outputs/address-dedupe-20261116/source-freeze.json>)；[上传审计](<D:/00项目开发/PMS-vehicle-type-20261114/outputs/address-dedupe-20261116/upload-audit.json>)两端各57运行文件SHA相等，stamp还原，实际运行包南北同弄及数字边界冒烟通过 |

## 版本与操作边界
- 员工开发版：1.0.20261116a，09:31:56上传，AppID wx002fde4bfaa4c7d9，1,115,130字节，源码87bb63e0。
- 业主开发版：1.0.20261116a，09:33:43上传，AppID wx8ef4de0e498064c4，350,950字节，源码87bb63e0。
- 两端均未代设体验版、未提交审核或正式发布；用户可在公众平台版本管理手动选上述开发版为体验版。
- CLI描述的“+本地改动”来自根目录未跟踪outputs；CLI装包说明与完整审计确认应用/共享包源码没有夹带修改。脚本“上传体验版”的字样不等于已改变体验指向。
- API/Web本次未部署；本机部署标记仍c0dcec1a，未在本次重新公网验版本。助手本次未改，历史标记d075f81d，不证明现场安装。

## 构建环境处理
- Web前两次默认临时文件传输均在esbuild>1MiB交换文件删除处Access is denied；[首次日志](<D:/00项目开发/PMS-vehicle-type-20261114/outputs/address-dedupe-20261116/web-build.utf8.log>)/[已建隔离TEMP重试](<D:/00项目开发/PMS-vehicle-type-20261114/outputs/address-dedupe-20261116/web-build-retry.utf8.log>)保留，未改ACL、安全软件或依赖。
- 复用此前已验证机制，在实际Vite build前仅对进程设置全新不存在TEMP/TMP，不mkdir，让esbuild回落原生服务协议；默认minify/target不变，两端构建成功且TEMP仍不存在。
- Admin依赖junction会解析到另一工作树，因此本批只在构建runner显式绑定本树@pms/shared-types与api-client源码；未改共享node_modules。两Web产物仅本地验证，不上传生产。

## 剩余风险/未验证
- 线上微信通知与旧工单详情的去重需另行授权部署API；Web展示同样需部署对应Web，不应因开发版上传而声称所有线上入口已经生效。
- 未做真实微信发送、真实数据库编辑、原生手机渲染/真机验收；本次是可重复内存回归、编译及上传链证据，不替代现场验收。
- 统一搜索choose回调未单独跑React交互测试；该处只包装原setSelectionText文案，选中ID/onPick/查询不变，独立代码审查无P0/P1。Web有既存大chunk体积警告，构建exit0。
