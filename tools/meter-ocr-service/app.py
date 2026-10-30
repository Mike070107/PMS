#!/usr/bin/env python3
"""
抄表 OCR 边车服务（自托管，不依赖外部账号）。

为什么单独起一个 Python 服务，而不是在 Node 里做：
- RapidOCR（PaddleOCR 的 ONNX 推理版）在中文/数字场景开箱即用，模型随包分发，
  不联网、不按次计费；Node 侧没有同等成熟的离线 OCR 运行时。
- 它只暴露一个 POST /ocr，绑定 127.0.0.1，由 PMS API 调用，不直接对公网开放。

接口：
  GET  /health  -> {"ok": true, "engine": "rapidocr", "version": "..."}
  POST /ocr     -> {"ok": true, "items": [{"text": "...", "score": 0.93, "box": [x1,y1,x2,y2]}],
                    "width": 1536, "height": 2730, "elapsedMs": 1234, "enhanced": false}

POST 请求体：
  {
    "image": "<base64 jpeg/png>",
    "crop": {"x":0.1,"y":0.2,"w":0.8,"h":0.1},   # 可选，0~1 归一化
    "enhance": false                               # 可选，灰度+CLAHE，反光/脏污时再试一次
  }

启动：
  pip install -r requirements.txt
  python app.py
环境变量：
  METER_OCR_HOST   默认 127.0.0.1
  METER_OCR_PORT   默认 8100
  METER_OCR_TOKEN  可选；设置后所有请求必须带 x-meter-ocr-token 头
"""

from __future__ import annotations

import base64
import json
import os
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

import cv2
import numpy as np
from rapidocr_onnxruntime import RapidOCR

HOST = os.environ.get("METER_OCR_HOST", "127.0.0.1")
PORT = int(os.environ.get("METER_OCR_PORT", "8100"))
TOKEN = os.environ.get("METER_OCR_TOKEN", "").strip()
MAX_BODY = 40 * 1024 * 1024

ENGINE = RapidOCR()
ENGINE_LOCK = threading.Lock()
VERSION = "1.0.0"


def read_image(payload: dict[str, Any]) -> np.ndarray:
    raw = str(payload.get("image") or "")
    if not raw:
        raise ValueError("image is required")
    if raw.startswith("data:"):
        raw = raw.split(",", 1)[-1]
    try:
        data = base64.b64decode(raw, validate=False)
    except Exception as exc:  # noqa: BLE001
        raise ValueError("image base64 invalid") from exc
    if not data:
        raise ValueError("image is empty")
    image = cv2.imdecode(np.frombuffer(data, dtype=np.uint8), cv2.IMREAD_COLOR)
    if image is None:
        raise ValueError("cannot decode image (only jpeg/png/webp supported)")
    return image


def apply_crop(image: np.ndarray, crop: dict[str, Any] | None) -> np.ndarray:
    if not crop:
        return image
    height, width = image.shape[:2]
    try:
        x = float(crop.get("x", 0))
        y = float(crop.get("y", 0))
        w = float(crop.get("w", 1))
        h = float(crop.get("h", 1))
    except (TypeError, ValueError) as exc:
        raise ValueError("crop must be numbers") from exc
    if not (0 <= x < 1 and 0 <= y < 1 and 0.01 <= w <= 1 and 0.01 <= h <= 1):
        raise ValueError("crop out of range")
    x1, y1 = int(x * width), int(y * height)
    x2, y2 = int(min(1, x + w) * width), int(min(1, y + h) * height)
    if x2 - x1 < 16 or y2 - y1 < 16:
        raise ValueError("crop too small")
    return image[y1:y2, x1:x2]


def enhance(image: np.ndarray) -> np.ndarray:
    """灰度 + 局部对比度。只用于原图没读出数时的第二遍，不改变颜色语义。"""
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8))
    return cv2.cvtColor(clahe.apply(gray), cv2.COLOR_GRAY2BGR)


def maybe_upscale(image: np.ndarray) -> tuple[np.ndarray, float]:
    """小图放大再识别；大图保持原样，避免 4K 照片推理过慢。"""
    height, width = image.shape[:2]
    longest = max(height, width)
    if longest >= 1600:
        return image, 1.0
    scale = min(4.0, 1600.0 / max(1, longest))
    if scale <= 1.05:
        return image, 1.0
    resized = cv2.resize(image, (int(width * scale), int(height * scale)), interpolation=cv2.INTER_CUBIC)
    return resized, scale


def run_ocr(image: np.ndarray) -> list[dict[str, Any]]:
    prepared, scale = maybe_upscale(image)
    with ENGINE_LOCK:
        result, _ = ENGINE(prepared)
    items: list[dict[str, Any]] = []
    for entry in result or []:
        try:
            points, text, score = entry
        except (TypeError, ValueError):
            continue
        text = str(text or "").strip()
        if not text:
            continue
        xs = [float(point[0]) / scale for point in points]
        ys = [float(point[1]) / scale for point in points]
        items.append(
            {
                "text": text,
                "score": round(float(score), 4),
                "box": [round(min(xs), 1), round(min(ys), 1), round(max(xs), 1), round(max(ys), 1)],
            }
        )
    return items


