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
from typing import Mapping, Sequence, Tuple


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

# 旧库里有些「地址」其实是按月结算的台账，不是某一间房的收费明细：
# 颛桥店「停车结算/安乐村」每月记一笔，备注里写「月租车N辆X，临时车M辆Y，合计Z」。
# 一张单就是一笔明细，一对一落一行，既不合并也不拆：
#   - 不合并：11 张单就是 11 笔明细，各自有自己的收据号。
#   - 不拆：备注里那段车辆拆分是汇总说明，不能据此编造每辆车的明细行，
#     也不填数量和单价（旧库那里的「停车费月数」写的是 16、19 这种台账流水号，
#     不是真实月数，拿来算单价就是假数据）。
# 用单独的费用代码只为了在报表里和各户的「停车费」分开，不是把它当汇总行。
# 键是 (旧小区编号, 旧楼栋号)，必须逐条人工确认后登记，不做模糊判断。
SETTLEMENT_LEDGERS: Mapping[Tuple[str, str], Tuple[str, str]] = {
    ("2", "停车结算"): ("parking_settle", "停车结算"),
}

# 旧库 orders 只存「操作员ID」，导出的三张表里没有操作员姓名表，直接落库会让界面的
# 「收费员」显示成裸 id（7）。2026-10-11 用户指定了每店对应的 PMS 人员，按店绑定姓名；
# 旧库的操作员 ID 仍留在 legacyPayload 里，可追溯。键是旧小区编号。
CASHIER_BY_LEGACY_COMMUNITY: Mapping[str, str] = {
    "1": "陈莉莉",   # 吴泾店 → PMS 员工 7891
    "2": "华新",     # 颛桥店 → PMS 员工 7888
    "5": "陈莉莉",   # 旧库“吴泾老家”实际为吴泾一村，用户确认 → PMS 员工 7891
}

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
            red_reversal = str(order.get("红冲") or "0").strip() == "1"

            def base_bill(code: str, name: str, amount: int) -> dict:
                # 旧库记退费有两种写法：红冲标记，和直接记一笔负数的【退费】单。
                # 两者是同一件事，统一按 refunded 落库；对账的退款额按金额正负算，不会重复计。
                refunded = red_reversal or amount < 0
                return {
                    "house": {"houseId": int(mapped["house_id"])},
                    "ownerName": mapped.get("姓名") or None,
                    "feeCode": code,
                    "feeName": name,
                    "period": period,
                    "amountCents": amount,
                    "status": "refunded" if refunded else "paid",
                    "paidAt": timestamp,
                    "paymentMethod": PAYMENTS.get(str(order.get("收款方式") or "").strip(), "other"),
                    "receiptNo": order.get("账单号") or f"LEGACY-{order_id}",
                    "cashier": CASHIER_BY_LEGACY_COMMUNITY.get(
                        str(mapped.get("小区编号") or "").strip()
                    ) or order.get("操作员") or None,
                    "refundedAt": timestamp if refunded else None,
                    "remark": order.get("备注") or None,
                    "legacyPayload": {
                        "orderId": order_id, "addressId": address_id,
                        "redReversal": order.get("红冲"),
                        "legacyOperatorId": order.get("操作员ID") or None,
                    },
                    "legacyRef": f"apartment:order:{order_id}:{code}",
                }

            ledger = SETTLEMENT_LEDGERS.get((
                str(mapped.get("小区编号") or "").strip(),
                str(mapped.get("楼栋号") or "").strip(),
            ))
            if ledger:
                code, name = ledger
                total = cents(order.get("收款金额"))
                detail = sum(cents(order.get(field[4])) for field in FEE_FIELDS)
                # 汇总台账只认实收总额。万一旧库的明细列和总额对不上，宁可拒绝也不猜。
                if total != detail:
                    rejected.append({"订单ID": order_id, "地址ID": address_id,
                                     "原因": f"汇总台账总额{total}与明细合计{detail}不一致"})
                    continue
                if total == 0:
                    rejected.append({"订单ID": order_id, "地址ID": address_id, "原因": "订单没有非零收费项目"})
                    continue
                bills.append({
                    **base_bill(code, name, total),
                    "quantity": None, "unit": None, "unitPriceCents": None,
                    "serviceFrom": date_text(order.get("停车开始日期")),
                    "serviceTo": date_text(order.get("停车结束日期")),
                    "vehiclePlate": None,
                })
                continue

            created = 0
            for code, name, quantity_field, unit, amount_field, from_field, to_field in FEE_FIELDS:
                amount = cents(order.get(amount_field))
                if amount == 0:
                    continue
                quantity = number(order.get(quantity_field))
                bills.append({
                    **base_bill(code, name, amount),
                    "quantity": quantity,
                    "unit": unit,
                    # 红冲/退费明细的金额为负数，但历史单价仍是正数；负号只由金额表达。
                    "unitPriceCents": abs(round(amount / quantity)) if quantity else None,
                    "serviceFrom": date_text(order.get(from_field)) if from_field else None,
                    "serviceTo": date_text(order.get(to_field)) if to_field else None,
                    "vehiclePlate": order.get("车牌号") or None if code == "parking" else None,
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
    parser.add_argument(
        "--only",
        action="append",
        default=[],
        choices=["owners", "standards", "bills"],
        help="只输出这些段，其余留空；本次授权只导账单时用它把写入范围摆在命令里",
    )
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
    if args.only:
        payload = {key: (value if key in args.only else []) for key, value in payload.items()}
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
