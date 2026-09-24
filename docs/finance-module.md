# 财务记账模块

财务模块使用独立的 TypeORM 连接与 `finance_*` 数据表。正式环境应配置 `FINANCE_DB_NAME` 指向独立数据库；本地未配置时会复用主数据库连接，但仍与 PMS 业务表隔离。权限在服务端强制校验，仅租户管理员、平台管理员进入租户视角后，或姓名严格为“叶双”的当前租户员工可访问；普通角色权限无法放开该入口。

## 必需配置

```dotenv
# 正式环境使用独立数据库
FINANCE_DB_HOST=127.0.0.1
FINANCE_DB_PORT=5432
FINANCE_DB_USER=pms_finance
FINANCE_DB_PASS=replace-me
FINANCE_DB_NAME=pms_finance
FINANCE_DB_SYNCHRONIZE=false

# 用于 AES-256-GCM 加密邮箱授权码，至少 16 个字符；生产环境应由密钥管理服务生成
FINANCE_SECRET_KEY=replace-with-a-long-random-secret
```

首次启用新库时按现有数据库发布流程创建结构，不应长期打开 `FINANCE_DB_SYNCHRONIZE`。邮箱地址与 IMAP 授权码只通过“财务记账 → 邮箱设置”录入，授权码不写入源码、环境模板、日志或接口响应。

## QQ 邮箱同步

- 固定使用 `imap.qq.com:993` 与 TLS，仅以只读方式打开 `INBOX`。
- 首次同步最近 7 天；之后按 `UIDVALIDITY + UID` 增量拉取。
- QQ 邮箱同步仅接收 PDF 附件，按 SHA-256 去重；后台手工上传仍支持 PDF、OFD、XML、JPG、PNG、WebP、ZIP。
- 同步不会标记已读、移动或删除邮件；页面“丢弃”仅改变财务收件箱状态，可恢复。
- 金额或日期相同只用于候选排序，不自动建立关联；用户确认后才匹配流水。

## 当前交付边界

已实现项目/子项目、项目附件与流水凭证的拖拽/截图粘贴、收支流水、发票收件箱、QQ 邮箱连接与每 5 分钟自动增量同步、发票人工匹配/恢复丢弃、报销申请与付款完成。
