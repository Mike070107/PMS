# task-49：联系人浏览器门禁转绿

## 结果
已完成唯一字段修复：测试 esbuild define 追加 `import.meta.env.VITE_API_BASE_URL: '"/api/v1"'`。没有改正式业务 src、API adapter、权限 mock、等待时间、断言或证据目录。未 commit/push/生产连接。

## 红 → 绿证据
- 红：正式 attempt6 transcript 224–258 行，整体 2/3，失败用例明确为 upload.ts:3 的未定义 import.meta.env.VITE_API_BASE_URL，导致应用不挂载，再联系人按钮超时。已先于本次运行保全 [before-failure.json](<before-failure.json>) / [before-failure.png](<before-failure.png>)。
- 绿：`node --test apps/neighbor-web/test/business-owner-contact-browser.test.cjs`，**1/1 pass、0 fail、退出 0、7.3s**：[after-tests.txt](<after-tests.txt>)。
- [after-verification.json](<after-verification.json>)：cashier、apartment、vehicles、vehicle-existing、renew 五个正式入口均进入联系人区域；打开不写；只确认所选电话；每入口一次联系人 PATCH；来源 cashier/parking 正确；其它业务写入 0；收费/设备动作 0；pageErrors=[]。
- 截图全部从本次实际测试原输出复制，非旧产物：[收银](<cashier-contacts.png>)、[公寓](<apartment-contacts.png>)、[新车](<vehicles-contacts.png>)、[已存车牌](<vehicle-existing-contacts.png>)、[续费](<renew-contacts.png>)。已目视收银/已存车牌截图，无缺组件或错误页。
- 最终 [change.diff](<change.diff>) 仅一个 define 属性，1 行替换；所有真实业务 assert 保持原样；`git diff --check -- apps/neighbor-web/test/business-owner-contact-browser.test.cjs` 通过。[tested-file-hash.json](<tested-file-hash.json>) 固定本次已测文件身份。

## 剩余风险与下一步
真实 Chrome + 正式组件，但 API/auth 是测试中原有合成边界；不代表真实数据库、支付或设备验收。本轮只重跑原来失败的一个浏览器用例；另外两个在 attempt6 已过，最终完整发布门禁仍应由 lead 集成提交推送后重走，不能用单测成功跳过。本次没有部署，task-48 公网/SSH 后验仍待正式上线完成通知。
