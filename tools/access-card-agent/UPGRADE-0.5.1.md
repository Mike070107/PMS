# PMS 数据同步助手 0.5.1

## 本次更新

- 修正 `Car_Issue.Owner_ID` 的住户表识别：优先使用真实外键指向的表和键；没有外键时，按姓名、电话、房号、备注字段与实际 `Owner_ID` 重叠数据选择住户表。
- 增加 `--parking-procedure-info`，只读输出 `AddIssue`、`Palte_extend`、`Up_PakIssue`、`Add_Del_Plate`、`Add_DownloadCard` 等过程的真实参数名和类型。
- 本地停车写入确定走旧系统存储过程，不直接插入 `Car_Issue`。

覆盖旧程序并重新安装后台服务后，执行：

```powershell
.\Pms.DataSyncAssistant.exe --parking-procedure-info
```

该命令不写数据库。
