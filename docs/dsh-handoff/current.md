# PMS 本批交接（2026-11-15 北京时间）
## 目标
员工端公寓收费改版并用微信开发者工具CLI上传开发版；lead单写，browser-check只读复核，不提交审核/正式发布。
## 已完成
1. 底部今日收费汇总/明细复用真实cashier/today权限范围、北京日期及全页净额含红冲，不依赖选房。
2. 8收费项目本地彩色SVG；本户历史隐藏列表订单号，展示时间、项目数量、金额、方式及必要红冲状态。
3. 加载/错误/缓存/换日、防乱序、分页新增重读去重及底部遮挡修正；原收费流程和成功凭证编号不变。
4. 23/23回归（纽约TZ+真实北京格式器）、员工端TS emit、页wcc/wcsc通过；320/390离线浏览器6状态通过，HTTP=0，非微信原生截图。
5. 功能4c1a25ed；正式miniapp-ui构建paths修复+用户默认自动上传偏好aa674ca2，已合入并推送origin/main后构建。
6. 员工端本地node_modules的3个Junction指向本树packages，未改共享node_modules；标准三包构建、CLI build-npm真实通过。
7. 13:42微信CLI明确√ upload，appid wx002fde4bfaa4c7d9，开发版1.0.20261115a，源码aa674ca2，包1,114,840字节；57运行文件SHA与本树构建一致，标记已还原。
8. 上传备注「+本地改动」仅因根未跟踪outputs触发全树dirty；应用/三包源码与上传提交一致，无夹带源码。
## 进行中
无实现/上传阻塞；CLI开发版上传已完成，不应再次重复上传同号。
## 待办/未验证
公众平台「版本管理→开发版本→1.0.20261115a（aa674ca2）→选为体验版」尚未代设；手机核对我的页版本及原生渲染/真机验收未做。
审核/正式发布另需当次授权；不得进入正式会话写收费数据验证。不改API统计/权限/支付写入。
## 关键文件/证据
[验收对账](<../../outputs/apartment-cashier-20261115/verification.md>)；[CLI回执](<../../outputs/apartment-cashier-20261115/cli-upload.log>)；[57文件审计](<../../outputs/apartment-cashier-20261115/upload-audit.json>)；[偏好指引](<../../CLAUDE.md>)。
## 验证命令
`node --test apps/miniapp-staff/test/apartment-cashier*.test.mjs`；`node tools/build-miniapp-libs.mjs`；`node outputs/apartment-cashier-20261115/audit-upload.cjs`；`git diff --check`。
## 下一轮
以后小程序改完验证后自行CLI上传开发版，不等用户提醒；可修复依赖/构建问题自行解决，仅真实登录/权限阻塞才报告；体验指向/审核/正式发布权限不扩大。
上批API/Web生产仍c0dcec1a，助手2.5.54/d075f81d；本批未改其生产、未写业务数据。保留全部outputs，不连接已退役1.15.172.131。
