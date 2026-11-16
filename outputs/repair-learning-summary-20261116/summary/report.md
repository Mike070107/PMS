# 完工小结开关：交付与验收

## 结果
- 已完成：员工小程序正式工单详情入口新增常驻「AI 自动总结」开关，首次默认 OFF；按本机 tenantId:userId 保存，不串租户/账号。未取得身份时禁用开关，存储读失败安全回落 OFF，写失败提示仅本次生效。
- 已完成：语音识别立即追加原文，不 trim/改写已有人工说明；OFF 0 次 AI 请求；手工打字不触发 AI。
- 已完成：ON 仅显示候选（说明/故障/收费/用料提醒），明确「采用整理」后才替换本次语音并仅补充空白故障/收费字段；用料不自动建行、不扣库。用户可「保留原文」。
- 已完成：关闭、人工编辑、常用话术编辑、关面板、卸载和提交均失效化在途候选；新请求不被旧回调覆盖。关闭后重开，旧录音迟到只保留原文，不启动 AI。
- 已完成：AI 失败保留原文、允许重试且不重复追加；正式 onComplete 的保存 payload 使用当前所选文本，未采用 AI 不写 aiAssist trace。
- 已完成：Web 全应用调查无 completionSummary 调用，不新增平行入口；API 已为不保存业务字段的草稿接口，本次无需改 API。
- 未执行（明确边界）：微信开发者工具原生编译/原生界面/真机录音、真实 API/数据库保存后刷新读取、设备确认。此轮按 lead 限制没有构建上传、提交、推送、生产访问。

## 证据与精确复跑命令
```powershell
node --test apps/miniapp-staff/test/completion-summary.test.cjs
node apps/api/node_modules/typescript/bin/tsc --noEmit -p apps/miniapp-staff/tsconfig.json --typeRoots node_modules/.pnpm/miniprogram-api-typings@3.12.0/node_modules
node outputs/repair-learning-summary-20261116/summary/browser.cjs
git diff --check
```
- 先红灯：修改前 8/8 失败，正式 speech.onStop 默认触发 1 次 AI（预期 0），[before-tests.txt](<before-tests.txt>)。
- 最终绿灯：真实生产 Page 代码经 TypeScript 转译的 VM harness，模拟 SDK/API 边界，**14/14**；[after-tests.txt](<after-tests.txt>)。覆盖语音/两状态/账号隔离/新实例恢复/人工编辑/失败重试/候选采用保护/关闭/卸载/存储异常/正式提交 payload/并发请求/关闭后重开旧录音。
- 整个员工 miniapp noEmit **exit 0**，输出文件无诊断：[typecheck.txt](<typecheck.txt>)。员工目录没有安装 TS/typing 链接，复用本 worktree 已安装 API TypeScript 和 pnpm typings；没有修改依赖文件。
- 浏览器真实点击：**passed=true、pageErrors=[]**，[browser-result.json](<browser-result.json>)。使用正式 WXML 摘录＋正式 WXSS（rpx→px）＋正式 Page VM，不是独立重写业务逻辑；SDK/AI/存储仍是合成边界。浏览器页面刷新验证当前视图，跨新 Page 偏好恢复另由第 5 个 VM 用例验证。
- 浏览器覆盖默认 OFF 零调用、ON、等待、失败、重试、原文不变、保留原文、显式采用、页面刷新、1440/390/320 宽度。已目视检查 [候选](<narrow-preview.png>)、[错误](<narrow-error.png>)、[桌面](<desktop-on.png>)、[320宽度关闭](<small-off.png>)。开关在浏览器中用 checkbox 表达，**不冒充微信原生 switch 效果**。
- 范围最终 diff 已审查，`git diff --check` 通过；[tested-source-hashes.json](<tested-source-hashes.json>) 为已测五个源码文件哈希。
- 中间失败如实保留：最初本地 TS/typings 路径未链接导致无法启动；浏览器先因 playwright 包名（应 playwright-core）、异步重试边界被服务器 await、断言误匹配 script 文本失败。均已修正验证脚本，最终退出 0；`browser-failure.*` 为调试留存，不是最终结果。

## 写入范围
- [order-detail.ts](<../../../apps/miniapp-staff/miniprogram/pages/order-detail/order-detail.ts>)、[order-detail.wxml](<../../../apps/miniapp-staff/miniprogram/pages/order-detail/order-detail.wxml>)、[order-detail.wxss](<../../../apps/miniapp-staff/miniprogram/pages/order-detail/order-detail.wxss>)。
- [completion-summary.ts](<../../../apps/miniapp-staff/miniprogram/utils/completion-summary.ts>)、[completion-summary.test.cjs](<../../../apps/miniapp-staff/test/completion-summary.test.cjs>)。
- 仅本 evidence 目录；没有碰 lead 的三处 API 写入范围。

## 新读取文件（供 lead 集成追踪）
- [session.ts](<../../../apps/miniapp-staff/miniprogram/utils/session.ts>)、[guide.ts](<../../../apps/miniapp-staff/miniprogram/utils/guide.ts>)、[员工 package.json](<../../../apps/miniapp-staff/package.json>)、[shared-types](<../../../packages/shared-types/src/index.ts>)。
- [ai 客户端](<../../../packages/api-client/src/endpoints/ai.ts>)、[ai-tools.controller.ts](<../../../apps/api/src/modules/ai/ai-tools.controller.ts>)、[既有 Page VM 测试](<../../../apps/miniapp-staff/test/material-draft-transport.test.cjs>)。
- [小程序设计](<../../../design-system/pms-miniapp/MASTER.md>)、[项目约定](<../../../CLAUDE.md>)；详情三个正式文件与本次新 utility/test；[既有浏览器 fixture](<../../repair-intake-timeline-20261116/browser/browser.test.cjs>) 仅用于确认 playwright-core 入口。

## 剩余风险
- 本机偏好不做跨设备同步；清理微信缓存后恢复默认 OFF，符合此次选择。
- 已发出的 AI HTTP 请求不做网络级取消；关闭后结果必定失效，不再写回页面或保存 payload。
- 仍需 lead 集成后安排微信原生编译/真机语音和真实测试环境保存/刷新读回。页面 VM/API payload、浏览器摘录通过不代表微信原生/真实数据库链路已通过。
