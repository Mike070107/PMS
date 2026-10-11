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

    def test_收费员按店绑定PMS人员而不是写裸的操作员id(self):
        # 旧库只有「操作员ID=7」，直接落库界面会显示成 7
        mappings = [
            {"ID": "11", "小区编号": "2", "match_status": "matched", "house_id": "900"},
            {"ID": "12", "小区编号": "1", "match_status": "matched", "house_id": "901"},
        ]
        orders = [
            {"订单ID": "7", "地址ID": "11", "录入时间": "2026-02-03 10:20:00",
             "收款金额": "8.00", "电费金额": "8.00", "操作员ID": "7", "红冲": "0"},
            {"订单ID": "8", "地址ID": "12", "录入时间": "2026-02-03 10:20:00",
             "收款金额": "8.00", "电费金额": "8.00", "操作员ID": "7", "红冲": "0"},
        ]
        payload, _ = MODULE.transform(mappings, orders)
        self.assertEqual(payload["bills"][0]["cashier"], "华新")      # 颛桥
        self.assertEqual(payload["bills"][1]["cashier"], "陈莉莉")    # 吴泾
        # 旧库操作员 id 不丢，留在 legacyPayload 里可追溯
        self.assertEqual(payload["bills"][0]["legacyPayload"]["legacyOperatorId"], "7")

    def test_负数的退费单也算退款而不是收款(self):
        # 旧库 88 笔【退费】只记负金额、红冲还是 0，不能当成一笔正常收款
        mappings = [{"ID": "11", "小区编号": "2", "match_status": "matched", "house_id": "900"}]
        orders = [{
            "订单ID": "9", "地址ID": "11", "录入时间": "2026-02-03 10:20:00",
            "电费金额": "-8.00", "红冲": "0", "备注": "【退费】",
        }]
        payload, _ = MODULE.transform(mappings, orders)
        self.assertEqual(payload["bills"][0]["status"], "refunded")
        self.assertEqual(payload["bills"][0]["refundedAt"], "2026-02-03T10:20:00")

    def test_停车结算一张单落一笔明细既不合并也不拆车(self):
        mappings = [{
            "ID": "2194", "小区编号": "2", "楼栋号": "停车结算", "房间号": "安乐村",
            "match_status": "matched", "house_id": "9395",
        }]
        orders = [{
            "订单ID": "607", "账单号": "WD1", "地址ID": "2194", "录入时间": "2026-01-05 12:36:15",
            "收款方式": "支付宝", "收款金额": "-2650.00", "停车费金额": "-2650.00",
            "停车费月数": "16", "停车开始日期": "2026-01-05", "停车结束日期": "2026-02-04",
            "备注": "【退费】月租车80辆2400，临时车100辆250，合计2650", "红冲": "0",
        }]
        payload, rejected = MODULE.transform(mappings, orders)
        self.assertFalse(rejected)
        self.assertEqual(len(payload["bills"]), 1)
        bill = payload["bills"][0]
        self.assertEqual(bill["feeCode"], "parking_settle")
        self.assertEqual(bill["feeName"], "停车结算")
        self.assertEqual(bill["amountCents"], -265000)
        self.assertEqual(bill["status"], "refunded")
        # 汇总不编造数量和单价：旧库「停车费月数」16 是台账流水，不是真实月数
        self.assertIsNone(bill["quantity"])
        self.assertIsNone(bill["unitPriceCents"])
        self.assertIn("月租车80辆2400", bill["remark"])
        self.assertEqual(bill["legacyRef"], "apartment:order:607:parking_settle")

    def test_停车结算几张单就几笔明细各留自己的收据号(self):
        # 用户 2026-10-11 确认：11 笔订单就对应 11 笔退费明细，不许合并成一行
        mappings = [{
            "ID": "2194", "小区编号": "2", "楼栋号": "停车结算",
            "match_status": "matched", "house_id": "9395",
        }]
        orders = [
            {"订单ID": str(600 + i), "账单号": f"WD{i}", "地址ID": "2194",
             "录入时间": "2026-04-02 09:59:37", "收款金额": f"-{i}0.00",
             "停车费金额": f"-{i}0.00", "红冲": "0"}
            for i in (1, 2, 3)
        ]
        payload, rejected = MODULE.transform(mappings, orders)
        self.assertFalse(rejected)
        self.assertEqual(len(payload["bills"]), 3)
        self.assertEqual([b["receiptNo"] for b in payload["bills"]], ["WD1", "WD2", "WD3"])
        self.assertEqual([b["amountCents"] for b in payload["bills"]], [-1000, -2000, -3000])

    def test_汇总总额与明细合计不符时拒绝而不是猜(self):
        mappings = [{
            "ID": "2194", "小区编号": "2", "楼栋号": "停车结算",
            "match_status": "matched", "house_id": "9395",
        }]
        orders = [{
            "订单ID": "608", "地址ID": "2194", "录入时间": "2026-01-05 12:36:15",
            "收款金额": "-2650.00", "停车费金额": "-2000.00", "红冲": "0",
        }]
        payload, rejected = MODULE.transform(mappings, orders)
        self.assertEqual(payload["bills"], [])
        self.assertIn("不一致", rejected[0]["原因"])

    def test_普通房间的停车费照旧拆成明细(self):
        mappings = [{
            "ID": "11", "小区编号": "2", "楼栋号": "15号楼", "房间号": "106",
            "match_status": "matched", "house_id": "9398",
        }]
        orders = [{
            "订单ID": "7", "地址ID": "11", "录入时间": "2026-02-03 10:20:00",
            "收款金额": "300.00", "停车费月数": "1", "停车费金额": "300.00",
            "车牌号": "沪A12345", "红冲": "0",
        }]
        payload, _ = MODULE.transform(mappings, orders)
        self.assertEqual(payload["bills"][0]["feeCode"], "parking")
        self.assertEqual(payload["bills"][0]["quantity"], 1.0)
        self.assertEqual(payload["bills"][0]["vehiclePlate"], "沪A12345")

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
