# 车库授权必选车位与共用逻辑（本地开发，未发布）

## 结果
- 调整车库授权：新增勾选二期大车库或二期人防车库，先打开对应档案弹窗；确认有效车位后才勾选。取消/Escape 不新增授权、不关闭父抽屉。
- 新车登记（付费车与亲情车）复用同一弹窗、加载/错误/重试状态与车库依赖函数，不再各自维护输入框和选择逻辑。
- 选择地下车库自动带二期地面；取消二期地面连带取消两个地下车库并清除未选车位号。车位按 main/civil 隔离；重号禁选，不因已有其他车牌而禁选。
- 新增授权协议携带 selectedGarages/garageNumbers/spaceSelection。API 校验目录与访问范围；main 车位写入 parking2.P_Spaces 并在事务中读回，API 也核对读回车位。civil 仍走现有德立云写入及读回，已授权情况下更换车位也会同步。
- 新协议创建、领取均要求助手 >=2.5.55，避免旧助手忽略新字段。旧任务保持原车位；一期不写入大车库/人防车位。
- 失败保留输入；提交后冻结编辑，核对时使用原幂等键，不创建新的逻辑任务。

## 复用审查范围
已检查此次相关的调整授权、新车登记（付费/亲情）、车位目录序列化、二期依赖与车位清理链路。提取的共用代码：
- [车位弹窗和异步加载](../../apps/neighbor-web/src/components/parking/GarageSpacePicker.tsx)
- [车库依赖和车位清理](../../apps/neighbor-web/src/lib/garage-selection.ts)
- [目录序列化、自然排序、按库重号与选择校验](../../apps/api/src/modules/business/parking-space-choices.ts)
不同入口的权限、保存接口、收费/审核流程及现场任务执行仍保留原有业务边界，不把不相同的流程强行合并；未进行全仓库无差别重构。

## 验证证据
- `pnpm --filter @pms/neighbor-web build`：类型检查与生产构建通过（现有大分块警告）。
- `pnpm --filter @pms/api build`：通过。
- `pnpm --filter @pms/api exec node -r ts-node/register --test src/modules/business/parking-space-choices.test.ts`：3/3 通过，覆盖目录隔离、重号、无效车位、访问范围与助手版本门禁。
- .NET MSBuild Release + `Pms.DataSyncAssistant.V2.exe --self-test`：exit 0。新增 main/civil 隔离、旧任务保持、非 main 不写、空值及 GBK 字节超限保护断言。环境仍有 .NET4 Targeting Pack 缺失回退 GAC 与既有重复 using 警告。
- [真实组件浏览器结果](verification.json)：正式车辆管理入口、登记实际组件；受控传输，无生产连接。覆盖桌面1440/窄屏375、取消/Escape、来源隔离、确认必选、依赖清理、空目录、错误重试、等待锁定、失败保留与原任务复用、已授权人防换号。
- [窄屏选定授权](adjust-selected-375.png)、[读取等待](loading-375.png)、[读取失败](read-error-375.png)、[执行等待](waiting-375.png)、[执行失败保留](failed-375.png)。

## 未验证/剩余风险
- 未发布生产，现场助手未升级。以后上线须同步 Web/API 并安装助手2.5.55；仅发布更新包不等于现场完成升级。
- 浏览器使用明确受控接口，不证明现场 SQL Server、德立云或道闸设备已真实生效。本轮未做生产数据库写入、车位档案变更、收费或真实进出场验证。
- 旧库一期/二期及德立云不是分布式事务，跨系统部分成功仍可能发生；此时保留原任务与结果，不能把失败回执当作全部回滚。
