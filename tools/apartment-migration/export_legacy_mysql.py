#!/usr/bin/env python3
"""Export the legacy apartment tables through a read-only MySQL session.

The connection password is loaded from the supplied legacy config module and is
never accepted on the command line or written to the export manifest.
"""

from __future__ import annotations

import argparse
import csv
import gzip
import hashlib
import importlib.util
import json
from datetime import date, datetime
from decimal import Decimal
from pathlib import Path

import pymysql


TABLES = ("addresses", "orders", "fee_prices")
MONEY_COLUMNS = (
    "收款金额",
    "退款金额",
    "电费金额",
    "热水金额",
    "冷水金额",
    "网费金额",
    "停车费金额",
    "房租金额",
    "管理费金额",
    "押金金额",
)


def load_config(path: Path):
    spec = importlib.util.spec_from_file_location("legacy_apartment_config", path)
    if not spec or not spec.loader:
        raise RuntimeError("无法读取旧系统数据库配置")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.Config


def csv_value(value):
    if value is None:
        return ""
    if isinstance(value, (datetime, date)):
        return value.isoformat(sep=" ") if isinstance(value, datetime) else value.isoformat()
    return str(value)


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def export_table(cursor, table: str, output_dir: Path):
    cursor.execute(f"SELECT * FROM `{table}` ORDER BY 1")
    columns = [item[0] for item in cursor.description]
    output_path = output_dir / f"{table}.csv.gz"
    count = 0
    totals = {name: Decimal("0") for name in MONEY_COLUMNS if name in columns}
    red_reversals = 0
    with gzip.open(output_path, "wt", encoding="utf-8-sig", newline="") as stream:
        writer = csv.writer(stream)
        writer.writerow(columns)
        while True:
            rows = cursor.fetchmany(1000)
            if not rows:
                break
            for row in rows:
                writer.writerow([csv_value(value) for value in row])
                count += 1
                data = dict(zip(columns, row))
                for name in totals:
                    totals[name] += Decimal(str(data.get(name) or 0))
                if str(data.get("红冲") or "0") == "1":
                    red_reversals += 1
    return {
        "file": output_path.name,
        "rows": count,
        "sha256": sha256(output_path),
        "moneyTotals": {name: str(value.quantize(Decimal("0.01"))) for name, value in totals.items()},
        "redReversals": red_reversals if "红冲" in columns else None,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    args = parser.parse_args()

    config = load_config(args.config)
    args.output_dir.mkdir(parents=True, exist_ok=True)
    connection = pymysql.connect(
        host=args.host,
        port=args.port,
        user=config.DB_USER,
        password=config.DB_PASSWORD,
        database=config.DB_NAME,
        charset="utf8mb4",
        autocommit=True,
        connect_timeout=10,
        read_timeout=120,
    )
    try:
        with connection.cursor() as cursor:
            cursor.execute("SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ")
            cursor.execute("SET TRANSACTION READ ONLY")
            cursor.execute("START TRANSACTION WITH CONSISTENT SNAPSHOT")
            tables = {table: export_table(cursor, table, args.output_dir) for table in TABLES}
            connection.rollback()
    finally:
        connection.close()

    manifest = {
        "exportedAt": datetime.now().astimezone().isoformat(timespec="seconds"),
        "mode": "read-only consistent snapshot",
        "database": config.DB_NAME,
        "tables": tables,
    }
    manifest_path = args.output_dir / "manifest.json"
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(manifest, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