def rotate_image(image: np.ndarray, angle: int) -> np.ndarray:
    if angle == 90:
        return cv2.rotate(image, cv2.ROTATE_90_CLOCKWISE)
    if angle == 180:
        return cv2.rotate(image, cv2.ROTATE_180)
    if angle == 270:
        return cv2.rotate(image, cv2.ROTATE_90_COUNTERCLOCKWISE)
    return image


def map_box_to_original(box: list[float], angle: int, width: int, height: int) -> list[float]:
    """把旋转后图上的框映射回原图坐标，红框和后台复核都按原图显示。"""
    x1, y1, x2, y2 = box
    points = [(x1, y1), (x2, y1), (x2, y2), (x1, y2)]
    mapped: list[tuple[float, float]] = []
    for x, y in points:
        if angle == 90:
            ox, oy = y, height - 1 - x
        elif angle == 180:
            ox, oy = width - 1 - x, height - 1 - y
        elif angle == 270:
            ox, oy = width - 1 - y, x
        else:
            ox, oy = x, y
        mapped.append((min(max(ox, 0), width - 1), min(max(oy, 0), height - 1)))
    xs = [p[0] for p in mapped]
    ys = [p[1] for p in mapped]
    return [round(min(xs), 1), round(min(ys), 1), round(max(xs), 1), round(max(ys), 1)]


def recognize_rotations(image: np.ndarray) -> list[dict[str, Any]]:
    height, width = image.shape[:2]
    variants: list[dict[str, Any]] = []
    for angle in (0, 90, 270, 180):
        started = time.time()
        rotated = rotate_image(image, angle)
        items = run_ocr(rotated)
        for item in items:
            item["box"] = map_box_to_original(item["box"], angle, width, height)
        variants.append(
            {
                "orientation": angle,
                "items": items,
                "elapsedMs": int((time.time() - started) * 1000),
            }
        )
    return variants


class Handler(BaseHTTPRequestHandler):
    server_version = f"MeterOcr/{VERSION}"

    def log_message(self, fmt: str, *args: Any) -> None:  # noqa: A003
        # 默认日志会把每张图的请求打到 stderr，生产交给 journald 足够了
        print(f"{self.address_string()} - {fmt % args}", flush=True)

    def _authorized(self) -> bool:
        if not TOKEN:
            return True
        return self.headers.get("x-meter-ocr-token", "") == TOKEN

    def _send(self, status: int, body: dict[str, Any]) -> None:
        data = json.dumps(body, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self) -> None:  # noqa: N802
        if self.path.split("?")[0] != "/health":
            self._send(404, {"ok": False, "error": "not found"})
            return
        if not self._authorized():
            self._send(401, {"ok": False, "error": "unauthorized"})
            return
        self._send(200, {"ok": True, "engine": "rapidocr", "version": VERSION})

    def do_POST(self) -> None:  # noqa: N802
        if self.path.split("?")[0] != "/ocr":
            self._send(404, {"ok": False, "error": "not found"})
            return
        if not self._authorized():
            self._send(401, {"ok": False, "error": "unauthorized"})
            return
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0 or length > MAX_BODY:
            self._send(413, {"ok": False, "error": "body too large"})
            return
        started = time.time()
        try:
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
            if not isinstance(payload, dict):
                raise ValueError("body must be JSON object")
            image = read_image(payload)
            image = apply_crop(image, payload.get("crop"))
            if bool(payload.get("enhance")):
                image = enhance(image)
            height, width = image.shape[:2]
            auto_rotate = bool(payload.get("autoRotate"))
            if auto_rotate:
                variants = recognize_rotations(image)
                self._send(
                    200,
                    {
                        "ok": True,
                        "variants": variants,
                        "width": width,
                        "height": height,
                        "elapsedMs": int((time.time() - started) * 1000),
                        "autoRotate": True,
                    },
                )
            else:
                items = run_ocr(image)
                self._send(
                    200,
                    {
                        "ok": True,
                        "items": items,
                        "width": width,
                        "height": height,
                        "elapsedMs": int((time.time() - started) * 1000),
                        "orientation": 0,
                        "enhanced": bool(payload.get("enhance")),
                    },
                )
        except ValueError as exc:
            self._send(400, {"ok": False, "error": str(exc)})
        except Exception as exc:  # noqa: BLE001
            self._send(500, {"ok": False, "error": f"{type(exc).__name__}: {exc}"})


if __name__ == "__main__":
    print(f"meter-ocr listening on http://{HOST}:{PORT} (token={'yes' if TOKEN else 'no'})", flush=True)
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
