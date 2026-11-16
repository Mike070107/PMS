# 红灯及修复因果
- 正式发布第六次 [transcript:224–258](<../../publish-attempt6-transcript.txt#L224-L258>)：3 个浏览器用例，2 pass / 1 fail。
- esbuild 明确警告 IIFE 中 import.meta 为空；正式 upload.ts:3 访问 `import.meta.env.VITE_API_BASE_URL` 抛 TypeError，页面未挂载，随后联系人按钮等待超时。不是删断言可解决的 UI 或 API 问题。
- 测试已有 BASE_URL、VITE_LEGACY_BASE 两个 define，缺 VITE_API_BASE_URL。邻近 apartment-reconciliation-browser 与 access-browser 已 define '/api/v1'。
- 唯一源码改动：本测试 esbuild define 追加 `import.meta.env.VITE_API_BASE_URL: '"/api/v1"'`，与正式 Vite API 路径一致；正式业务源码与所有浏览器业务断言保留。
- 原始红证据直接引用已发生的正式失败；无需重复已知失败浪费发布时间。绿证据另保存真实测试输出，不由 mock-only 编译代替。
