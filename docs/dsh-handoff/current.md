# PMS 本批交接（2026-11-16 北京时间）
## 目标
房号直接连接、网页报修社区公区与照片接通、实际进度统一最新在上并记住偏好。
## 已完成
1. 永南150弄6号201/永北150弄6号201；共享格式器与API镜像一致，不合并身份、不改ID/历史快照。
2. 正式社区公区叶子含无楼栋小区可提交；仅communityId，不伪造楼栋/住户ID，不放宽权限。
3. 照片点击/拖拽/Ctrl+V接通上传与创建/详情；等待/失败门禁、原File重试/放弃、单粘贴目标、重开隔离已验证。
4. 工单/收费催缴/审核/执行历史及两小程序最新优先；真实停留不变、未来计划不反转；偏好已写[项目约定](<../../CLAUDE.md>)。
5. 回归218/218（API共享152+前端小程序66）；五端noEmit、API及两Web本地构建成功；独立审查无新增P0/P1。
6. Chrome桌面/375隔离交互1/1含15主边界、9真实multipart、5合成创建/5详情，截图及源码指纹齐。
7. 源码74e332d0先推main后构建；两端官方CLI明确√ upload，开发版均1.0.20261116b，10:33:30/10:33:55。
8. 643源文件冻结前后不变；两端各58运行文件SHA匹配，实际编译地址/时间线冒烟通过，stamp恢复。
## 进行中
无；本批实现、验证、main集成与开发版上传完成，证据独立入库。
## 待办／未验证
生产API/Web未部署；网页和线上服务端展示尚待当次授权部署；没有生产写入、真实通知或数据迁移。
未代设体验版/提审/发布，未原生手机验收；浏览器和service持久读取使用明确合成API/内存事务，不等于真实存储现场。
助手/设备本批未改。现有附件key读取非逐工单权限；长表单错误提示位于顶部，失败输入和照片保留。
## 关键证据
[逐项对账](<../../outputs/repair-intake-timeline-20261116/verification.md>)；[上传审计](<../../outputs/repair-intake-timeline-20261116/upload-audit.json>)；[浏览器报告](<../../outputs/repair-intake-timeline-20261116/browser/report.md>)。
## 验证命令
`node outputs/repair-intake-timeline-20261116/audit-upload.cjs verify`；`node --test outputs/repair-intake-timeline-20261116/browser/acceptance.test.cjs`；`git -c core.whitespace=cr-at-eol diff --check`。
## 下一轮
公众平台人工选开发版1.0.20261116b／74e332d0为体验版；线上Web/API生效需先获当次授权，仅当前124.223.179.214，禁止退役机。
