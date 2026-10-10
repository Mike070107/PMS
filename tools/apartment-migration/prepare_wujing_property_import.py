#!/usr/bin/env python3
"""把用户确认的馨香臣寓吴泾店地址清单转换成可审计、幂等的 PostgreSQL 脚本。"""

from __future__ import annotations

import argparse
import json
import re
from collections import Counter
from pathlib import Path


ROAD_NAME = "龙吴路"
LANE = "4787"
COMMUNITY_ID = 20
COMMUNITY_NAME = "馨香臣寓吴泾店"
OFFICE_ID = 7
OFFICE_NAME = "吴泾一村管理处"
BUILDING_LABELS = {
    "34": "A栋34号",
    "35": "B栋35号",
    "39": "C栋39号",
    "41": "D栋41号",
    "40": "E栋40号",
}
ADDRESS_PATTERN = re.compile(r"^龙吴路4787弄(34|35|39|40|41)号([0-9A-Za-z-]+)$")


def parse_addresses(text: str) -> list[dict[str, str]]:
    rows: list[dict[str, str]] = []
    seen: set[tuple[str, str]] = set()
    errors: list[str] = []
    for line_number, raw in enumerate(text.splitlines(), 1):
        address = raw.strip()
        if not address:
            continue
        match = ADDRESS_PATTERN.fullmatch(address)
        if not match:
            errors.append(f"第 {line_number} 行地址格式不符：{address}")
            continue
        street_no, room_no = match.groups()
        key = (street_no, room_no)
        if key in seen:
            errors.append(f"第 {line_number} 行房号重复：{address}")
            continue
        seen.add(key)
        building_no = BUILDING_LABELS[street_no]
        rows.append(
            {
                "street_no": street_no,
                "building_no": building_no,
                "room_no": room_no,
                "full_address": f"{ROAD_NAME}{LANE}弄{building_no}{room_no}室",
            }
        )
    if errors:
        raise ValueError("\n".join(errors))
    if not rows:
        raise ValueError("地址清单为空")
    missing = sorted(set(BUILDING_LABELS) - {row["street_no"] for row in rows})
    if missing:
        raise ValueError(f"地址清单缺少门牌：{', '.join(missing)}号")
    return rows


def sql_literal(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


def render_sql(rows: list[dict[str, str]]) -> str:
    values = ",\n".join(
        "      (" + ", ".join(sql_literal(row[key]) for key in ("building_no", "room_no", "full_address")) + ")"
        for row in rows
    )
    expected = len(rows)
    return f"""\\set ON_ERROR_STOP on
BEGIN;

SELECT pg_advisory_xact_lock(hashtext('pms:wujing-apartment-property-import:v1'));

DO $migration$
DECLARE
  v_tenant_id integer;
  v_actual integer;
BEGIN
  SELECT c.tenant_id INTO STRICT v_tenant_id
    FROM communities c
    JOIN management_offices o
      ON o.id = c.office_id AND o.tenant_id = c.tenant_id
   WHERE c.id = {COMMUNITY_ID}
     AND c.name = {sql_literal(COMMUNITY_NAME)}
     AND o.id = {OFFICE_ID}
     AND o.name = {sql_literal(OFFICE_NAME)};

  CREATE TEMP TABLE wujing_property_import (
    building_no varchar(30) NOT NULL,
    room_no varchar(30) NOT NULL,
    full_address varchar(255) NOT NULL,
    PRIMARY KEY (building_no, room_no)
  ) ON COMMIT DROP;

  INSERT INTO wujing_property_import (building_no, room_no, full_address)
  VALUES
{values};

  SELECT count(*) INTO v_actual FROM wujing_property_import;
  IF v_actual <> {expected} THEN
    RAISE EXCEPTION '导入清单数量错误：期望 {expected}，实际 %', v_actual;
  END IF;

  INSERT INTO buildings
    (tenant_id, community_id, lane, building_no, road_name, zone, created_by, updated_by)
  SELECT DISTINCT v_tenant_id, {COMMUNITY_ID}, {sql_literal(LANE)}, i.building_no,
         {sql_literal(ROAD_NAME)}, NULL, NULL, NULL
    FROM wujing_property_import i
   WHERE NOT EXISTS (
     SELECT 1 FROM buildings b
      WHERE b.tenant_id = v_tenant_id
        AND b.community_id = {COMMUNITY_ID}
        AND b.lane = {sql_literal(LANE)}
        AND b.building_no = i.building_no
   );

  INSERT INTO houses
    (tenant_id, building_id, unit_id, room_no, property_type, road_name,
     full_address, shop_name, area_sqm, created_by, updated_by)
  SELECT v_tenant_id, b.id, NULL, i.room_no, '公寓', {sql_literal(ROAD_NAME)},
         i.full_address, NULL, NULL, NULL, NULL
    FROM wujing_property_import i
    JOIN buildings b
      ON b.tenant_id = v_tenant_id
     AND b.community_id = {COMMUNITY_ID}
     AND b.lane = {sql_literal(LANE)}
     AND b.building_no = i.building_no
   WHERE NOT EXISTS (
     SELECT 1 FROM houses h
      WHERE h.tenant_id = v_tenant_id
        AND h.building_id = b.id
        AND h.unit_id IS NULL
        AND h.room_no = i.room_no
   );

  SELECT count(*) INTO v_actual
    FROM wujing_property_import i
    JOIN buildings b
      ON b.tenant_id = v_tenant_id
     AND b.community_id = {COMMUNITY_ID}
     AND b.lane = {sql_literal(LANE)}
     AND b.building_no = i.building_no
    JOIN houses h
      ON h.tenant_id = v_tenant_id
     AND h.building_id = b.id
     AND h.unit_id IS NULL
     AND h.room_no = i.room_no
     AND h.property_type = '公寓'
     AND h.full_address = i.full_address;
  IF v_actual <> {expected} THEN
    RAISE EXCEPTION '入库后复核失败：期望 {expected}，实际 %', v_actual;
  END IF;
END
$migration$;

COMMIT;
"""


def summarize(rows: list[dict[str, str]]) -> dict[str, object]:
    counts = Counter(row["building_no"] for row in rows)
    return {
        "community_id": COMMUNITY_ID,
        "community_name": COMMUNITY_NAME,
        "office_id": OFFICE_ID,
        "office_name": OFFICE_NAME,
        "road_name": ROAD_NAME,
        "lane": LANE,
        "total": len(rows),
        "buildings": dict(sorted(counts.items())),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="生成馨香臣寓吴泾店房产建档 SQL")
    parser.add_argument("--addresses", type=Path, required=True)
    parser.add_argument("--output-sql", type=Path, required=True)
    parser.add_argument("--summary-json", type=Path, required=True)
    args = parser.parse_args()

    rows = parse_addresses(args.addresses.read_text(encoding="utf-8-sig"))
    args.output_sql.parent.mkdir(parents=True, exist_ok=True)
    args.output_sql.write_text(render_sql(rows), encoding="utf-8")
    summary = summarize(rows)
    args.summary_json.parent.mkdir(parents=True, exist_ok=True)
    args.summary_json.write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
