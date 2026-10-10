#!/usr/bin/env python3
"""房产建档清单解析的回归用例。"""

import tempfile
import unittest
from pathlib import Path

from prepare_apartment_house_import import read_rooms, render_sql


def write(text: str) -> Path:
    path = Path(tempfile.mkdtemp()) / "rooms.csv"
    path.write_text(text, encoding="utf-8")
    return path


HEADER = "pms_community_id,building_no,room_no\n"


class ReadRoomsTest(unittest.TestCase):
    def test_活动室这类公区不进房产(self):
        rows, skipped = read_rooms(write(HEADER + "22,1号楼,101\n22,一期活动室,1\n"))
        self.assertEqual(len(rows), 1)
        self.assertEqual(skipped[0]["building_no"], "一期活动室")

    def test_清单内房号重复直接报错而不是悄悄去重(self):
        with self.assertRaisesRegex(ValueError, "房号重复"):
            read_rooms(write(HEADER + "22,1号楼,101\n22,1号楼,101\n"))

    def test_缺列和空房号都要报错(self):
        with self.assertRaisesRegex(ValueError, "缺少必需列"):
            read_rooms(write("pms_community_id,room_no\n22,101\n"))
        with self.assertRaisesRegex(ValueError, "不能为空"):
            read_rooms(write(HEADER + "22,1号楼,\n"))

    def test_没有路名弄号时楼栋按NULL比较且不拼完整地址(self):
        rows, _ = read_rooms(write(HEADER + "23,主楼,101\n"))
        self.assertIsNone(rows[0]["lane"])
        sql = render_sql(rows, "t")
        self.assertIn("b.lane IS NOT DISTINCT FROM i.lane", sql)
        self.assertIn("i.road_name IS NULL THEN NULL", sql)

    def test_带路名弄号时按原样写进SQL(self):
        rows, _ = read_rooms(write(
            "pms_community_id,building_no,room_no,road_name,lane\n20,F栋,101\n".replace("101\n", "101,龙吴路,4787\n")
        ))
        self.assertEqual(rows[0]["lane"], "4787")
        self.assertIn("'龙吴路'", render_sql(rows, "t"))

    def test_入库数量复核写进SQL防止少建多建(self):
        rows, _ = read_rooms(write(HEADER + "22,1号楼,101\n22,1号楼,102\n"))
        sql = render_sql(rows, "t")
        self.assertIn("期望 2", sql)
        self.assertIn("入库后复核失败", sql)


if __name__ == "__main__":
    unittest.main()
