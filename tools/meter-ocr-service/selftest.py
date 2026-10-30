#!/usr/bin/env python3
"""调本地 OCR 边车识别一张表照片，打印文字框。用法：python selftest.py meter.jpg"""

from __future__ import annotations

import base64
import json
import os
import sys
import urllib.request

URL = os.environ.get("METER_OCR_URL", "http://127.0.0.1:8100/ocr")
TOKEN = os.environ.get("METER_OCR_TOKEN", "").strip()


def main() -> int:
    if len(sys.argv) < 2:
        print("用法：python selftest.py <表照片路径>")
        return 2
    path = sys.argv[1]
    with open(path, "rb") as fh:
        image = base64.b64encode(fh.read()).decode("ascii")
    body = json.dumps({"image": image, "enhance": False}).encode("utf-8")
    request = urllib.request.Request(URL, data=body, method="POST")
    request.add_header("Content-Type", "application/json")
    if TOKEN:
        request.add_header("x-meter-ocr-token", TOKEN)
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            data = json.loads(response.read().decode("utf-8"))
    except Exception as exc:  # noqa: BLE001
        print(f"请求失败：{exc}")
        return 1
    if not data.get("ok"):
        print(f"识别失败：{data.get('error')}")
        return 1
    print(f"{data.get('width')}x{data.get('height')}  {data.get('elapsedMs')}ms")
    for item in data.get("items", []):
        print(f"{item.get('score', 0):.3f}  {item.get('text')}  {item.get('box')}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
