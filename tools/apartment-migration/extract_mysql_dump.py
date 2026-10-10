#!/usr/bin/env python3
"""Extract whitelisted tables from a mysqldump into auditable CSV files."""

from __future__ import annotations

import argparse
import csv
import gzip
import hashlib
import json
import re
from pathlib import Path


TABLES = {"addresses", "orders", "fee_prices"}
CREATE_RE = re.compile(r"^CREATE TABLE `([^`]+)`")
INSERT_RE = re.compile(r"^INSERT INTO `([^`]+)` VALUES (.*);$")
COLUMN_RE = re.compile(r"^\s*`([^`]+)`\s+")


def decode_mysql_escape(char: str) -> str:
    return {
        "0": "\0",
        "b": "\b",
        "n": "\n",
        "r": "\r",
        "t": "\t",
        "Z": "\x1a",
    }.get(char, char)


def parse_values(payload: str) -> list[list[str | None]]:
    rows: list[list[str | None]] = []
    row: list[str | None] | None = None
    token: list[str] = []
    quoted = False
    escaped = False
    value_was_quoted = False

    def finish_value() -> None:
        nonlocal token, value_was_quoted
        assert row is not None
        value = "".join(token)
        row.append(value if value_was_quoted or value.upper() != "NULL" else None)
        token = []
        value_was_quoted = False

    index = 0
    while index < len(payload):
        char = payload[index]
        if quoted:
            if escaped:
                token.append(decode_mysql_escape(char))
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == "'":
                if index + 1 < len(payload) and payload[index + 1] == "'":
                    token.append("'")
                    index += 1
                else:
                    quoted = False
            else:
                token.append(char)
        elif char == "'":
            quoted = True
            value_was_quoted = True
        elif char == "(":
            if row is not None:
                token.append(char)
            else:
                row = []
        elif char == ",":
            if row is not None:
                finish_value()
        elif char == ")":
            if row is None:
                raise ValueError("unexpected closing parenthesis")
            finish_value()
            rows.append(row)
            row = None
        elif row is not None and not char.isspace():
            token.append(char)
        index += 1

    if quoted or escaped or row is not None:
        raise ValueError("unterminated INSERT value list")
    return rows


def extract_dump(source: Path, output_dir: Path) -> dict[str, object]:
    columns: dict[str, list[str]] = {}
    rows: dict[str, list[list[str | None]]] = {table: [] for table in TABLES}
    current_table: str | None = None

    opener = gzip.open if source.suffix == ".gz" else open
    with opener(source, "rt", encoding="utf-8", newline="") as handle:
        for raw_line in handle:
            line = raw_line.rstrip("\r\n")
            create_match = CREATE_RE.match(line)
            if create_match:
                table = create_match.group(1)
                current_table = table if table in TABLES else None
                if current_table:
                    columns[current_table] = []
                continue
            if current_table:
                column_match = COLUMN_RE.match(line)
                if column_match:
                    columns[current_table].append(column_match.group(1))
                elif line.startswith(") ENGINE="):
                    current_table = None
            insert_match = INSERT_RE.match(line)
            if insert_match and insert_match.group(1) in TABLES:
                rows[insert_match.group(1)].extend(parse_values(insert_match.group(2)))

    output_dir.mkdir(parents=True, exist_ok=True)
    manifest_tables: dict[str, object] = {}
    for table in sorted(TABLES):
        if table not in columns:
            raise ValueError(f"missing CREATE TABLE for {table}")
        invalid = [len(row) for row in rows[table] if len(row) != len(columns[table])]
        if invalid:
            raise ValueError(
                f"{table}: column count {len(columns[table])}, row counts {sorted(set(invalid))}"
            )
        target = output_dir / f"{table}.csv.gz"
        with gzip.open(target, "wt", encoding="utf-8-sig", newline="") as handle:
            writer = csv.writer(handle)
            writer.writerow(columns[table])
            writer.writerows(rows[table])
        digest = hashlib.sha256(target.read_bytes()).hexdigest()
        manifest_tables[table] = {
            "columns": columns[table],
            "rowCount": len(rows[table]),
            "file": target.name,
            "sha256": digest,
        }

    source_digest = hashlib.sha256(source.read_bytes()).hexdigest()
    manifest: dict[str, object] = {
        "source": source.name,
        "sourceSha256": source_digest,
        "tables": manifest_tables,
    }
    (output_dir / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    return manifest


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path)
    parser.add_argument("output_dir", type=Path)
    args = parser.parse_args()
    manifest = extract_dump(args.source, args.output_dir)
    print(json.dumps(manifest, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
