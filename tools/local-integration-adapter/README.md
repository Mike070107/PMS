# PMS 本地标准适配器

厂商数据库、SDK、字段及日期/状态映射留在本地模块；PMS只收发版本化业务命令，不接收SQL或数据库凭据。

- [完整协议、API、安装配置及新厂商验收步骤](../../docs/local-integration-protocol.md)
- [共用执行器](runner.cjs)：真实HTTP、能力探测、持久执行意图、回执重传、已执行任务去重、互斥锁；无模拟成功分支。
- [SQLite只读参考模块](sqlite-readonly.example.cjs)：真实只读连接和参数绑定，仅实现固定示例表的门禁查询，不是任意厂商兼容层。
- [自动回归](runner.test.cjs)：真实SQLite、SQL注入绑定、缺库撤回能力、丢回执不重复执行、进程中断unknown、过期租约、重复启动与安全退出。

```powershell
node --test tools/local-integration-adapter/runner.test.cjs
```

执行器使用本地私有状态目录；Windows必须核对NTFS权限。异常退出后的锁不能自动抢占：确认旧进程和全部SDK线程退出后，人工移除锁并保留journal/receipts恢复回报。未知结果禁止自动重新执行。断电/存储损坏不能仅依靠文件日志保证exactly-once，写操作仍需厂商侧持久去重和真实回读对账。

标准写卡已在[正式发卡服务](../../apps/api/src/modules/local-integrations/standard-card-issuance.service.ts)中绑定原发卡批次、实卡 UID、`.80` 旧库真实分配账及逻辑资源；只有正式入口能够生成 `card.write`，通用任务创建接口仍禁止自行填写 allocationId 绕过分配。写入成功必须回读原 UID 和分配卡号；结果未知停机，控制器重试不能清除写卡停机标记。

以上是服务端业务桥接和隔离合成数据回归，不代表本目录已包含 ACR122U/MIFARE 实卡适配模块。此目录目前只有只读 SQLite 示例；标准协议的真实硬件适配、门禁/停车正式业务路由及现场实卡全链路验收仍未完成。已有旧协议写卡通道继续保留，不自动迁移。
