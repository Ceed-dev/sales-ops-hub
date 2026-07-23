#!/usr/bin/env python3
import argparse
import base64
import csv
import fcntl
import json
import logging
import os
import sys
import tempfile
import time
from datetime import date, datetime, timedelta
from email.message import EmailMessage
from email.policy import SMTP
from email.utils import formataddr, make_msgid
from pathlib import Path
from zoneinfo import ZoneInfo

from google.oauth2.credentials import Credentials
from googleapiclient.discovery import build
from googleapiclient.errors import HttpError


SENDER_EMAIL = "yusaku.takahashi@ceed.cloud"
SENDER_NAME = "株式会社Ceed 代表取締役 高橋勇作"
QUEUE_PATH = Path(
    "/Users/zacky/ceed-workspace/business/sales-leads-20260722/"
    "multisector-email-queue-subject-review-20260722.csv"
)
SEND_LOG_PATH = Path(
    "/Users/zacky/ceed-workspace/business/sales-leads-20260722/"
    "multisector-email-send-log-20260722.csv"
)
TOKEN_PATH = Path(
    "/Users/zacky/Library/Application Support/Ceed/outreach/gmail-oauth.json"
)
LOCK_PATH = Path(
    "/Users/zacky/Library/Application Support/Ceed/outreach/send.lock"
)
TIMEZONE = ZoneInfo("Asia/Tokyo")
GMAIL_SEND_SCOPE = "https://www.googleapis.com/auth/gmail.send"


class FatalSendError(RuntimeError):
    pass


def load_csv(path):
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        reader = csv.DictReader(handle)
        return list(reader.fieldnames or []), list(reader)


def atomic_write_csv(path, fieldnames, rows):
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temp_name = tempfile.mkstemp(
        prefix=f".{path.name}.", suffix=".tmp", dir=path.parent
    )
    try:
        with os.fdopen(fd, "w", encoding="utf-8-sig", newline="") as handle:
            writer = csv.DictWriter(
                handle, fieldnames=fieldnames, extrasaction="raise"
            )
            writer.writeheader()
            writer.writerows(rows)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temp_name, path)
    except Exception:
        try:
            os.unlink(temp_name)
        except FileNotFoundError:
            pass
        raise


def load_credentials(token_path=TOKEN_PATH):
    token = json.loads(token_path.read_text(encoding="utf-8"))
    if token.get("authorized_email") != SENDER_EMAIL:
        raise FatalSendError("OAuth token belongs to an unexpected account")
    scopes = token.get("scope") or []
    if GMAIL_SEND_SCOPE not in scopes:
        raise FatalSendError("OAuth token does not include Gmail send scope")
    return Credentials(
        token=None,
        refresh_token=token["refresh_token"],
        token_uri="https://oauth2.googleapis.com/token",
        client_id=token["client_id"],
        client_secret=token["client_secret"],
        scopes=[GMAIL_SEND_SCOPE],
    )


def build_email(row, recipient=None, subject_prefix=""):
    to_address = recipient or row["送信先"].strip()
    if not to_address or "@" not in to_address:
        raise ValueError("recipient address is invalid")
    if row["送信元"] != SENDER_EMAIL:
        raise ValueError("sender mismatch")
    offer_variant = row["送付形式"]
    attachment_path = row["添付PDF"].strip()
    if offer_variant == "LP" and attachment_path:
        raise ValueError("LP variant must not include an attachment")
    if offer_variant == "PDF":
        if not attachment_path or not Path(attachment_path).is_file():
            raise ValueError("PDF variant attachment is missing")
    if offer_variant not in {"LP", "PDF"}:
        raise ValueError("unknown delivery variant")
    if row["本文HTML"].count("/t/c/") != 1:
        raise ValueError("tracked click URL count must be one")
    if row["本文HTML"].count("/t/o/") != 1:
        raise ValueError("open pixel count must be one")

    message = EmailMessage(policy=SMTP)
    message["From"] = formataddr((SENDER_NAME, SENDER_EMAIL))
    message["To"] = to_address
    message["Reply-To"] = SENDER_EMAIL
    message["Subject"] = f"{subject_prefix}{row['件名']}"
    message["Message-ID"] = make_msgid(domain="ceed.cloud")
    message["List-Unsubscribe"] = (
        f"<mailto:{SENDER_EMAIL}?subject=配信停止>"
    )
    message.set_content(row["本文"])
    message.add_alternative(row["本文HTML"], subtype="html")

    if offer_variant == "PDF":
        path = Path(attachment_path)
        message.add_attachment(
            path.read_bytes(),
            maintype="application",
            subtype="pdf",
            filename=path.name,
        )
    return message


def encode_raw_message(message):
    return base64.urlsafe_b64encode(message.as_bytes()).decode().rstrip("=")


