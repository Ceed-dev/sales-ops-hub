#!/usr/bin/env python3
"""営業メールへの返信を検知して分類する。

🔒 現在は起動しない。gmail.readonly スコープの追加にブラウザでの再認可が
必要で、2026-08-01 時点で実施できないため。認可が下りたら
scripts/authorize-gmail-send.mjs のスコープに gmail.readonly を足して
再認可し、launchd の report ジョブから呼ぶ。

主 CTA が「本メールに『希望』とだけご返信ください」であるため、
返信は最重要の指標であり、同時に配信停止の申し出が届く経路でもある。
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from outreach import config, leadpool, notify  # noqa: E402

GMAIL_READONLY_SCOPE = "https://www.googleapis.com/auth/gmail.readonly"

REPLY_FIELDS = [
    "email", "company", "thread_id", "message_id", "received_at",
    "classification", "snippet", "queue_date",
]

CLASS_INTERESTED = "希望"
CLASS_DECLINED = "断り"
CLASS_OPT_OUT = "配信停止"
CLASS_ABSENT = "不在・後日"
CLASS_AUTO = "自動返信"
CLASS_BOUNCE = "バウンス"
CLASS_OTHER = "その他"

# 判定は上から順に評価する。配信停止を取りこぼすと法令上の問題になるため、
# 希望よりも先に判定する。
_RULES = [
    (CLASS_BOUNCE, re.compile(
        r"(Mail Delivery|Undelivered Mail|配信不能|宛先不明|"
        r"delivery status notification|failure notice)", re.IGNORECASE)),
    (CLASS_OPT_OUT, re.compile(
        r"(配信停止|配信を停止|今後の(ご)?案内(は)?不要|"
        r"メールを?(送|お送り)らないで|送付.{0,4}停止|unsubscribe)")),
    (CLASS_AUTO, re.compile(
        r"(自動返信|自動応答|auto[- ]?reply|out of office|"
        r"休業期間|夏季休業|年末年始)", re.IGNORECASE)),
    (CLASS_DECLINED, re.compile(
        r"(お断り|見送(り|らせ)|不要です|間に合って|結構です|"
        r"必要ありません|遠慮)")),
    (CLASS_ABSENT, re.compile(r"(不在|後日|改めて|検討さ?せて)")),
    (CLASS_INTERESTED, re.compile(r"(希望|お願いします|詳細を|話を聞き)")),
]


def classify(subject: str, body: str) -> str:
    """件名と本文から返信を分類する。判定できないものは その他 にする。

    誤分類より取りこぼしを避ける設計にする。配信停止とバウンスを先に
    判定し、営業として拾いたい「希望」は最後に評価する。
    """
    blob = f"{subject}\n{body}"
    for label, pattern in _RULES:
        if pattern.search(blob):
            return label
    return CLASS_OTHER


def credentials_support_read() -> bool:
    """保存済みトークンが受信読み取りスコープを持つか。"""
    try:
        token = json.loads(config.TOKEN_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return False
    return GMAIL_READONLY_SCOPE in (token.get("scope") or [])


def load_credentials():
    from google.oauth2.credentials import Credentials

    token = json.loads(config.TOKEN_PATH.read_text(encoding="utf-8"))
    return Credentials(
        token=None,
        refresh_token=token["refresh_token"],
        token_uri="https://oauth2.googleapis.com/token",
        client_id=token["client_id"],
        client_secret=token["client_secret"],
        scopes=[GMAIL_READONLY_SCOPE],
    )


def sent_addresses(days_back: int) -> dict:
    """直近に送った宛先。返信の突合に使う。"""
    addresses = {}
    cutoff = datetime.now(config.TIMEZONE) - timedelta(days=days_back)
    for path in sorted(config.LOG_DIR.glob("outreach-send-log-*.csv")):
        stamp = path.stem.replace("outreach-send-log-", "")
        try:
            if datetime.fromisoformat(stamp).replace(
                tzinfo=config.TIMEZONE
            ) < cutoff:
                continue
        except ValueError:
            continue
        _, rows = leadpool.read_csv(path)
        for row in rows:
            if row.get("status") == "sent":
                addresses[row["送信先"].strip().lower()] = {
                    "company": row.get("企業名", ""),
                    "queue_date": stamp,
                }
    return addresses


def fetch_replies(service, addresses: dict, days_back: int) -> list[dict]:
    after = (datetime.now(timezone.utc) - timedelta(days=days_back)).strftime(
        "%Y/%m/%d"
    )
    query = f"in:inbox after:{after}"
    results = []
    page_token = None
    while True:
        response = (
            service.users()
            .messages()
            .list(userId="me", q=query, pageToken=page_token, maxResults=100)
            .execute()
        )
        for item in response.get("messages", []):
            message = (
                service.users()
                .messages()
                .get(userId="me", id=item["id"], format="metadata",
                     metadataHeaders=["From", "Subject", "Date"])
                .execute()
            )
            headers = {
                header["name"]: header["value"]
                for header in message.get("payload", {}).get("headers", [])
            }
            sender = headers.get("From", "")
            match = re.search(r"[\w.+-]+@[\w.-]+", sender)
            if not match:
                continue
            email = match.group(0).lower()
            if email not in addresses:
                continue
            subject = headers.get("Subject", "")
            snippet = message.get("snippet", "")
            results.append(
                {
                    "email": email,
                    "company": addresses[email]["company"],
                    "thread_id": message.get("threadId", ""),
                    "message_id": message.get("id", ""),
                    "received_at": headers.get("Date", ""),
                    "classification": classify(subject, snippet),
                    "snippet": snippet[:200],
                    "queue_date": addresses[email]["queue_date"],
                }
            )
        page_token = response.get("nextPageToken")
        if not page_token:
            break
    return results


def merge_replies(new_rows: list[dict]) -> tuple[int, list[dict]]:
    path = config.DATA_ROOT / "replies.csv"
    _, existing = leadpool.read_csv(path)
    seen = {row.get("message_id") for row in existing}
    added = [row for row in new_rows if row["message_id"] not in seen]
    merged = existing + added
    leadpool.atomic_write_csv(path, REPLY_FIELDS, merged)
    return len(added), added


def append_suppression(rows: list[dict]) -> int:
    """配信停止とバウンスを抑止リストへ追記する。

    ここを自動化しないと、申し出を受けた相手へ送り続けることになる。
    """
    targets = [
        row for row in rows
        if row["classification"] in {CLASS_OPT_OUT, CLASS_BOUNCE}
    ]
    if not targets:
        return 0
    _, existing = leadpool.read_csv(config.SUPPRESSION_PATH)
    known = {(row.get("email") or "").strip().lower() for row in existing}
    added_at = datetime.now(config.TIMEZONE).isoformat(timespec="seconds")
    added = [
        {
            "email": row["email"],
            "domain": "",
            "reason": row["classification"],
            "added_at": added_at,
            "notes": row["snippet"][:80],
        }
        for row in targets
        if row["email"] not in known
    ]
    if added:
        leadpool.atomic_write_csv(
            config.SUPPRESSION_PATH,
            leadpool.SUPPRESSION_FIELDS,
            existing + added,
        )
        leadpool.apply_suppression_to_pool()
    return len(added)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--days-back", type=int, default=21)
    parser.add_argument("--no-slack", action="store_true")
    args = parser.parse_args()

    if not credentials_support_read():
        message = (
            "受信読み取りの認可がないため返信を取得できない。"
            "scripts/authorize-gmail-send.mjs に gmail.readonly を足して"
            "再認可すると有効になる。"
        )
        print(json.dumps({"skipped": message}, ensure_ascii=False))
        # 認可待ちは障害ではないため異常終了させない。
        return 0

    from googleapiclient.discovery import build

    service = build(
        "gmail", "v1", credentials=load_credentials(), cache_discovery=False
    )
    addresses = sent_addresses(args.days_back)
    replies = fetch_replies(service, addresses, args.days_back)
    added_count, added_rows = merge_replies(replies)
    suppressed = append_suppression(added_rows)

    interested = [
        row for row in added_rows if row["classification"] == CLASS_INTERESTED
    ]
    if interested and not args.no_slack:
        body = "\n".join(
            f"・{row['company']} <{row['email']}> — {row['snippet'][:60]}"
            for row in interested
        )
        notify.send(f"🎯 「希望」返信 {len(interested)} 件", body)

    print(
        json.dumps(
            {
                "checked": len(addresses),
                "new_replies": added_count,
                "interested": len(interested),
                "suppressed_added": suppressed,
            },
            ensure_ascii=False,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
