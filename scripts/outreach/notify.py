#!/usr/bin/env python3
"""Slack 通知の共通ヘルパ。

方針:
    通知が飛ばないことを理由に送信パイプラインを止めない。Webhook が未設定でも
    ログへ書き出して処理を続行する。ただし「送れなかった」ことは戻り値で返し、
    呼び出し側が成功と誤認しないようにする。
"""

from __future__ import annotations

import json
import logging
import sys
import urllib.error
import urllib.request
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from outreach import config  # noqa: E402

LOG_FALLBACK_PATH = config.REPORT_DIR / "notifications.log"

# 通知の重大度。障害は必ず ALERT で送り、レポートは INFO で送る。
INFO = "INFO"
WARN = "WARN"
ALERT = "ALERT"

_PREFIX = {INFO: "", WARN: "⚠️ ", ALERT: "🚨 "}


def _write_fallback(level: str, title: str, body: str) -> None:
    LOG_FALLBACK_PATH.parent.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(config.TIMEZONE).isoformat(timespec="seconds")
    with LOG_FALLBACK_PATH.open("a", encoding="utf-8") as handle:
        handle.write(f"[{stamp}] {level} {title}\n{body}\n---\n")


def send(title: str, body: str = "", level: str = INFO) -> bool:
    """Slack へ通知する。送れたら True、フォールバックしたら False。

    戻り値を無視してよいのは、通知失敗が業務影響を持たない箇所だけ。
    """
    text = f"{_PREFIX.get(level, '')}{title}"
    if body:
        text = f"{text}\n{body}"

    if not config.SLACK_WEBHOOK_URL:
        logging.warning(
            "Slack Webhook が未設定のため通知をログへ退避した: %s", title
        )
        _write_fallback(level, title, body)
        return False

    payload = {"text": text}
    if config.SLACK_CHANNEL:
        payload["channel"] = config.SLACK_CHANNEL

    request = urllib.request.Request(
        config.SLACK_WEBHOOK_URL,
        data=json.dumps(payload).encode("utf-8"),
        method="POST",
        headers={"content-type": "application/json"},
    )
    try:
        with urllib.request.urlopen(request, timeout=15) as response:
            if 200 <= response.status < 300:
                return True
            logging.error("Slack が HTTP %s を返した", response.status)
    except (urllib.error.URLError, OSError) as error:
        logging.error("Slack への通知に失敗した: %s", error)

    _write_fallback(level, title, body)
    return False


def alert(title: str, body: str = "") -> bool:
    """障害通知。送信停止・キュー生成失敗など、放置すると営業が止まる事象に使う。"""
    return send(title, body, level=ALERT)


def warn(title: str, body: str = "") -> bool:
    """警告。在庫水位割れなど、当日は動くが放置すると詰まる事象に使う。"""
    return send(title, body, level=WARN)


if __name__ == "__main__":
    # 疎通確認用。`python3 scripts/outreach/notify.py "本文"` で 1 通送る。
    logging.basicConfig(level=logging.INFO)
    message = sys.argv[1] if len(sys.argv) > 1 else "outreach notify 疎通確認"
    delivered = send("Outreach 通知テスト", message)
    print(json.dumps({"delivered": delivered}, ensure_ascii=False))
