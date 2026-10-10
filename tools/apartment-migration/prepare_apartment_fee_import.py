#!/usr/bin/env python3
"""把公寓旧库 orders CSV 转成 PMS /fees/import JSON。

只导入地址分析结果为 matched 且只有一个 PMS house_id 的订单；其它全部写入拒绝清单。
一张旧订单按收费项目拆成多条 FeeBill，共用原账单号，并用 legacyRef 保证重跑幂等。
"""

from __future__ import annotations

import argparse
import csv
import gzip
import json
from datetime import datetime
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from pathlib import Path
from typing import Mapping, Sequence


FEE_FIELDS = (
    ("electricity", "电费", "电费度数", "度", "电费金额", None, None),
    ("hot_water", "热水费", "热水吨数", "吨", "热水金额", None, None),
    ("cold_water", "冷水费", "冷水吨数", "吨", "冷水金额", None, None),
    ("network", "网费", "网费月数", "月", "网费金额", "网费开始日期", "网费结束日期"),
    ("parking", "停车费", "停车费月数", "月", "停车费金额", "停车开始日期", "停车结束日期"),
    ("rent", "房租", "房租月数", "月", "房租金额", None, None),
    ("management", "管理费", "管理费月数", "月", "管理费金额", None, None),
    ("deposit", "押金", "押金次数", "次", "押金金额", None, None),
)

PAYMENTS = {"微信": "wechat", "支付宝": "alipay", "现金": "cash"}
PRICE_FIELDS = (
    ("electricity", "电费", "electricity", "度"),
    ("cold_water", "冷水费", "coldWater", "吨"),
    ("hot_water", "热水费", "hotWater", "吨"),
    ("network", "网费", "network", "月"),
    ("parking", "停车费", "parking", "月"),
    ("rent", "房租", "rent_fee", "月"),
    ("management", "管理费", "manage_fee", "月"),
    ("deposit", "押金", "deposit_fee", "次"),
)


def read_csv(path: Path):
    opener = gzip.open if path.suffix.lower() == ".gz" else open
    with opener(path, "rt", encoding="utf-8-sig", newline="") as stream:
        return list(csv.DictReader(stream))


def cents(value: object) -> int:
    text = str(value or "").strip()
    if not text:
        return 0
    try:
        return int((Decimal(text) * 100).quantize(Decimal("1"), rounding=ROUND_HALF_UP))
    except InvalidOperation as exc:
        raise ValueError(f"非法金额：{text}") from exc


def number(value: object):
    text = str(value or "").strip()
    return float(Decimal(text)) if text else None


def date_text(value: object):
    text = str(value or "").strip()
    return text[:10] if text else None


def paid_time(row: Mapping[str, str]) -> str:
    value = str(row.get("录入时间") or "").strip()
    if not value:
        raise ValueError("缺少录入时间")
    return value.replace(" ", "T")


