# PMS 数据同步助手 0.5.0

## 本次更新

- 开放本地停车系统的受控写入测试准备状态。
- 网关必须在 `parking1` 和 `parking2` 中同时拥有 `AddIssue`、`Palte_extend`、`Up_PakIssue`、`Add_Del_Plate` 和 `Add_DownloadCard` 的执行权限，才会上报写入已就绪。
- 不开放直接修改 `Car_Issue` 表；后续测试一律走旧系统自带存储过程，避免漏掉下载队列和设备状态。

覆盖旧程序后，重新点击“保存并安装后台服务”。网页出现“受控写入测试已开放”才表示两个库都通过。
