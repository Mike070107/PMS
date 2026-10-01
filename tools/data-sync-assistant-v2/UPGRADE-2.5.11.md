# PMS 数据同步助手 2.5.11

根据 parking2 实际结构修复住户资料更新：`P_note` 位于 `Car_Issue`，通过 `Owner_ID` 关联 `P_Owner.UserID`。姓名、电话、房号更新 P_Owner，备注更新对应车牌的 Car_Issue.P_note，并在写入后分别读回核验。
