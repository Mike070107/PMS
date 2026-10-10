import importlib.util
import csv
import gzip
import tempfile
import unittest
from pathlib import Path

MODULE_PATH = Path(__file__).with_name("prepare_apartment_fee_import.py")
SPEC = importlib.util.spec_from_file_location("prepare_apartment_fee_import", MODULE_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC.loader
SPEC.loader.exec_module(MODULE)


class TransformTest(unittest.TestCase):
    def test_only_unique_house_matches_are_imported_and_order_is_exploded(self):
        mappings = [
            {"ID": "11", "小区编号": "1", "match_status": "matched", "house_id": "900", "姓名": "张三"},
            {"ID": "12", "小区编号": "1", "match_status": "ambiguous", "house_id": "", "姓名": "李四"},
        ]
        orders = [
            {"订单ID": "7", "地址ID": "11", "账单号": "B7", "录入时间": "2026-02-03 10:20:00", "收款方式": "微信", "电费度数": "10", "电费金额": "8.00", "房租月数": "1", "房租金额": "1500", "红冲": "0"},
            {"订单ID": "8", "地址ID": "12", "账单号": "B8", "录入时间": "2026-02-03 10:20:00", "电费金额": "8.00"},
        ]
        prices = [{"id": "1", "electricity": "0.80", "rent_fee": "1500", "created_at": "2026-01-01 00:00:00"}]
        payload, rejected = MODULE.transform(mappings, orders, prices)
        self.assertEqual([row["feeCode"] for row in payload["bills"]], ["electricity", "rent"])
        self.assertTrue(all(row["house"] == {"houseId": 900} for row in payload["bills"]))
        self.assertEqual(payload["bills"][0]["legacyRef"], "apartment:order:7:electricity")
        self.assertEqual(payload["bills"][0]["paymentMethod"], "wechat")
        self.assertEqual(payload["owners"], [{
            "house": {"houseId": 900}, "name": "张三", "phone": None,
            "legacyRef": "apartment:address:11:owner",
        }])
        self.assertEqual(len(rejected), 1)
        self.assertEqual([row["feeCode"] for row in payload["standards"]], ["electricity", "rent"])
        self.assertEqual(payload["standards"][0]["house"], {"houseId": 900})

    def test_red_reversal_keeps_signed_amount_and_positive_unit_price(self):
        mappings = [{"ID": "11", "小区编号": "2", "match_status": "matched", "house_id": "900"}]
        orders = [{
            "订单ID": "9", "地址ID": "11", "录入时间": "2026-02-03 10:20:00",
            "电费度数": "10", "电费金额": "-8.00", "红冲": "1",
        }]
        payload, rejected = MODULE.transform(mappings, orders)
        self.assertFalse(rejected)
        self.assertEqual(payload["bills"][0]["amountCents"], -800)
        self.assertEqual(payload["bills"][0]["unitPriceCents"], 80)
        self.assertEqual(payload["bills"][0]["status"], "refunded")

    def test_broadcast_spreads_community_price_to_every_house_of_that_community(self):
        mappings = [{"ID": "11", "小区编号": "2", "match_status": "matched", "house_id": "900"}]
        prices = [
            {"id": "1", "electricity": "1.20", "rent_fee": "800", "created_at": "2026-01-01 00:00:00"},
            {"id": "2", "electricity": "0.80", "created_at": "2026-01-01 00:00:00"},
        ]
        houses = [
            {"house_id": "501", "community_id": "20"},
            {"house_id": "502", "community_id": "20"},
            {"house_id": "777", "community_id": "21"},
        ]
        payload, _ = MODULE.transform(mappings, [], prices, houses, {"1": "20"})
        self.assertEqual(
            [(row["house"]["houseId"], row["feeCode"], row["amountCents"]) for row in payload["standards"]],
            [
                (501, "electricity", 120), (501, "rent", 80000),
                (502, "electricity", 120), (502, "rent", 80000),
                (900, "electricity", 80),
            ],
        )
        self.assertEqual(payload["standards"][0]["legacyRef"], "apartment:price:1:501:electricity")

    def test_broadcast_does_not_touch_other_communities(self):
        mappings = []
        prices = [{"id": "1", "electricity": "1.20", "created_at": "2026-01-01 00:00:00"}]
        houses = [{"house_id": "777", "community_id": "21"}]
        payload, _ = MODULE.transform(mappings, [], prices, houses, {"1": "20"})
        self.assertEqual(payload["standards"], [])

    def test_read_csv_accepts_gzip(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "rows.csv.gz"
            with gzip.open(path, "wt", encoding="utf-8-sig", newline="") as stream:
                writer = csv.DictWriter(stream, fieldnames=["ID", "姓名"])
                writer.writeheader()
                writer.writerow({"ID": "1", "姓名": "张三"})
            self.assertEqual(MODULE.read_csv(path), [{"ID": "1", "姓名": "张三"}])


if __name__ == "__main__":
    unittest.main()