def gmail_send(service, message):
    response = (
        service.users()
        .messages()
        .send(userId="me", body={"raw": encode_raw_message(message)})
        .execute()
    )
    message_id = response.get("id", "")
    if not message_id:
        raise FatalSendError("Gmail API returned no message id")
    return message_id


def http_error_status(error):
    return getattr(error.resp, "status", None)


def is_fatal_http_error(error):
    status = http_error_status(error)
    return status in {401, 403, 408, 429} or (status is not None and status >= 500)


def sent_log_orders(log_rows):
    return {
        row["全体順"]
        for row in log_rows
        if row.get("status") == "sent" and row.get("gmail_message_id")
    }


def reconcile_queue(queue_rows, log_rows):
    log_by_order = {
        row["全体順"]: row
        for row in log_rows
        if row.get("status") == "sent" and row.get("gmail_message_id")
    }
    changed = False
    for row in queue_rows:
        logged = log_by_order.get(row["全体順"])
        if logged and row["status"] != "sent":
            row["送信判定"] = "sent"
            row["prep_status"] = "sent"
            row["status"] = "sent"
            row["sent_at"] = logged["sent_at"]
            row["notes"] = "送信ログから送信済み状態を復元。"
            changed = True
    return changed


def append_success_log(log_rows, row, sent_at, message_id):
    log_rows.append(
        {
            "全体順": row["全体順"],
            "バッチ番号": row["バッチ番号"],
            "企業名": row["企業名"],
            "送信先": row["送信先"],
            "件名": row["件名"],
            "送信判定": "sent",
            "prep_status": "sent",
            "status": "sent",
            "sent_at": sent_at,
            "gmail_message_id": message_id,
            "error": "",
            "notes": (
                f"Gmail API自動送信。{row['送付形式']}版。"
                "HTML計測と送付条件を確認済み。"
            ),
        }
    )


def append_error_log(log_rows, row, sent_at, error_text):
    log_rows.append(
        {
            "全体順": row["全体順"],
            "バッチ番号": row["バッチ番号"],
            "企業名": row["企業名"],
            "送信先": row["送信先"],
            "件名": row["件名"],
            "送信判定": "send_error",
            "prep_status": "send_error",
            "status": "send_error",
            "sent_at": sent_at,
            "gmail_message_id": "",
            "error": error_text[:200],
            "notes": "個別送信エラーのためスキップ。",
        }
    )


def mark_queue_sent(row, sent_at):
    row["送信判定"] = "sent"
    row["prep_status"] = "sent"
    row["status"] = "sent"
    row["sent_at"] = sent_at
    row["notes"] = (
        f"Gmail API自動送信済み。{row['送付形式']}版。"
        "HTML計測と送付条件を確認済み。"
    )


def mark_queue_error(row, error_text):
    row["送信判定"] = "send_error"
    row["prep_status"] = "send_error"
    row["status"] = "send_error"
    row["sent_at"] = ""
    row["notes"] = f"個別送信エラー: {error_text[:160]}"


def validate_queue(queue_rows, log_rows):
    if len(queue_rows) != 500:
        raise FatalSendError("queue row count changed")
    if len({row["送信先"].strip().lower() for row in queue_rows}) != 500:
        raise FatalSendError("queue recipients are not unique")
    duplicates = [
        order
        for order, count in __import__("collections").Counter(
            row["全体順"] for row in log_rows if row.get("status") == "sent"
        ).items()
        if count > 1
    ]
    if duplicates:
        raise FatalSendError("send log contains duplicate successful orders")
    for row in queue_rows:
        if row["status"] == "pending_send":
            build_email(row)


def within_start_window(run_date, start_hour, start_minute, window_minutes):
    now = datetime.now(TIMEZONE)
    expected_date = date.fromisoformat(run_date)
    start = datetime(
        expected_date.year,
        expected_date.month,
        expected_date.day,
        start_hour,
        start_minute,
        tzinfo=TIMEZONE,
    )
    return start <= now <= start + timedelta(minutes=window_minutes)


def test_messages(service, queue_rows, recipient):
    samples = {
        variant: next(
            row
            for row in queue_rows
            if row["status"] == "pending_send" and row["送付形式"] == variant
        )
        for variant in ("LP", "PDF")
    }
    ids = {}
    for variant, row in samples.items():
        test_row = dict(row)
        test_row["本文"] = (
            f"自動送信経路の{variant}版テストです。\n"
            "実営業キューの送信状態は変更しません。"
        )
        test_row["本文HTML"] = (
            "<div>自動送信経路の"
            f"{variant}版テストです。"
            '<a href="https://sales-ops-bot-863195311806.asia-northeast1.run.app/'
            't/c/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA">確認リンク</a>'
            "</div>"
            '<img src="https://sales-ops-bot-863195311806.asia-northeast1.run.app/'
            't/o/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA.gif" '
            'width="1" height="1" alt="" style="display:none">'
        )
        ids[variant] = gmail_send(
            service,
            build_email(
                test_row,
                recipient=recipient,
                subject_prefix=f"[AUTO TEST {variant}] ",
            ),
        )
    return ids


