import gzip
import tempfile
import unittest
from pathlib import Path

from extract_mysql_dump import extract_dump, parse_values


class ParseValuesTest(unittest.TestCase):
    def test_mysql_escapes_null_and_commas(self) -> None:
        rows = parse_values("(1,'张三,甲',NULL,'a\\'b','line\\nnext'),(2,'',0,'it''s','\\\\')")
        self.assertEqual(
            rows,
            [
                ["1", "张三,甲", None, "a'b", "line\nnext"],
                ["2", "", "0", "it's", "\\"],
            ],
        )

    def test_extracts_only_whitelisted_tables(self) -> None:
        dump = """CREATE TABLE `addresses` (\n  `ID` int,\n  `姓名` varchar(20)\n) ENGINE=x;\nINSERT INTO `addresses` VALUES (1,'张三');\nCREATE TABLE `orders` (\n  `ID` int\n) ENGINE=x;\nINSERT INTO `orders` VALUES (2);\nCREATE TABLE `fee_prices` (\n  `ID` int\n) ENGINE=x;\nINSERT INTO `fee_prices` VALUES (3);\nCREATE TABLE `users` (\n  `password` text\n) ENGINE=x;\nINSERT INTO `users` VALUES ('secret');\n"""
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            source = root / "dump.sql.gz"
            with gzip.open(source, "wt", encoding="utf-8") as handle:
                handle.write(dump)
            manifest = extract_dump(source, root / "out")
            self.assertEqual(manifest["tables"]["addresses"]["rowCount"], 1)
            self.assertFalse((root / "out" / "users.csv.gz").exists())


if __name__ == "__main__":
    unittest.main()
