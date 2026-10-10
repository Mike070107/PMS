#!/usr/bin/env python3
"""分析旧公寓系统地址与 PMS 房产的匹配结果。

只读取已导出的 CSV，不连接也不修改生产数据库。
"""

from __future__ import annotations

import argparse
import csv
import gzip
import json
import re
from collections import Counter, defaultdict
from pathlib import Path
from typing import Dict, Iterable, List, Mapping, MutableMapping, NamedTuple, Sequence, Tuple


class CommunityRule(NamedTuple):
    pms_community_id: str
    pms_community_name: str
    required_lane: str | None = None


COMMUNITY_RULES: Mapping[int, CommunityRule] = {
    # 使用 PMS 的稳定社区 ID 做匹配，名称只用于报告展示，避免同音/形近字造成误匹配。
    1: CommunityRule("20", "馨香臣寓吴泾店"),
    2: CommunityRule("21", "馨香臣寓颛桥店"),
    3: CommunityRule("23", "馨香臣寓江川店"),
    4: CommunityRule("22", "馨香臣寓马桥店"),
    # 业务确认：旧库编号 5 归到吴泾一村管理处下的馨香臣寓吴泾店。
    5: CommunityRule("20", "馨香臣寓吴泾店"),
}


def compact(value: object) -> str:
    return re.sub(r"\s+", "", str(value or "").strip()).replace("（", "(").replace("）", ")")


def normalize_building(value: object) -> str:
    text = compact(value)
    for suffix in ("号楼", "栋", "号"):
        if text.endswith(suffix) and len(text) > len(suffix):
            text = text[: -len(suffix)]
            break
    return text.casefold()


def normalize_room(value: object) -> str:
    text = compact(value)
    # 颛桥旧系统把房间序号同时记为 101(A)、102(B)；PMS 的正式房号是 101、102。
    match = re.fullmatch(r"(\d+)[(]([A-Za-z])\)", text)
    if match:
        text = match.group(1)
    return text.casefold()


def normalize_lane(value: object) -> str:
    text = compact(value)
    return text[:-1] if text.endswith("弄") else text


def open_csv(path: Path):
    if path.suffix.lower() == ".gz":
        return gzip.open(path, "rt", encoding="utf-8-sig", newline="")
    return path.open("r", encoding="utf-8-sig", newline="")


def load_rows(path: Path) -> List[Dict[str, str]]:
    with open_csv(path) as stream:
        return list(csv.DictReader(stream))


def house_key(community_id: object, lane: object, building: object, room: object) -> Tuple[str, str, str, str]:
    return (
        compact(community_id),
        normalize_lane(lane).casefold(),
        normalize_building(building),
        normalize_room(room),
    )


def contact_action(old: Mapping[str, str], owner_rows: Sequence[Mapping[str, str]]) -> str:
    old_name = compact(old.get("姓名"))
    old_phone = compact(old.get("手机号"))
    if not old_name and not old_phone:
        return "no_legacy_contact"

    owners = [row for row in owner_rows if compact(row.get("owner_id"))]
    if not owners:
        return "create_owner"

    for owner in owners:
        owner_name = compact(owner.get("owner_name"))
        owner_phone = compact(owner.get("owner_phone"))
        name_matches = not old_name or old_name == owner_name
        phone_matches = not old_phone or old_phone == owner_phone
        if name_matches and phone_matches:
            return "already_present"

    if len(owners) == 1:
        owner_name = compact(owners[0].get("owner_name"))
        owner_phone = compact(owners[0].get("owner_phone"))
        if (not old_name or not owner_name) and (not old_phone or not owner_phone):
            return "fill_owner"
    return "contact_conflict"


def analyze(old_rows: Iterable[Mapping[str, str]], pms_rows: Iterable[Mapping[str, str]]):
    pms_by_house: MutableMapping[str, List[Mapping[str, str]]] = defaultdict(list)
    house_ids_by_key: MutableMapping[Tuple[str, str, str, str], set[str]] = defaultdict(set)
    representative: Dict[str, Mapping[str, str]] = {}

    for row in pms_rows:
        house_id = compact(row.get("house_id"))
        if not house_id:
            continue
        key = house_key(row.get("community_id"), row.get("lane"), row.get("building_no"), row.get("room_no"))
        house_ids_by_key[key].add(house_id)
        pms_by_house[house_id].append(row)
        representative.setdefault(house_id, row)

    results: List[Dict[str, str]] = []
    for old in old_rows:
        community_id = int(compact(old.get("小区编号")) or 0)
        rule = COMMUNITY_RULES.get(community_id)
        if not rule:
            results.append({**dict(old), "match_status": "unknown_community", "contact_action": "not_applicable"})
            continue
        key = house_key(rule.pms_community_id, rule.required_lane, old.get("楼栋号"), old.get("房间号"))
        ids = sorted(house_ids_by_key.get(key, set()), key=lambda value: int(value))
        status = "matched" if len(ids) == 1 else "ambiguous" if ids else "unmatched"
        house_id = ids[0] if len(ids) == 1 else ""
        pms = representative.get(house_id, {})
        action = contact_action(old, pms_by_house[house_id]) if house_id else "not_applicable"
        results.append(
            {
                **dict(old),
                "target_community_id": rule.pms_community_id,
                "target_community": rule.pms_community_name,
                "required_lane": rule.required_lane or "",
                "normalized_building": normalize_building(old.get("楼栋号")),
                "normalized_room": normalize_room(old.get("房间号")),
                "match_status": status,
                "candidate_house_ids": "|".join(ids),
                "house_id": house_id,
                "pms_lane": compact(pms.get("lane")),
                "pms_building_no": compact(pms.get("building_no")),
                "pms_room_no": compact(pms.get("room_no")),
                "contact_action": action,
            }
        )

    return results


def summarize(rows: Sequence[Mapping[str, str]]) -> Dict[str, object]:
    by_status = Counter(row["match_status"] for row in rows)
    by_contact = Counter(row["contact_action"] for row in rows)
    by_community: MutableMapping[str, Counter] = defaultdict(Counter)
    for row in rows:
        by_community[str(row.get("小区编号") or "unknown")][row["match_status"]] += 1
    return {
        "total": len(rows),
        "match_status": dict(sorted(by_status.items())),
        "contact_action": dict(sorted(by_contact.items())),
        "communities": {key: dict(sorted(value.items())) for key, value in sorted(by_community.items())},
    }


def write_csv(path: Path, rows: Sequence[Mapping[str, str]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fieldnames: List[str] = []
    for row in rows:
        for key in row:
            if key not in fieldnames:
                fieldnames.append(key)
    with path.open("w", encoding="utf-8-sig", newline="") as stream:
        writer = csv.DictWriter(stream, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)


def main() -> int:
    parser = argparse.ArgumentParser(description="分析旧公寓地址与 PMS 房产的匹配情况")
    parser.add_argument("--legacy-addresses", type=Path, required=True)
    parser.add_argument("--pms-houses", type=Path, required=True)
    parser.add_argument("--output-csv", type=Path, required=True)
    parser.add_argument("--summary-json", type=Path, required=True)
    args = parser.parse_args()

    rows = analyze(load_rows(args.legacy_addresses), load_rows(args.pms_houses))
    write_csv(args.output_csv, rows)
    summary = summarize(rows)
    args.summary_json.parent.mkdir(parents=True, exist_ok=True)
    args.summary_json.write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
