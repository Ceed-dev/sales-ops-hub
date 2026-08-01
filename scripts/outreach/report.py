#!/usr/bin/env python3
"""日次レポートと 3 日サイクルレポート。

日次は通知のみ（判断を求めない）。3 日サイクルで判断材料をまとめ、
Zack がフィードバックを返す。フィードバックが無くても送信は止めない。

開封率は補助指標として扱う。Gmail の画像プロキシと各種スキャナの影響で
実態より高く出るため、主要指標はクリック率と返信率
（docs/plans/2026-07-22-email-engagement-tracking.md の方針）。
"""

from __future__ import annotations

import argparse
import json
import sys
from collections import Counter, defaultdict
from datetime import date, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from outreach import (  # noqa: E402
    allocation,
    config,
    inventory,
    leadpool,
    notify,
    tracking,
)

REPLIES_PATH_NAME = "replies.csv"

# サイクルレポートで配分変更を提案してよい最小サンプル。これを下回る間は
# 判断保留にする。1 日 500 通の規模では、誤った勝者に固定した損失が大きい。
MIN_REPLIES_PER_CELL = 10
MIN_SENDS_PER_CELL = 1000


def replies_path() -> Path:
    return config.DATA_ROOT / REPLIES_PATH_NAME


def load_replies() -> tuple[list[dict], bool]:
    """返信ログ。まだ取得できていない場合は available=False を返す。

    gmail.readonly の認可が下りるまでは返信を取得できない。数字が無いことを
    0 件と表示すると「返信ゼロ」と誤読されるため、未計測として区別する。
    """
    path = replies_path()
    if not path.is_file():
        return [], False
    _, rows = leadpool.read_csv(path)
    return rows, True


def load_day(run_date: str) -> dict:
    """1 日分の送信実績を、キューと送信ログの突合で組み立てる。"""
    _, queue_rows = leadpool.read_csv(config.queue_path_for(run_date))
    _, log_rows = leadpool.read_csv(config.send_log_path_for(run_date))

    by_order = {row["全体順"]: row for row in queue_rows}
    sent, errors = [], []
    for row in log_rows:
        if row.get("status") == "sent":
            sent.append(row)
        elif row.get("status") == "send_error":
            errors.append(row)

    campaign_id = queue_rows[0]["campaign_id"] if queue_rows else ""
    return {
        "date": run_date,
        "campaign_id": campaign_id,
        "queued": len(queue_rows),
        "sent": len(sent),
        "errors": len(errors),
        "queue_by_order": by_order,
        "sent_orders": [row["全体順"] for row in sent],
    }


def cross_tab(days: list[dict], replies_by_email: dict) -> dict:
    """セル別・業界別の送信数と返信数。"""
    cells: dict = defaultdict(lambda: {"sent": 0, "replies": 0, "interested": 0})
    industries: dict = defaultdict(lambda: {"sent": 0, "replies": 0, "interested": 0})

    for day in days:
        for order in day["sent_orders"]:
            row = day["queue_by_order"].get(order)
            if not row:
                continue
            cell = f"{row['件名ABグループ']}x{row['送付形式']}"
            industry = row["業界"]
            cells[cell]["sent"] += 1
            industries[industry]["sent"] += 1

            reply = replies_by_email.get(row["送信先"].strip().lower())
            if reply:
                cells[cell]["replies"] += 1
                industries[industry]["replies"] += 1
                if reply.get("classification") == "希望":
                    cells[cell]["interested"] += 1
                    industries[industry]["interested"] += 1
    return {"cells": dict(cells), "industries": dict(industries)}


def fetch_engagement(days: list[dict]) -> dict:
    """計測 API から開封・クリックを取る。失敗してもレポート自体は出す。"""
    totals = {
        "recipients": 0,
        "unique_opened": 0,
        "unique_clicked": 0,
        "available": True,
        "errors": [],
    }
    try:
        token = config.tracking_admin_token()
    except RuntimeError as error:
        totals["available"] = False
        totals["errors"].append(str(error))
        return totals

    for day in days:
        if not day["campaign_id"]:
            continue
        try:
            summary = tracking.fetch_summary(day["campaign_id"], token)
        except tracking.TrackingError as error:
            totals["errors"].append(str(error))
            continue
        totals["recipients"] += summary.get("recipientCount", 0)
        totals["unique_opened"] += summary.get("uniqueNonScannerOpened", 0)
        totals["unique_clicked"] += summary.get("uniqueNonScannerClicked", 0)
    if totals["errors"] and totals["recipients"] == 0:
        totals["available"] = False
    return totals


def percent(numerator: int, denominator: int) -> str:
    if not denominator:
        return "—"
    return f"{numerator / denominator * 100:.1f}%"


def business_days_back(end: date, count: int) -> list[str]:
    """end を含めて過去 count 営業日分の日付。"""
    days: list[str] = []
    cursor = end
    while len(days) < count:
        if config.is_business_day(cursor):
            days.append(cursor.isoformat())
        cursor -= timedelta(days=1)
    return list(reversed(days))


def render_daily(day: dict, engagement: dict, replies_available: bool,
                 reply_count: int, stock: dict) -> str:
    lines = [
        f"📧 営業メール日次レポート ({day['date']})",
        f"送信 {day['sent']} / エラー {day['errors']} / キュー {day['queued']}",
    ]
    if engagement["available"]:
        lines.append(
            f"ユニーク開封 {engagement['unique_opened']} "
            f"({percent(engagement['unique_opened'], engagement['recipients'])}) "
            "※スキャナ除外・参考値"
        )
        lines.append(
            f"ユニーククリック {engagement['unique_clicked']} "
            f"({percent(engagement['unique_clicked'], engagement['recipients'])})"
        )
    else:
        lines.append("開封・クリック: 取得失敗（計測 API に到達できず）")

    if replies_available:
        lines.append(f"返信 {reply_count}")
    else:
        lines.append("返信 未計測（gmail.readonly の認可待ち）")

    lines.append(
        f"📦 在庫 {stock['available']:,} 件 / "
        f"残り約 {stock['business_days_remaining']} 営業日"
    )
    return "\n".join(lines)


