#!/usr/bin/env python3
"""把「PMS社区 + 楼栋 + 房号」清单转成幂等的房产建档 SQL。

和吴泾店那份一次性脚本的区别：社区不写死，支持没有路名/弄号的小区（lane 为 NULL），
也支持往已有楼栋里补房号。入库前后都做数量复核，重复执行不会多建。

输入 CSV 必须有列：pms_community_id, building_no, room_no；可选 road_name, lane。
"""

from __future__ import annotations

import argparse
import csv
import json
from collections import Counter
from pathlib import Path

# 这些词出现在房号/楼栋里就不是住人房产，按「公区点位单独建档」的规矩不进 houses
NON_HOUSE_WORDS = ("活动室", "停车", "车位", "办公", "仓库", "水泵房", "监控室", "门卫")

REQUIRED_COLUMNS = ("pms_community_id", "building_no", "room_no")


def sql_literal(value: str | None) -> str:
    if value is None or value == "":
        return "NULL"
    return "'" + value.replace("'", "''") + "'"


def read_rooms(path: Path):
    """读清单并剔除非住人条目，返回 (入库行, 被剔除行)。"""
    with open(path, "rt", encoding="utf-8-sig", newline="") as stream:
        reader = csv.DictReader(stream)
        missing = [name for name in REQUIRED_COLUMNS if name not in (reader.fieldnames or [])]
        if missing:
            raise ValueError(f"清单缺少必需列：{', '.join(missing)}")
        raw = list(reader)

    rows: list[dict[str, str | None]] = []
    skipped: list[dict[str, str]] = []
    seen: set[tuple[str, str, str]] = set()
    for item in raw:
        community_id = (item["pms_community_id"] or "").strip()
        building_no = (item["building_no"] or "").strip()
        room_no = (item["room_no"] or "").strip()
        if not community_id.isdigit():
            raise ValueError(f"社区 ID 必须是数字：{community_id!r}")
        if not building_no or not room_no:
            raise ValueError(f"楼栋号和房号都不能为空：{item!r}")
        if any(word in room_no or word in building_no for word in NON_HOUSE_WORDS):
            skipped.append({"pms_community_id": community_id, "building_no": building_no, "room_no": room_no})
            continue
        key = (community_id, building_no, room_no)
        if key in seen:
            raise ValueError(f"清单内房号重复：社区 {community_id} {building_no} {room_no}")
        seen.add(key)
        rows.append({
            "pms_community_id": community_id,
            "building_no": building_no,
            "room_no": room_no,
            "road_name": (item.get("road_name") or "").strip() or None,
            "lane": (item.get("lane") or "").strip() or None,
        })
    if not rows:
        raise ValueError("清单里没有可建档的房产")
    return rows, skipped


