# PMS 本批交接（2026-11-15 北京时间）
## 目标
员工端公寓收费工作台：底部今日明细/汇总、收费项目彩色图示、本户历史精简；lead单写、browser-check只读审查；不继承上批生产授权。
## 已完成
1. 今日卡片不依赖选房，复用真实cashier/today权限范围；北京日期、全页净额/红冲口径明示，刷新/分页/错误/缓存/换日状态齐。
2. 8收费项目本地彩色SVG图标+文字/单位/选择状态；仍走原收费流程。
3. 本户历史改名，隐藏列表订单号；显示时间、项目×数量、金额、收款方式，保留红冲状态；成功凭证弹窗编号不变。
4. 本户历史分页与切户防乱序、翻页期间新增流水重读、主键去重；自定义方式保留，负数退款不划线。
5. 修正页级底部留白选择器，避免被共享规则覆盖；滚到底卡片不被固定收款条遮挡。
6. 最终23/23回归（纽约TZ+真实北京格式器）、员工端TS emit、真实页wcc/wcsc编译通过；独立终审无新增阻断。
7. 离线浏览器投影320/390、6状态与末卡/操作条边界通过、HTTP=0，已目检截图；这不是微信运行时证据。
## 进行中
本批源码开发/局部编译验收完成；完整微信打包、原生渲染/真机及上传未完成。
## 待办/未验证
工作树缺staff/node_modules与miniprogram_npm；标准libs脚本miniapp-ui模块解析失败，已用outputs局部paths对真实声明编译通过；未安装/清理共享依赖。
在已配好依赖/登录态的员工端开发工具构建npm、隔离验证原生渲染后上传开发版；审核/正式发布须当次授权；勿连正式会话写收费数据。
今日统计是本人可见公寓范围净收款，不是本员工个人业绩；不可改用MIS住宅台账、逐页求和或过滤掉负数红冲。
## 关键文件/证据
[验收对账与全部命令/截图](<../../outputs/apartment-cashier-20261115/verification.md>)；[页面](<../../apps/miniapp-staff/miniprogram/pages/apartment-cashier/apartment-cashier.ts>)；[新回归](<../../apps/miniapp-staff/test/apartment-cashier-daily.test.mjs>)；[客户端类型](<../../packages/api-client/src/endpoints/apartment-cashier.ts>)。
## 验证命令
`node --test apps/miniapp-staff/test/apartment-cashier*.test.mjs`；TS/wcc/wcsc/离线投影命令见验收；`git diff --check`。
## 下一轮
本批基线main=34bdd385，开发分支codex/staff-apartment-cashier-20261115；只提交本批明确文件，保留全部outputs。
上批API/Web生产仍c0dcec1a、助手2.5.54/d075f81d；[上批生产证据](<../../outputs/release-20261115/verification.md>)；本批未部署/上传、不修复重放业务，不连接已退役1.15.172.131。