def render_cycle(days: list[dict], engagement: dict, tabs: dict,
                 replies_available: bool, stock: dict) -> str:
    total_sent = sum(day["sent"] for day in days)
    span = f"{days[0]['date']} 〜 {days[-1]['date']}"
    lines = [
        f"📊 営業メール サイクルレポート ({span} / {len(days)} 営業日)",
        f"送信 {total_sent} / エラー {sum(day['errors'] for day in days)}",
    ]
    if engagement["available"]:
        lines.append(
            f"ユニーククリック {engagement['unique_clicked']} "
            f"({percent(engagement['unique_clicked'], engagement['recipients'])}) "
            "← 主要指標"
        )
        lines.append(
            f"ユニーク開封 {engagement['unique_opened']} "
            f"({percent(engagement['unique_opened'], engagement['recipients'])}) "
            "※参考値"
        )

    lines.append("")
    lines.append("セル別  | 送信 | 返信率")
    for cell, stat in sorted(tabs["cells"].items()):
        rate = (
            percent(stat["replies"], stat["sent"])
            if replies_available
            else "未計測"
        )
        lines.append(f"{cell:7s} | {stat['sent']:4d} | {rate}")

    lines.append("")
    lines.append("業界別  | 送信 | 返信率")
    for industry, stat in sorted(
        tabs["industries"].items(), key=lambda item: -item[1]["sent"]
    ):
        rate = (
            percent(stat["replies"], stat["sent"])
            if replies_available
            else "未計測"
        )
        lines.append(f"{industry} | {stat['sent']:4d} | {rate}")

    lines.append("")
    lines.append(propose_allocation(tabs, replies_available))
    lines.append("")
    lines.append(
        f"📦 在庫 {stock['available']:,} 件 / "
        f"残り約 {stock['business_days_remaining']} 営業日"
    )
    lines.append(
        "配分を変える場合はこのスレッドで指示してください。"
        "指示が無ければ現行配分のまま継続します。"
    )
    return "\n".join(lines)


def propose_allocation(tabs: dict, replies_available: bool) -> str:
    """配分の提案。サンプルが足りなければ判断保留と明記する。"""
    if not replies_available:
        return (
            "💡 配分提案: 判断保留（返信が未計測のため）。"
            "均等配分を継続します。"
        )

    cells = tabs["cells"]
    if not cells:
        return "💡 配分提案: 判断保留（送信実績なし）。"

    enough = [
        cell
        for cell, stat in cells.items()
        if stat["replies"] >= MIN_REPLIES_PER_CELL
        or stat["sent"] >= MIN_SENDS_PER_CELL
    ]
    if len(enough) < len(cells):
        shortfall = ", ".join(sorted(set(cells) - set(enough)))
        return (
            f"💡 配分提案: 判断保留・均等配分継続。"
            f"サンプル不足のセル: {shortfall}"
            f"（閾値: 返信 {MIN_REPLIES_PER_CELL} 件 or 送信 {MIN_SENDS_PER_CELL} 通）"
        )

    ranked = sorted(
        cells.items(),
        key=lambda item: (
            item[1]["replies"] / item[1]["sent"] if item[1]["sent"] else 0
        ),
        reverse=True,
    )
    best, best_stat = ranked[0]
    worst, worst_stat = ranked[-1]
    return (
        f"💡 配分提案: {best} が返信率 "
        f"{percent(best_stat['replies'], best_stat['sent'])} で最良、"
        f"{worst} が {percent(worst_stat['replies'], worst_stat['sent'])} で最下位。"
        f"{best} へ配分を寄せることを提案します"
        f"（現行の文面世代: {allocation.copy_generation()}）。"
    )


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--mode", choices=("daily", "cycle"), default="daily")
    parser.add_argument(
        "--date",
        default="",
        help="対象日。既定は直近の営業日（日次は前営業日）",
    )
    parser.add_argument("--no-slack", action="store_true")
    args = parser.parse_args()

    if args.date:
        end = date.fromisoformat(config.resolve_run_date(args.date))
    else:
        # 前営業日の実績を報告する。
        cursor = date.today() - timedelta(days=1)
        while not config.is_business_day(cursor):
            cursor -= timedelta(days=1)
        end = cursor

    count = 1 if args.mode == "daily" else config.CYCLE_BUSINESS_DAYS
    dates = business_days_back(end, count)
    days = [load_day(value) for value in dates]

    replies, replies_available = load_replies()
    replies_by_email = {
        (row.get("email") or "").strip().lower(): row for row in replies
    }
    relevant_replies = sum(
        1
        for day in days
        for order in day["sent_orders"]
        if (day["queue_by_order"].get(order, {}).get("送信先", "").strip().lower())
        in replies_by_email
    )

    engagement = fetch_engagement(days)
    stock = inventory.snapshot()

    if args.mode == "daily":
        text = render_daily(
            days[-1], engagement, replies_available, relevant_replies, stock
        )
    else:
        tabs = cross_tab(days, replies_by_email)
        text = render_cycle(days, engagement, tabs, replies_available, stock)

    print(text)
    if not args.no_slack:
        notify.send(text)

    config.REPORT_DIR.mkdir(parents=True, exist_ok=True)
    (config.REPORT_DIR / f"{args.mode}-{end.isoformat()}.txt").write_text(
        text + "\n", encoding="utf-8"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
