# PMS 数据同步助手 2.5.3

2.5.3 完善停车续期收费的旧库落账闭环：

- 续期任务继续调用旧系统存储过程 `Palte_extend`，不直接修改 `Car_Issue`。
- 操作员固定使用旧库中已建立的 `PMS` 账号，避免网页传入的名称导致“最近的充值延期车辆”列表缺少记录。
- 存储过程完成后按车牌、`Issue_ID`、续期类型和操作员回读 `P_moneyKeep`，并把流水 ID 回传 PMS。
- 如果车辆到期日已更新但旧库流水没有读回，任务明确失败，便于重试和审计，不会误报为完成。

本版本只更新助手程序和运行时版本；配置、代理 ID、数据库密码仍保留在 `ProgramData\\PMS\\DataSyncAssistant`。

## 生产发布记录

2026-10-01 已发布到 `https://prsznh.cn/downloads/pms-data-sync-assistant/`。线上清单为 2.5.3，更新程序 SHA-256 为 `3b7fc088907aaf84a9cac0877a7e14d8defd8c184ece99ca0ef9b5475290a255`；清单和公网下载文件已按相同哈希回读校验。
