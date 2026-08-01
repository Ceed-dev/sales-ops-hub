#!/usr/bin/env python3
"""既存キャンペーンの未送信リードをプールへ取り込む（移行用・1 回限り）。

有限バッチ方式で作られた outreach-leads-2500 の残りを、新しいプールの
初期在庫にする。送信済みのものは leadpool 側の除外判定が自動で落とすため、
ここでフィルタは書かない。

`--dry-run` が既定。実際に書き込むには `--apply` を付ける。
"""

from __future__ import annotations

import argparse
import csv
import json
import sys
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from outreach import config, leadpool  # noqa: E402

# プール列へそのまま移せる列だけを拾う（send_day / daily_order は捨てる）。
CARRY_OVER = [
    "industry", "prefecture", "search_tag", "company", "email",
    "email_use", "email_source_url", "homepage", "form_url", "domain",
    "confidence", "verification",
]


def read_master(path: Path) -> list[dict]:
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        return list(csv.DictReader(handle))


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "master",
        type=Path,
        help="取り込み元の CSV（outreach-leads-2500-*.csv）",
    )
    parser.add_argument("--run-date", default="today")
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()

    run_date = config.resolve_run_date(args.run_date)
    rows = read_master(args.master)
    candidates = [
        {field: (row.get(field) or "") for field in CARRY_OVER}
        for row in rows
        if (row.get("email") or "").strip()
    ]

    if not args.apply:
        # 除外判定を実際に走らせて、何件通るかだけ先に見る。
        hist_e, hist_c, hist_d = leadpool.load_history_exclusions()
        pool_e, pool_c, pool_d = leadpool.pool_exclusions(leadpool.load_pool())
        supp_e, supp_d = leadpool.load_suppression()
        blocked_e = hist_e | pool_e | supp_e
        blocked_c = hist_c | pool_c
        blocked_d = hist_d | pool_d | supp_d

        would_add = []
        seen_e, seen_c, seen_d = set(), set(), set()
        for row in candidates:
            email = row["email"].strip().lower()
            domain = row["domain"].strip().lower() or leadpool.root_domain(email)
            company = leadpool.normalize_company(row["company"])
            if email in blocked_e or email in seen_e:
                continue
            if company and (company in blocked_c or company in seen_c):
                continue
            if domain and (domain in blocked_d or domain in seen_d):
                continue
            seen_e.add(email)
            seen_c.add(company)
            seen_d.add(domain)
            would_add.append(row)

        print(
            json.dumps(
                {
                    "mode": "dry-run",
                    "source_rows": len(rows),
                    "would_add": len(would_add),
                    "by_industry": dict(
                        Counter(row["industry"] for row in would_add)
                    ),
                    "hint": "書き込むには --apply を付ける",
                },
                ensure_ascii=False,
            )
        )
        return 0

    stats = leadpool.append_leads(candidates, run_date)
    print(
        json.dumps(
            {"source_rows": len(rows), **stats, "pool": str(config.LEADS_POOL_PATH)},
            ensure_ascii=False,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
