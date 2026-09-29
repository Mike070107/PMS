# 0.1.4 更新说明

把压缩包内的 `Pms.AccessCardAgent.exe` 覆盖到现有代理目录即可。

- 不要删除或覆盖现有 `agent.config.json`。
- 不要删除 `legacy-db-password.dat`、`iccard-db-password.dat` 或 `agent.token.dat`。
- `.80`、`.88` 使用同一个更新程序；原配置决定该电脑的身份。
- 更新后先运行 `--self-test`。PMS 接口部署并在网页注册代理后，再运行网页显示的 `--install-agent <代理ID>` 和 `--connect-test`。

本版本显式使用 TLS 1.2 连接 PMS。卡片、SQL、MDB 和控制器真实写入仍保持关闭，只开放代理注册、心跳和已验收的只读查询能力。
