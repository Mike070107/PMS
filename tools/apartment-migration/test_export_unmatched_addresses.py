#!/usr/bin/env python3
"""未匹配地址归因的回归用例：别再把「写法不同」说成「楼栋不存在」。"""

import unittest

from export_unmatched_addresses import classify, guess_buildings

PMS = {
    "20": {"A栋34号": {"101", "102"}, "B栋35号": {"201"}},
    "22": {},
}


def row(**kwargs):
    base = {"target_community_id": "20", "楼栋号": "A栋", "房间号": "101"}
    base.update(kwargs)
    return base


class ClassifyTest(unittest.TestCase):
    def test_旧楼栋名是PMS楼栋名前缀时按同一栋给候选(self):
        self.assertEqual(guess_buildings("A栋", PMS["20"]), ["A栋34号"])
        self.assertEqual(guess_buildings("Z栋", PMS["20"]), [])

    def test_小区还没建房产要单独说明而不是说楼栋不存在(self):
        reason, _ = classify(row(target_community_id="22"), PMS)
        self.assertEqual(reason, "PMS 该小区尚未建房产")

    def test_房号带旧定位码去码后能对上要和对不上分开(self):
        hit, _ = classify(row(房间号="101(A105C)"), PMS)
        miss, _ = classify(row(房间号="999(A105C)"), PMS)
        self.assertEqual(hit, "房号含旧定位码（去码后能对上）")
        self.assertEqual(miss, "房号含旧定位码（去码后仍对不上）")

    def test_楼栋确实不存在时说明里列出PMS实际楼栋(self):
        reason, note = classify(row(楼栋号="F栋"), PMS)
        self.assertEqual(reason, "楼栋在 PMS 不存在")
        self.assertIn("A栋34号", note)

    def test_停车位办公室这类不绑定到房间(self):
        reason, _ = classify(row(房间号="停车位12"), PMS)
        self.assertEqual(reason, "非住人房号")

    def test_没房号和原本就能对上的要分别提示(self):
        empty, _ = classify(row(房间号=""), PMS)
        self.assertEqual(empty, "旧地址缺房号")
        recheck, _ = classify(row(房间号="102"), PMS)
        self.assertEqual(recheck, "待复核：房号其实能对上")


if __name__ == "__main__":
    unittest.main()
