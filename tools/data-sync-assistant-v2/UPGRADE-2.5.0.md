# PMS 数据同步助手 2.5.0

2.5.0 起右上角“检查更新”支持一键检查、下载和安全替换程序。

## 客户操作

1. 打开助手，点击右上角“检查更新”。
2. 发现新版本后确认安装，等待助手自动重启。
3. 不需要重新输入代理 ID、一次性密钥、数据库密码或连接路径。

更新器会校验 HTTPS 清单中的 SHA-256，停止后台服务，备份旧 EXE 为 `.previous`，替换后重启并保留配置。下载失败、校验失败或替换失败不会删除配置；替换失败会尝试恢复上一版。

## 发布方配置

默认清单地址：`https://prsznh.cn/downloads/pms-data-sync-assistant/latest.json`。清单格式见 `update-manifest.example.json`，必须和对应 EXE 一起通过 HTTPS 发布。
