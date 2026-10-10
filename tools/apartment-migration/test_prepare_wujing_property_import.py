import importlib.util
import unittest
from pathlib import Path


MODULE_PATH = Path(__file__).with_name("prepare_wujing_property_import.py")
SPEC = importlib.util.spec_from_file_location("prepare_wujing_property_import", MODULE_PATH)
IMPORTER = importlib.util.module_from_spec(SPEC)
assert SPEC.loader
SPEC.loader.exec_module(IMPORTER)


class WujingPropertyImportTest(unittest.TestCase):
    def test_keeps_full_building_label_and_address(self):
        text = "\n".join(
            [
                "龙吴路4787弄34号101",
                "龙吴路4787弄35号102",
                "龙吴路4787弄39号103",
                "龙吴路4787弄41号104",
                "龙吴路4787弄40号105",
            ]
        )
        rows = IMPORTER.parse_addresses(text)
        self.assertEqual(rows[0]["building_no"], "A栋34号")
        self.assertEqual(rows[0]["full_address"], "龙吴路4787弄A栋34号101室")
        self.assertEqual(rows[2]["building_no"], "C栋39号")
        self.assertEqual(rows[3]["building_no"], "D栋41号")
        self.assertEqual(rows[4]["building_no"], "E栋40号")

    def test_rejects_duplicate_room(self):
        text = "\n".join(
            [
                "龙吴路4787弄34号101",
                "龙吴路4787弄34号101",
                "龙吴路4787弄35号101",
                "龙吴路4787弄39号101",
                "龙吴路4787弄40号101",
                "龙吴路4787弄41号101",
            ]
        )
        with self.assertRaisesRegex(ValueError, "房号重复"):
            IMPORTER.parse_addresses(text)

    def test_sql_is_idempotent_and_targets_confirmed_hierarchy(self):
        text = "\n".join(
            [
                "龙吴路4787弄34号101",
                "龙吴路4787弄35号101",
                "龙吴路4787弄39号101",
                "龙吴路4787弄40号101",
                "龙吴路4787弄41号101",
            ]
        )
        sql = IMPORTER.render_sql(IMPORTER.parse_addresses(text))
        self.assertIn("c.id = 20", sql)
        self.assertIn("o.id = 7", sql)
        self.assertIn("WHERE NOT EXISTS", sql)
        self.assertIn("'A栋34号'", sql)
        self.assertIn("'龙吴路4787弄A栋34号101室'", sql)
        self.assertIn("NULL::integer", sql)


if __name__ == "__main__":
    unittest.main()
