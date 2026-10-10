import importlib.util
import unittest
from pathlib import Path


MODULE_PATH = Path(__file__).with_name("analyze_house_mapping.py")
SPEC = importlib.util.spec_from_file_location("analyze_house_mapping", MODULE_PATH)
MAPPING = importlib.util.module_from_spec(SPEC)
assert SPEC.loader
SPEC.loader.exec_module(MAPPING)


class NormalizeTest(unittest.TestCase):
    def test_normalizes_legacy_building_and_room_suffixes(self):
        self.assertEqual(MAPPING.normalize_building(" 10号楼 "), "10")
        self.assertEqual(MAPPING.normalize_room("101（A）"), "101")
        self.assertEqual(MAPPING.normalize_room("超市"), "超市")

    def test_matches_zhuanqiao_room_to_pms_house(self):
        legacy = [{"ID": "1", "小区编号": "2", "楼栋号": "1号楼", "房间号": "101(A)", "姓名": "张三", "手机号": "13800000000"}]
        pms = [{"community_id": "21", "community_name": "馨香臣寓颛桥店", "lane": "", "building_no": "1", "room_no": "101", "house_id": "99", "owner_id": "", "owner_name": "", "owner_phone": ""}]
        row = MAPPING.analyze(legacy, pms)[0]
        self.assertEqual(row["match_status"], "matched")
        self.assertEqual(row["house_id"], "99")
        self.assertEqual(row["contact_action"], "create_owner")

    def test_maps_legacy_community_5_to_wujing_apartment(self):
        legacy = [{"ID": "2", "小区编号": "5", "楼栋号": "8号楼", "房间号": "201", "姓名": "", "手机号": ""}]
        pms = [
            {"community_id": "20", "community_name": "馨香臣寓吴泾店", "lane": "", "building_no": "8", "room_no": "201", "house_id": "10"},
            {"community_id": "19", "community_name": "吴泾一村", "lane": "", "building_no": "8", "room_no": "201", "house_id": "11"},
            {"community_id": "13", "community_name": "吴泾新村", "lane": "5530", "building_no": "8", "room_no": "201", "house_id": "12"},
        ]
        row = MAPPING.analyze(legacy, pms)[0]
        self.assertEqual(row["match_status"], "matched")
        self.assertEqual(row["house_id"], "10")
        self.assertEqual(row["target_community_id"], "20")
        self.assertEqual(row["target_community"], "馨香臣寓吴泾店")
        self.assertEqual(row["required_lane"], "")

    def test_never_falls_back_to_wujing_villages(self):
        legacy = [{"ID": "3", "小区编号": "5", "楼栋号": "8号楼", "房间号": "201", "姓名": "", "手机号": ""}]
        pms = [
            {"community_id": "19", "community_name": "吴泾一村", "lane": "", "building_no": "8", "room_no": "201", "house_id": "10"},
            {"community_id": "13", "community_name": "吴泾新村", "lane": "5530", "building_no": "8", "room_no": "201", "house_id": "11"},
        ]
        row = MAPPING.analyze(legacy, pms)[0]
        self.assertEqual(row["match_status"], "unmatched")
        self.assertEqual(row["candidate_house_ids"], "")
        self.assertEqual(row["target_community_id"], "20")


if __name__ == "__main__":
    unittest.main()