def run(args):
    LOCK_PATH.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    with LOCK_PATH.open("w", encoding="utf-8") as lock_handle:
        try:
            fcntl.flock(lock_handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise FatalSendError("another sender process is active") from error

        queue_fields, queue_rows = load_csv(QUEUE_PATH)
        log_fields, log_rows = load_csv(SEND_LOG_PATH)
        if reconcile_queue(queue_rows, log_rows):
            atomic_write_csv(QUEUE_PATH, queue_fields, queue_rows)
        validate_queue(queue_rows, log_rows)

        credentials = load_credentials()
        service = build(
            "gmail",
            "v1",
            credentials=credentials,
            cache_discovery=False,
        )
        if args.test_recipient:
            ids = test_messages(service, queue_rows, args.test_recipient)
            print(json.dumps({"test_sent": ids}, ensure_ascii=False))
            return 0

        pending = [
            row
            for row in queue_rows
            if row["status"] == "pending_send"
            and row["全体順"] not in sent_log_orders(log_rows)
        ]
        if not args.execute:
            counts = {
                variant: sum(
                    row["送付形式"] == variant for row in pending
                )
                for variant in ("LP", "PDF")
            }
            print(
                json.dumps(
                    {"mode": "dry-run", "pending": len(pending), **counts},
                    ensure_ascii=False,
                )
            )
            return 0
        if not within_start_window(
            args.run_date,
            args.start_hour,
            args.start_minute,
            args.start_window_minutes,
        ):
            raise FatalSendError("outside the authorized start window")

        sent_count = 0
        error_count = 0
        for row in pending[: args.max_messages]:
            try:
                message_id = gmail_send(service, build_email(row))
                sent_at = datetime.now(ZoneInfo("UTC")).replace(
                    microsecond=0
                ).isoformat().replace("+00:00", "Z")
                append_success_log(log_rows, row, sent_at, message_id)
                atomic_write_csv(SEND_LOG_PATH, log_fields, log_rows)
                mark_queue_sent(row, sent_at)
                atomic_write_csv(QUEUE_PATH, queue_fields, queue_rows)
                sent_count += 1
                logging.info(
                    "sent order=%s variant=%s",
                    row["全体順"],
                    row["送付形式"],
                )
            except HttpError as error:
                status = http_error_status(error)
                if is_fatal_http_error(error):
                    raise FatalSendError(
                        f"Gmail API stopped the run with HTTP {status}"
                    ) from error
                error_text = f"Gmail API HTTP {status or 'unknown'}"
                failed_at = datetime.now(ZoneInfo("UTC")).replace(
                    microsecond=0
                ).isoformat().replace("+00:00", "Z")
                append_error_log(log_rows, row, failed_at, error_text)
                atomic_write_csv(SEND_LOG_PATH, log_fields, log_rows)
                mark_queue_error(row, error_text)
                atomic_write_csv(QUEUE_PATH, queue_fields, queue_rows)
                error_count += 1
                logging.warning("skipped order=%s", row["全体順"])
            except (OSError, ValueError) as error:
                raise FatalSendError(
                    f"local validation or file error at order {row['全体順']}"
                ) from error

            processed = sent_count + error_count
            if processed >= min(args.max_messages, len(pending)):
                break
            if args.batch_size and processed % args.batch_size == 0:
                time.sleep(args.batch_pause_seconds)
            else:
                time.sleep(args.delay_seconds)

        print(
            json.dumps(
                {
                    "sent": sent_count,
                    "errors": error_count,
                    "remaining": sum(
                        row["status"] == "pending_send" for row in queue_rows
                    ),
                },
                ensure_ascii=False,
            )
        )
        return 0


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("--execute", action="store_true")
    parser.add_argument("--test-recipient")
    parser.add_argument("--run-date", default="2026-07-24")
    parser.add_argument("--start-hour", type=int, default=9)
    parser.add_argument("--start-minute", type=int, default=0)
    parser.add_argument("--start-window-minutes", type=int, default=30)
    parser.add_argument("--max-messages", type=int, default=490)
    parser.add_argument("--delay-seconds", type=int, default=60)
    parser.add_argument("--batch-size", type=int, default=50)
    parser.add_argument("--batch-pause-seconds", type=int, default=900)
    return parser.parse_args()


if __name__ == "__main__":
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
    )
    try:
        raise SystemExit(run(parse_args()))
    except FatalSendError as error:
        logging.error("%s", error)
        raise SystemExit(1)
