# 抄表 OCR 边车（自托管）

PMS 抄表模块的读数识别服务。它只做一件事：把一张水表/电表照片 OCR 成带坐标的文字框，交给
API 的 `MeterOcrService` 解析读数与表号。

- 引擎：RapidOCR（PaddleOCR 的 ONNX 推理版），模型随 pip 包分发，**不联网、不按次计费**
- 端口：默认 `127.0.0.1:8100`，只给同机 PMS API 调用，不对公网开放
- 依赖：Python 3.10+、约 300~500MB 内存、单核 CPU 即可；首次启动加载模型约 2~5 秒

## 为什么不在 Node 里直接做

Node 侧没有成熟的离线中文 OCR 运行时。RapidOCR 的检测/识别模型对印刷数字、液晶七段数字和
机械字轮都能读，且模型随包分发，适合物业这种「一天几十张、不想按次付费、数据不出服务器」的场景。

识别结果**不会直接入账**：API 会把读数回填到小程序输入框，抄表员对着原图确认后才提交；
原图、识别原文、人工确认值三者都留档。这是准确率的最后一道保险。

## 安装（Ubuntu 22.04/24.04）

```bash
# 1. 独立系统用户，别用 root 跑
sudo useradd --system --no-create-home --shell /usr/sbin/nologin pmsmeter

# 2. 代码与虚拟环境
sudo mkdir -p /opt/meter-ocr
sudo cp app.py requirements.txt /opt/meter-ocr/
sudo python3 -m venv /opt/meter-ocr/venv
sudo /opt/meter-ocr/venv/bin/pip install --upgrade pip
sudo /opt/meter-ocr/venv/bin/pip install -r /opt/meter-ocr/requirements.txt

# 3. 配置（可选 token；生产建议设置）
sudo mkdir -p /etc/pms
sudo tee /etc/pms/meter-ocr.env >/dev/null <<'EOF'
METER_OCR_HOST=127.0.0.1
METER_OCR_PORT=8100
METER_OCR_TOKEN=换成一串随机字符
EOF
sudo chmod 600 /etc/pms/meter-ocr.env

# 4. systemd
sudo cp meter-ocr.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now meter-ocr
sudo systemctl status meter-ocr --no-pager

# 5. 自检
curl -s http://127.0.0.1:8100/health
# {"ok": true, "engine": "rapidocr", "version": "1.0.0"}
```

`app.py` 需要能读 `/opt/meter-ocr`，`pmsmeter` 用户对该目录只需读权限；venv 里的文件默认即可。
如果使用 `ProtectSystem=strict`，unit 已把 `/tmp` 设为可写，足够 OpenCV/onnxruntime 使用。

## 接到 PMS API

在 `apps/api/.env`（生产是部署目录的 `.env`）加：

```env
METER_OCR_URL=http://127.0.0.1:8100/ocr
METER_OCR_TOKEN=与 /etc/pms/meter-ocr.env 里一致
```

重启 API 后，后台「抄表管理」页顶部不再显示「识别服务未连接」。没有配置或服务挂掉时，
抄表仍可手工输入读数并保留原图，不影响记账 —— 识别失败不是业务失败。

## 自检脚本

```bash
# 用一张真实表照片调本地服务，打印每个文字框
/opt/meter-ocr/venv/bin/python selftest.py /path/to/meter.jpg
```

2026-10-30 用两张现场照片实测（1536×2730，未裁剪）：

| 照片 | OCR 原文 | 解析结果 |
| --- | --- | --- |
| 水表（机械字轮） | `02405m` | 读数 `02405`，表号无（表壳上本来就没印） |
| 电表（液晶屏） | `0224 1888`、`20054564` | 读数 `02241888` → 按 6 位整数 + 2 位小数补点 = `22418.88`；表号 `20054564` |

电表的小数点在照片里几乎看不见，OCR 会把 `0224` 和 `1888` 读成两个框。这正是仪表档案要填
「整数位/小数位」的原因：服务端按位补小数点，不靠模型猜。**建档时位数填错，读数就会差 100 倍**，
所以后台表单把这两个字段放在表号旁边。

## 识别率与现场注意事项

- 拍摄时把读数窗口放在取景框中间，避开反光；电表液晶屏建议关闪光或斜一点拍。
- 水表字轮有灰尘时，先擦一下玻璃；照片里 `02405` 的置信度只有 0.73，但位数规则能把它选出来。
- 表号是印刷体时通常能读（电表 `20054564`），水表表壳没印编号时不会硬猜。
- 抄表页始终显示原图与识别原文，读数输入框可改；低置信度、表号不一致、用量突增都会在后台标红。
- `/ocr` 支持 `rotate`（0/90/180/270）：单方向识别并把框映射回原图。API 先跑 0°，读出且位数匹配就停；
  不行才依次试 90/270/180，常见照片约 2~3 秒，侧装/反光照片最多约 6~8 秒。
  只覆盖 90° 倍数，拍歪 15° 这类仍需倾斜矫正或视觉模型。

## 运维

```bash
sudo systemctl restart meter-ocr
sudo journalctl -u meter-ocr -n 100 --no-pager
```

升级依赖：先备份 `/opt/meter-ocr/venv`，再 `pip install -U -r requirements.txt`，重启并跑一次
`selftest.py`。`requirements.txt` 锁了 RapidOCR 大版本，避免模型/接口漂移。

## 安全边界

- 只绑定 `127.0.0.1`；不要改成 `0.0.0.0`，也不要加 Nginx 反代到公网。
- 设置 `METER_OCR_TOKEN` 后，所有请求必须带 `x-meter-ocr-token`；API 侧从环境变量读取，不进日志。
- 请求体上限 40MB，超出直接 413；不会把图片写到磁盘。
