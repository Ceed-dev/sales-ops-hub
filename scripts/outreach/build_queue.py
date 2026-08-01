#!/usr/bin/env python3
"""当日分の送信キューを生成する。

毎朝 07:00 に走り、09:00 の送信ジョブが読むキューを用意する。

ここで検証を通ったものだけが送信される。検証が崩れると重複送信・
配信停止無視・バウンス増加に直結するため、1 つでも失敗したら
キューを書かずに異常終了する（不完全なキューを置くくらいなら送らない）。
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import sys
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from outreach import (  # noqa: E402
    allocation,
    config,
    dns_check,
    leadpool,
    notify,
    templates,
    tracking,
)

QUEUE_FIELDS = [
    "全体順", "バッチ番号", "バッチ内順", "業界", "業界内順", "企業名",
    "送信先", "件名", "件名ABグループ", "件名確定状態", "本文", "本文HTML",
    "送信元", "添付PDF", "送付形式", "送信判定", "prep_status", "status",
    "HPリンク", "フォームURL", "メール用途", "発見元URL", "信頼度",
    "campaign_id", "idempotency_key", "tracking_status",
    "tracking_registered_at", "sent_at", "open_pixel_url", "click_url",
    "遷移先URL", "notes",
]

SEND_LOG_FIELDS = [
    "全体順", "バッチ番号", "企業名", "送信先", "件名", "送信判定",
    "prep_status", "status", "sent_at", "gmail_message_id", "error", "notes",
]

HOLD_FIELDS = [
    "lead_id", "企業名", "送信先", "業界", "domain", "hold_reason",
    "dns_status", "mx", "checked_at",
]


class QueueBuildError(RuntimeError):
    pass


def load_sender_module():
    """送信スクリプトの build_email を検証に使うため読み込む。

    生成側と送信側で検証がずれると、朝 9 時に初めて発覚することになる。
    同じ関数を通しておけば生成時点で弾ける。
    """
    path = Path(__file__).resolve().parents[1] / "send_outreach_queue.py"
    spec = importlib.util.spec_from_file_location("send_outreach_queue", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def attachment_path() -> Path:
    """添付 PDF。TCC 保護外の資産ディレクトリ配下しか使わない。"""
    candidates = sorted(config.ASSET_DIR.glob("*.pdf"))
    if not candidates:
        raise QueueBuildError(
            f"添付 PDF が資産ディレクトリに無い: {config.ASSET_DIR}"
        )
    if len(candidates) > 1:
        raise QueueBuildError(
            "資産ディレクトリに PDF が複数ある。どれを送るか一意に決められない: "
            + ", ".join(path.name for path in candidates)
        )
    return candidates[0]


def select_leads(target: int) -> tuple[list[dict], list[dict], dict]:
    """プールから送信可能なリードを選ぶ。MX が引けないものは hold へ回す。"""
    leadpool.apply_suppression_to_pool()
    pool = leadpool.load_pool()
    available = [row for row in pool if row.get("status") == leadpool.STATUS_NEW]

    # MX 判定は候補全部ではなく必要分の少し多めに対して行う（照会コスト削減）。
    lookahead = available[: max(target * 2, target + 200)]
    domains = [leadpool.email_domain(row["email"]) for row in lookahead]
    cache = dns_check.load_cache()
    results = dns_check.resolve(domains, cache)
    dns_check.save_cache(results)

    ready: list[dict] = []
    held: list[dict] = []
    for row in lookahead:
        domain = leadpool.email_domain(row["email"])
        verdict = results.get(domain, {}).get("verdict", "dns_not_checked")
        if dns_check.is_sendable(verdict) and len(ready) < target:
            ready.append(row)
        elif not dns_check.is_sendable(verdict):
            detail = results.get(domain, {})
            held.append(
                {
                    "lead_id": row.get("lead_id", ""),
                    "企業名": row.get("company", ""),
                    "送信先": row.get("email", ""),
                    "業界": row.get("industry", ""),
                    "domain": domain,
                    "hold_reason": verdict,
                    "dns_status": detail.get("dns_status", ""),
                    "mx": " | ".join(detail.get("mx", [])),
                    "checked_at": detail.get("checked_at", ""),
                }
            )
    stats = {
        "pool_total": len(pool),
        "available": len(available),
        "selected": len(ready),
        "held": len(held),
    }
    return ready, held, stats


def build_rows(leads: list[dict], run_date: str, admin_token: str) -> list[dict]:
    """キュー行を組み立てる。計測登録もここで行う。"""
    campaign_id = tracking.campaign_id_for(run_date, allocation.copy_generation())
    sequence = allocation.assign(len(leads))
    cache = tracking.load_cache()
    pdf_path = attachment_path()
    registered_at = tracking.utc_now()
    industry_index: dict[str, int] = defaultdict(int)
    rows = []

    try:
        for order, (lead, (subject_variant, delivery_variant)) in enumerate(
            zip(leads, sequence), start=1
        ):
            industry = lead["industry"]
            industry_index[industry] += 1
            destination_url = templates.destination_for(delivery_variant)
            response = tracking.register_lead(
                lead_id=lead["lead_id"],
                campaign_id=campaign_id,
                industry_tracking_id=templates.tracking_id(industry),
                subject_variant=subject_variant,
                delivery_variant=delivery_variant,
                destination_url=destination_url,
                admin_token=admin_token,
                cache=cache,
            )
            body = templates.body_for(industry, delivery_variant)
            rows.append(
                {
                    "全体順": str(order),
                    "バッチ番号": str((order - 1) // 50 + 1),
                    "バッチ内順": str((order - 1) % 50 + 1),
                    "業界": industry,
                    "業界内順": str(industry_index[industry]),
                    "企業名": lead.get("company", ""),
                    "送信先": lead["email"],
                    "件名": templates.subject_for(industry, subject_variant),
                    "件名ABグループ": subject_variant,
                    "件名確定状態": "confirmed",
                    "本文": body,
                    "本文HTML": templates.render_html(
                        body,
                        destination_url,
                        response["clickUrl"],
                        response["openPixelUrl"],
                    ),
                    "送信元": config.SENDER_EMAIL,
                    "添付PDF": str(pdf_path) if delivery_variant == "PDF" else "",
                    "送付形式": delivery_variant,
                    "送信判定": "send_ready",
                    "prep_status": "send_ready",
                    "status": "pending_send",
                    "HPリンク": lead.get("homepage", ""),
                    "フォームURL": lead.get("form_url", ""),
                    "メール用途": lead.get("email_use", ""),
                    "発見元URL": lead.get("email_source_url", ""),
                    "信頼度": lead.get("confidence", ""),
                    "campaign_id": campaign_id,
                    "idempotency_key": tracking._idempotency_key(
                        campaign_id, lead["lead_id"]
                    ),
                    "tracking_status": "registered",
                    "tracking_registered_at": registered_at,
                    "sent_at": "",
                    "open_pixel_url": response["openPixelUrl"],
                    "click_url": response["clickUrl"],
                    "遷移先URL": destination_url,
                    "notes": (
                        f"{run_date} 自動生成。lead_id={lead['lead_id']}。"
                        f"文面世代={allocation.copy_generation()}。"
                    ),
                }
            )
    finally:
        # 途中で落ちても登録済み分は残す（API は冪等だが往復を無駄にしない）。
        tracking.save_cache(cache)
    return rows


def validate(rows: list[dict], sender_module) -> None:
    """キューを書く前に不変条件を検証する。1 つでも崩れたら書かない。"""
    if not rows:
        raise QueueBuildError("キューが空")

    addresses = [row["送信先"].strip().lower() for row in rows]
    if len(set(addresses)) != len(addresses):
        duplicated = [a for a, n in Counter(addresses).items() if n > 1]
        raise QueueBuildError(
            f"キュー内でアドレスが重複している: {duplicated[:5]}"
        )

    history_emails, _, _ = leadpool.load_history_exclusions()
    overlap = sorted(set(addresses) & history_emails)
    if overlap:
        raise QueueBuildError(
            f"過去に送信済みのアドレスが混入している: {overlap[:5]}"
        )

    supp_emails, supp_domains = leadpool.load_suppression()
    blocked = [
        address
        for address in addresses
        if address in supp_emails
        or leadpool.root_domain(address) in supp_domains
    ]
    if blocked:
        raise QueueBuildError(f"配信停止済みが混入している: {blocked[:5]}")

    for row in rows:
        attachment = row["添付PDF"].strip()
        if attachment and config.ASSET_DIR not in Path(attachment).parents:
            raise QueueBuildError(
                f"添付が資産ディレクトリの外を指している: {attachment}"
            )
        # 送信側と同じ関数で検証する。計測 URL 各 1 個・送信元一致・
        # 添付の実在と読み取り可否がここで確定する。
        sender_module.build_email(row)


def write_csv(path: Path, fieldnames: list[str], rows: list[dict]) -> None:
    leadpool.atomic_write_csv(path, fieldnames, rows)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--date", default="today")
    parser.add_argument("--target", type=int, default=config.DAILY_SEND_TARGET)
    parser.add_argument(
        "--allow-partial",
        action="store_true",
        help="目標件数に届かなくてもキューを作る",
    )
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    run_date = config.resolve_run_date(args.date)
    queue_path = config.queue_path_for(run_date)
    log_path = config.send_log_path_for(run_date)

    if queue_path.exists():
        print(
            json.dumps(
                {"skipped": "queue already exists", "queue": str(queue_path)},
                ensure_ascii=False,
            )
        )
        return 0

    leads, held, stats = select_leads(args.target)

    if len(leads) < args.target and not args.allow_partial:
        message = (
            f"{run_date} のキューを作れない。"
            f"送信可能なリードが {len(leads)} 件しかない"
            f"（目標 {args.target} 件）。"
        )
        notify.alert("営業メール: キュー生成を中止した", message)
        print(json.dumps({"error": message, **stats}, ensure_ascii=False))
        return 1

    if args.dry_run:
        print(
            json.dumps({"mode": "dry-run", **stats}, ensure_ascii=False)
        )
        return 0

    admin_token = config.tracking_admin_token()
    rows = build_rows(leads, run_date, admin_token)
    validate(rows, load_sender_module())

    write_csv(queue_path, QUEUE_FIELDS, rows)
    write_csv(log_path, SEND_LOG_FIELDS, [])
    if held:
        write_csv(config.QUEUE_DIR / f"hold-{run_date}.csv", HOLD_FIELDS, held)

    leadpool.mark_status(
        {lead["lead_id"] for lead in leads},
        leadpool.STATUS_QUEUED,
        queued_date=run_date,
    )

    cells = Counter(
        (row["件名ABグループ"], row["送付形式"]) for row in rows
    )
    result = {
        "run_date": run_date,
        "queued": len(rows),
        "cells": {f"{a}x{b}": n for (a, b), n in sorted(cells.items())},
        "industries": dict(Counter(row["業界"] for row in rows)),
        "held": len(held),
        "queue": str(queue_path),
        "send_log": str(log_path),
    }
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (QueueBuildError, allocation.AllocationError, tracking.TrackingError) as error:
        notify.alert("営業メール: キュー生成に失敗した", str(error))
        print(json.dumps({"error": str(error)}, ensure_ascii=False), file=sys.stderr)
        raise SystemExit(1)
