# task-48 独立生产后验：通过

## 结果（2026-11-16 12:44–12:46 +08）
已完成全部后验项；仅 GET + 当前生产固定 IP 的只读 SSH，未业务写入、调用通知、部署、修改环境、解包或回滚。

| 项目 | 亲验结果 |
|---|---|
| API 双路 | 普通域名实际 socket `198.18.4.73` 与固定实际 socket `124.223.179.214` 均 HTTP200、完整 TLS 授权、SNI `prsznh.cn`、status=ok/db=up |
| 发布身份 | target/version/commit/sourceHash/builtAt **五字段**均逐字段严格等于最新冻结 expected |
| 生产身份 | VM-4-8-ubuntu / ins-2s08wnpd / 10.0.4.8 / `/opt/pms-repair/apps/api`；pms-api PID312460，进程存活非 zombie，cwd 正确 |
| 关键 dist | 三个文件逐一 SHA256 + 字节数与当前本地及此前验证 build-proof 一致 |
| 回退包 | 指定旧包仍在、1,643,770字节、SHA正确、1474 tar成员；仅流式读取列表，无解包/回滚 |
| Web | `2.0.20261115-0154` / `c0dcec1a98becf32bbd16d0e094e982080effb1e`，双路径发布元数据及files字段均与历史正式 verified 一致 |
| 助手 | `2.5.54` / `d075f81de4941147fcc15e3cabba1e4f31e5ea7f`，双路径 manifest一致，与 deployed/assistant 完整tag及当时 AssemblyVersion2.5.54.0一致 |

API：`api-b9cbd70` / `b9cbd70478dad8988774aeb25b2946bf2271e956`；sourceHash `eb9e963f7b98e944e12dd875694fac1f77d0c2cdeeb394856330401b4a5a536a`；builtAt `2026-11-16T04:40:04.727Z`。

## 证据
- [自包含冻结预期](<expected-snapshot.json>)、[HTTPS双路径原始JSON](<public-postcheck.json>)、[抓取脚本](<postcheck.cjs>)。
- [只读SSH原始JSON](<remote-postcheck.json>)、[明确命令脚本](<remote-postcheck.py>)；实例断言通过后才读取以下文件SHA：
  - repairs.service.js：`4fdb9337941ca64f44baec5edec6ce6d56964ffb52f726821e60b6f320cae1f2`，308012字节。
  - extract-samples.service.js：`6b3696e91d9296bf4bb6cb96eb3657512a4af3bc88f5f11e20aeaa788daa6812`，15363字节。
  - repair-text.ai.js：`314b070c43bb41cb5f7eee4466e0a9d483c9283593d447c1d295f4966dd0089f`，20322字节。
- 回退 `/opt/pms-backups/api/pms-api-rollback-20261116-120900.tar.gz`：SHA `8a1332160de6165cdbdfc0a2a130e36b4fbf6a6faa68651c8afb83fd56a66d5d`，1474成员。
- [比较脚本](<compare-postcheck.cjs>) / [全部机器断言通过JSON](<comparison-result.json>)，命令退出0。三个文件路径、完整本地/远端匹配结果均在JSON。
- 历史身份已复制：[Web verified](<historical-web-verified.json>)、[助手正式日志摘录](<historical-assistant-deploy-log.md>)、[完整部署tag](<assistant-deployed-tag.txt>)、[tag当时AssemblyInfo](<assistant-deployed-assembly.cs>)。

## 自检对账
- [x] 最新 expected 实际读取并冻结；双路真实 socket/TLS/健康/五字段完成。
- [x] 当前生产身份、三个关键dist本地/验证构建/远端哈希完成。
- [x] 指定旧回退包存在、完整SHA、tar1474成员完成。
- [x] 当前公开Web/助手身份及历史正式基线一致完成。
- [x] 原始JSON、脚本、比较断言和自包含基线证据完成；未触碰lead证据目录。

## 剩余风险 / 明确未验证
本次 preflight **没有同时点Web/助手前测**，不能冒称做过本轮同时点前后比较；结论严格为“当前公开身份匹配历史正式基线”，本次API-only且其它端未部署由lead发布范围佐证。只核公开版本元数据，没有重新下载并执行助手、没有本轮全量Web静态资源内容验算，也不验证现场升级。API健康/编译文件SHA不证明真实业务数据库写回、通知效果、原生微信/手机交互或硬件完成。这些不属于本次只读后验范围。
