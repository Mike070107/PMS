# 0.1.5 更新说明

- 修复旧版 Windows PowerShell 隐藏输入时无法粘贴长密钥的问题。
- 更新时只覆盖 `Pms.AccessCardAgent.exe`，保留原目录中的 `agent.config.json` 和所有 `*.dat` 文件。
- 安装代理时先在网页复制一次性密钥，然后用 PowerShell 管道安入：

```powershell
Get-Clipboard | .\Pms.AccessCardAgent.exe --install-agent <网页显示的代理ID>
```

密钥不会显示在终端，也不会进入 PowerShell 历史。