def transform(
    mapping_rows: Sequence[Mapping[str, str]],
    order_rows: Sequence[Mapping[str, str]],
    price_rows: Sequence[Mapping[str, str]] = (),
    house_rows: Sequence[Mapping[str, str]] = (),
    broadcast: Mapping[str, str] = {},
):
    addresses = {str(row.get("ID") or "").strip(): row for row in mapping_rows}
    owners = []
    for row in mapping_rows:
        if row.get("match_status") != "matched" or not row.get("house_id"):
            continue
        name = str(row.get("姓名") or "").strip()
        phone = str(row.get("手机号") or "").strip()
        if not name and not phone:
            continue
        owners.append({
            "house": {"houseId": int(row["house_id"])},
            "name": name or None,
            "phone": phone or None,
            "legacyRef": f"apartment:address:{str(row.get('ID') or '').strip()}:owner",
        })
    bills = []
    rejected = []
    for order in order_rows:
        order_id = str(order.get("订单ID") or "").strip()
        address_id = str(order.get("地址ID") or "").strip()
        mapped = addresses.get(address_id)
        if not mapped or mapped.get("match_status") != "matched" or not mapped.get("house_id"):
            rejected.append({"订单ID": order_id, "地址ID": address_id, "原因": "房号未唯一匹配"})
            continue
        try:
            timestamp = paid_time(order)
            period = datetime.fromisoformat(timestamp).strftime("%Y%m")
            created = 0
            for code, name, quantity_field, unit, amount_field, from_field, to_field in FEE_FIELDS:
                amount = cents(order.get(amount_field))
                if amount == 0:
                    continue
                quantity = number(order.get(quantity_field))
                bills.append({
                    "house": {"houseId": int(mapped["house_id"])},
                    "ownerName": mapped.get("姓名") or None,
                    "feeCode": code,
                    "feeName": name,
                    "period": period,
                    "amountCents": amount,
                    "status": "refunded" if str(order.get("红冲") or "0").strip() == "1" else "paid",
                    "paidAt": timestamp,
                    "paymentMethod": PAYMENTS.get(str(order.get("收款方式") or "").strip(), "other"),
                    "receiptNo": order.get("账单号") or f"LEGACY-{order_id}",
                    "cashier": order.get("操作员") or order.get("操作员ID") or None,
                    "refundedAt": timestamp if str(order.get("红冲") or "0").strip() == "1" else None,
                    "remark": order.get("备注") or None,
                    "quantity": quantity,
                    "unit": unit,
                    # 红冲明细的金额为负数，但历史单价仍是正数；负号只由金额表达。
                    "unitPriceCents": abs(round(amount / quantity)) if quantity else None,
                    "serviceFrom": date_text(order.get(from_field)) if from_field else None,
                    "serviceTo": date_text(order.get(to_field)) if to_field else None,
                    "vehiclePlate": order.get("车牌号") or None if code == "parking" else None,
                    "legacyPayload": {"orderId": order_id, "addressId": address_id, "redReversal": order.get("红冲")},
                    "legacyRef": f"apartment:order:{order_id}:{code}",
                })
                created += 1
            if not created:
                rejected.append({"订单ID": order_id, "地址ID": address_id, "原因": "订单没有非零收费项目"})
        except (ValueError, TypeError) as exc:
            rejected.append({"订单ID": order_id, "地址ID": address_id, "原因": str(exc)})
    houses_by_legacy_community = {}
    for row in mapping_rows:
        if row.get("match_status") == "matched" and row.get("house_id"):
            houses_by_legacy_community.setdefault(str(row.get("小区编号") or "").strip(), set()).add(int(row["house_id"]))
    # 旧系统 fee_prices 是「一小区一行单价」。地址表没能唯一匹配的小区（例如吴泾店的房产
    # 来自用户确认的房号清单、不是旧地址表），只能按已确认的社区映射把单价铺到该社区全部
    # 房产；这不是按地址猜房，社区对应关系必须由调用方显式给出。
    for legacy_community, pms_community in broadcast.items():
        target = houses_by_legacy_community.setdefault(legacy_community, set())
        for row in house_rows:
            if str(row.get("community_id") or "").strip() == str(pms_community).strip():
                target.add(int(row["house_id"]))
    standards = []
    for price in price_rows:
        legacy_community = str(price.get("id") or price.get("小区编号") or "").strip()
        effective = date_text(price.get("created_at")) or "2000-01-01"
        for house_id in sorted(houses_by_legacy_community.get(legacy_community, set())):
            for code, name, field, unit in PRICE_FIELDS:
                amount = cents(price.get(field))
                if amount <= 0:
                    continue
                standards.append({
                    "house": {"houseId": house_id}, "feeCode": code, "feeName": name,
                    "amountCents": amount, "standardCents": amount, "effectiveFrom": effective,
                    "status": "active", "remark": f"旧公寓系统社区单价，计费单位：{unit}",
                    "legacyRef": f"apartment:price:{legacy_community}:{house_id}:{code}",
                })
    return {"owners": owners, "standards": standards, "bills": bills}, rejected


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--mapping-csv", type=Path, required=True)
    parser.add_argument("--orders-csv", type=Path, required=True)
    parser.add_argument("--fee-prices-csv", type=Path)
    parser.add_argument("--houses-csv", type=Path, help="PMS 房产清单，至少含 house_id 和 community_id")
    parser.add_argument(
        "--broadcast-community-price",
        action="append",
        default=[],
        metavar="旧小区编号=PMS社区ID",
        help="把该旧小区的单价铺到这个 PMS 社区的全部房产；社区映射必须已在文档中确认",
    )
    parser.add_argument("--output-json", type=Path, required=True)
    parser.add_argument("--rejected-csv", type=Path, required=True)
    args = parser.parse_args()
    broadcast = {}
    for pair in args.broadcast_community_price:
        legacy, _, pms = str(pair).partition("=")
        if not legacy.strip() or not pms.strip():
            raise SystemExit(f"--broadcast-community-price 格式应为 旧小区编号=PMS社区ID，收到：{pair}")
        broadcast[legacy.strip()] = pms.strip()
    if broadcast and not args.houses_csv:
        raise SystemExit("--broadcast-community-price 需要同时提供 --houses-csv")
    payload, rejected = transform(
        read_csv(args.mapping_csv),
        read_csv(args.orders_csv),
        read_csv(args.fee_prices_csv) if args.fee_prices_csv else (),
        read_csv(args.houses_csv) if args.houses_csv else (),
        broadcast,
    )
    args.output_json.parent.mkdir(parents=True, exist_ok=True)
    args.output_json.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    args.rejected_csv.parent.mkdir(parents=True, exist_ok=True)
    with args.rejected_csv.open("w", encoding="utf-8-sig", newline="") as stream:
        writer = csv.DictWriter(stream, fieldnames=["订单ID", "地址ID", "原因"])
        writer.writeheader(); writer.writerows(rejected)
    print(json.dumps({"owners": len(payload["owners"]), "standards": len(payload["standards"]), "bills": len(payload["bills"]), "rejected": len(rejected)}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
