# 新车现场代登记验收（2026-11-17）

## 结果与对账
- 已完成：鼠标点选7/8位车牌；工作人员代填；二维码保留；本地点击/拖拽/聚焦粘贴上传；付费附件可选、亲情车证明必需。
- 已完成：同页授权、地下通道既有车位必选、同租户/小区/通道/房号校验，复用车位管理数据源及原CarRenewal/intakeId收款。
- 已完成：绑定和登记审核同事务；审计日志保留绑定前后快照；转换/作废按civil→main锁顺序精确比对后恢复，任一人工修改整笔回滚；收费/执行后不得释放；重复操作幂等。
- 已完成：新create和工作人员接管旧未收费单记录registrationVersion:2；claimForPayment同一登记行锁内拒绝未审核直接收费，attachPayment复核，不能绕前端逃过编号和绑定。
- 已完成：API/前端类型检查、前端生产构建、API30项与真实Chrome23项回归，桌面/窄屏/等待/失败/成功截图。
- 未执行：生产发布、真实收款、设备授权、现场刷卡。由lead统一审查发布。

## 兼容与迁移
无需数据库迁移：版本和绑定快照使用现有登记log JSONB。
- 历史waiting/reupload保留二维码；paid可以无附件提交；family仍需证明、查重和经理审核。
- 历史已收费awaiting_docs单不会自动升v2，审核不追溯占位，不被新编号要求卡死；旧收款流水继续原流程。
- 历史approved无绑定快照：允许原转换/作废，不猜测释放旧车位；不追溯补写绑定，也不阻断原收款。
- 新版和staff接管旧未收费单先审核后收费；改类型后版本标记保留。

## 命令与证据
API目录：
```text
node node_modules/typescript/bin/tsc --noEmit
node -r ts-node/register --test src/modules/business/vehicle-intake.service.test.ts src/modules/business/vehicle-intake-kind-safety.test.ts src/modules/business/vehicle-staff-registration.persistence.test.ts
```
结果：tsc成功；30/30通过。[API完整输出](<api-regression.txt>)。

neighbor-web目录：
```text
node node_modules/typescript/bin/tsc --noEmit
node node_modules/vite/bin/vite.js build
node --test --test-concurrency=1 test/vehicle-staff-registration-browser.test.cjs test/vehicle-intake-actions-browser.test.cjs test/vehicle-intake-focus-browser.test.cjs test/vehicle-intake-navigation-browser.test.cjs test/vehicle-intake-qr-preview-browser.test.cjs test/plate-form-resource-browser.test.cjs
```
结果：tsc成功；Vite4237模块构建成功（仅既有大chunk告警）；23/23通过。git diff --check通过。

| 场景 | 桌面 | 窄屏 |
|---|---|---|
| 鼠标车牌、零附件 | [1440](<staff-optional-1440.png>) | [375](<staff-optional-375.png>) |
| 提交等待锁定 | [1440](<staff-waiting-1440.png>) | [375](<staff-waiting-375.png>) |
| 授权失败保留输入 | [1440](<garage-error-1440.png>) | [375](<garage-error-375.png>) |
| 审核后原CarRenewal、月数与intakeId | [1440](<inline-renewal-1440.png>) | [375](<inline-renewal-375.png>) |

[本地点击/拖拽/定向粘贴共3次上传](<staff-local-upload-1440.png>)。截图已目视检查，浏览器断言无横向溢出、无页面错误、失败不丢输入、旧通道编号清理、原收费入口保留原登记ID。

## 修改清单
生产代码：
- [vehicle-intake.service.ts](<../../apps/api/src/modules/business/vehicle-intake.service.ts>)
- [vehicle-intake.controller.ts](<../../apps/api/src/modules/business/vehicle-intake.controller.ts>)
- [NewPlateCard.tsx](<../../apps/neighbor-web/src/components/cashier/NewPlateCard.tsx>)
- [IntakePlatePicker.tsx](<../../apps/neighbor-web/src/components/cashier/IntakePlatePicker.tsx>)（新增）
- [intake-registration.css](<../../apps/neighbor-web/src/components/cashier/intake-registration.css>)（新增）
- [PlateForm.tsx](<../../apps/neighbor-web/src/pages/PlateForm.tsx>)（仅paid附件可选就绪判断/文案，保留队友资源生命周期修改）

测试：
- [vehicle-intake.service.test.ts](<../../apps/api/src/modules/business/vehicle-intake.service.test.ts>)
- [vehicle-intake-kind-safety.test.ts](<../../apps/api/src/modules/business/vehicle-intake-kind-safety.test.ts>)
- [vehicle-staff-registration.persistence.test.ts](<../../apps/api/src/modules/business/vehicle-staff-registration.persistence.test.ts>)（新增）
- [staff browser](<../../apps/neighbor-web/test/vehicle-staff-registration-browser.test.cjs>)、[staff fixture](<../../apps/neighbor-web/test/vehicle-staff-registration-fixture.tsx>)、[staff transport](<../../apps/neighbor-web/test/vehicle-staff-registration-transport.ts>)（新增）
- [actions transport](<../../apps/neighbor-web/test/vehicle-intake-actions-transport.ts>)、[navigation transport](<../../apps/neighbor-web/test/vehicle-intake-navigation-transport.ts>)
- [navigation browser](<../../apps/neighbor-web/test/vehicle-intake-navigation-browser.test.cjs>)、[focus browser](<../../apps/neighbor-web/test/vehicle-intake-focus-browser.test.cjs>)（补构建环境常量，并更新为先代填审核再使用原收款）

## 证据边界与剩余风险
- 浏览器使用真实业务组件和Chrome，但传输层为明确的本地合成fixture，不证明生产API/设备完成。
- PGlite执行真实PostgreSQL/WASM事务SQL和advisory语句，证明SQL写入/回滚；使用JSONB仓储适配器，不是生产TypeORM完整schema。**未验证多会话advisory-lock竞争**。其余并发测试用序列化mock，不能扩称已证明生产并发安全。
- 没有新增计费算法；没有改BusinessService、Cashier或ParkingTab。旧房号格式无法精确识别时保守拒绝，不猜测归属。
- 一次旧pnpm调用尝试自动安装因NO_TTY退出；未继续安装。pnpm-lock、根及前端manifest无diff；API manifest仅lead原有测试脚本变更。