def render_sql(rows: list[dict[str, str | None]], tag: str) -> str:
    expected = len(rows)
    communities = sorted({int(row["pms_community_id"]) for row in rows})
    values = ",\n".join(
        "      ("
        + ", ".join([
            row["pms_community_id"],
            sql_literal(row["building_no"]),
            sql_literal(row["room_no"]),
            sql_literal(row["road_name"]),
            sql_literal(row["lane"]),
        ])
        + ")"
        for row in rows
    )
    community_list = ", ".join(str(item) for item in communities)
    return f"""\\set ON_ERROR_STOP on
BEGIN;

SELECT pg_advisory_xact_lock(hashtext('pms:apartment-house-import:{tag}'));

DO $migration$
DECLARE
  v_tenant_id integer;
  v_actual integer;
BEGIN
  SELECT DISTINCT c.tenant_id INTO STRICT v_tenant_id
    FROM communities c
   WHERE c.id IN ({community_list});

  CREATE TEMP TABLE apartment_house_import (
    community_id integer NOT NULL,
    building_no varchar(30) NOT NULL,
    room_no varchar(30) NOT NULL,
    road_name varchar(60),
    lane varchar(30),
    PRIMARY KEY (community_id, building_no, room_no)
  ) ON COMMIT DROP;

  INSERT INTO apartment_house_import (community_id, building_no, room_no, road_name, lane)
  VALUES
{values};

  SELECT count(*) INTO v_actual FROM apartment_house_import;
  IF v_actual <> {expected} THEN
    RAISE EXCEPTION '清单数量错误：期望 {expected}，实际 %', v_actual;
  END IF;

  -- 楼栋按 (社区, 弄, 楼栋号) 认，弄为空时用 IS NOT DISTINCT FROM，避免 NULL 比较永远不等
  INSERT INTO buildings
    (tenant_id, community_id, lane, building_no, road_name, zone, created_by, updated_by)
  SELECT DISTINCT v_tenant_id, i.community_id, i.lane, i.building_no,
         i.road_name, NULL::varchar, NULL::integer, NULL::integer
    FROM apartment_house_import i
   WHERE NOT EXISTS (
     SELECT 1 FROM buildings b
      WHERE b.tenant_id = v_tenant_id
        AND b.community_id = i.community_id
        AND b.lane IS NOT DISTINCT FROM i.lane
        AND b.building_no = i.building_no
   );

  INSERT INTO houses
    (tenant_id, building_id, unit_id, room_no, property_type, road_name,
     full_address, shop_name, area_sqm, created_by, updated_by)
  SELECT v_tenant_id, b.id, NULL::integer, i.room_no, '公寓', i.road_name,
         CASE WHEN i.road_name IS NULL THEN NULL
              ELSE i.road_name || coalesce(i.lane || '弄', '') || i.building_no || i.room_no || '室'
         END,
         NULL::varchar, NULL::numeric, NULL::integer, NULL::integer
    FROM apartment_house_import i
    JOIN buildings b
      ON b.tenant_id = v_tenant_id
     AND b.community_id = i.community_id
     AND b.lane IS NOT DISTINCT FROM i.lane
     AND b.building_no = i.building_no
   WHERE NOT EXISTS (
     SELECT 1 FROM houses h
      WHERE h.tenant_id = v_tenant_id
        AND h.building_id = b.id
        AND h.unit_id IS NULL
        AND h.room_no = i.room_no
   );

  SELECT count(*) INTO v_actual
    FROM apartment_house_import i
    JOIN buildings b
      ON b.tenant_id = v_tenant_id
     AND b.community_id = i.community_id
     AND b.lane IS NOT DISTINCT FROM i.lane
     AND b.building_no = i.building_no
    JOIN houses h
      ON h.tenant_id = v_tenant_id
     AND h.building_id = b.id
     AND h.unit_id IS NULL
     AND h.room_no = i.room_no
     AND h.property_type = '公寓';
  IF v_actual <> {expected} THEN
    RAISE EXCEPTION '入库后复核失败：期望 {expected}，实际 %', v_actual;
  END IF;
END
$migration$;

COMMIT;
"""


def summarize(rows, skipped):
    by_community = Counter(row["pms_community_id"] for row in rows)
    by_building = Counter((row["pms_community_id"], row["building_no"]) for row in rows)
    return {
        "total": len(rows),
        "by_community": {key: value for key, value in sorted(by_community.items(), key=lambda i: int(i[0]))},
        "by_building": {f"{key[0]}/{key[1]}": value for key, value in sorted(by_building.items())},
        "skipped_non_house": skipped,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="生成公寓房产建档 SQL（幂等）")
    parser.add_argument("--rooms", type=Path, required=True)
    parser.add_argument("--tag", required=True, help="建档批次标识，用于咨询锁")
    parser.add_argument("--output-sql", type=Path, required=True)
    parser.add_argument("--summary-json", type=Path, required=True)
    args = parser.parse_args()

    rows, skipped = read_rooms(args.rooms)
    args.output_sql.parent.mkdir(parents=True, exist_ok=True)
    args.output_sql.write_text(render_sql(rows, args.tag), encoding="utf-8")
    summary = summarize(rows, skipped)
    args.summary_json.parent.mkdir(parents=True, exist_ok=True)
    args.summary_json.write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
