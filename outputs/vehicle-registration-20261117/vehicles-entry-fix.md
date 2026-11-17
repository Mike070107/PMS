# Vehicles 新车登记实际入口修复

## 结果与边界
- 用户截图揭示此前交付漏接 Vehicles 新车登记弹窗；之前 NewPlateCard 单组件通过不能证明此入口可用。
- 现 Vehicles → 新车登记 → 选择房屋 → 工作人员直接登记，直接展开原 NewPlateCard 代填，保留扫码、本地上传和付费无附件登记；复用原授权/车位编号及 CarRenewal 收费链。
- 内嵌原 Cashier，仍以登记 ID 经授权地址树确定房屋，不解析房号猜住户，不另造收费接口；亲情/撤销/已收款状态禁止收费。
- 同一弹窗完成登记、撤销与收费结果；处理过程中保护关闭与再登记；变更回传外层收费状态。
- 未上线。生产登录后的真实住户、真实支付及现场设备确认未验；模拟接口不代表业务闭环完成。

## 本轮证据
- `pnpm exec tsc --noEmit` 通过。
- `node --test test/vehicle-intake-navigation-browser.test.cjs test/vehicle-staff-registration-browser.test.cjs` 首轮 12/12 通过：实际 Vehicles/Cashier/Plates 组件，1440/390 窗口，单组件补充 375 窗口。
- `pnpm run build` 通过：Vite 4238 modules；现有大包体积警告，无构建错误。
- 增补收款悬挂期间 Esc/再登记锁断言，首跑 10/12：读取 API hold 后尚未等待 React commit，立即 isDisabled 断言失败。改为等待 DOM 完成禁用后验证，最终 12/12 全部通过，收款期间 Esc 不关闭、再登记禁用、结果仍在 Vehicles。最终构建/tsc 通过（4238 modules，20.07s）；job pwsh-804c8b21e7ed4574 exit 0。
- 验证为显式隔离 transport：无真实 API、真实支付、MIS/SQL 或设备写入。
- 截图：../vehicle-intake-navigation-20261111/vehicles-created-1440.png、vehicles-created-390.png、cashier-ready-1440.png、cashier-ready-390.png、cashier-success-1440.png、cashier-success-390.png；目录沿用旧回归名，截图为本次重新生成。
- 图像人工检查：390 窗口无横向溢出；表单内容需纵向滚动。亲情撤销失败保留原因与二维码，重试成功后原页显示作废。

## 待统一发布
- 本次仅 Web 源码变动；现有服务端 staff-submit、授权绑定与收费事务保持不变。
- 其他未验标准停车绑定 UI 继续单独验收，不能混入未完成内容直接发布。
