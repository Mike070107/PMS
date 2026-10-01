# PMS 数据同步助手 2.5.15

- 按真实旧库结构固定字段语义：`P_Owner.owner_Name` 是房号，`owner_Tel` 是电话，旧住户表没有姓名字段。
- 车辆备注继续从 `Car_Issue.P_note` 读取和更新，并通过 `Car_Issue.Owner_ID = P_Owner.UserID` 关联住户。
- 修复识别备注后房号丢失，以及编辑时可能把 PMS 姓名误写进旧库房号字段的问题。
