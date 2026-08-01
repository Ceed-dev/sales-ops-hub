#!/usr/bin/env python3
"""開封・クリック計測の recipient 登録。

計測基盤（Cloud Run sales-ops-bot + Firestore）は実装済みで、ここは
その管理 API を叩くクライアント。設計は
docs/plans/2026-07-22-email-engagement-tracking.md を参照。

登録は冪等（idempotencyKey で同じ token が返る）だが、ネットワーク往復を
毎回発生させないようローカルにもキャッシュする。
"""

from __future__ import annotations

import json
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from outreach import config  # noqa: E402


class TrackingError(RuntimeError):
    pass


def cache_path() -> Path:
    return config.CACHE_DIR / "tracking-registrations.json"


def load_cache() -> dict:
    path = cache_path()
    if not path.is_file():
        return {}
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        # 壊れたキャッシュで止めない。API 側が冪等なので再登録すれば復旧する。
        return {}


def save_cache(cache: dict) -> None:
    path = cache_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(cache, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


def utc_now() -> str:
    return (
        datetime.now(timezone.utc)
        .replace(microsecond=0)
        .isoformat()
        .replace("+00:00", "Z")
    )


def register(payload: dict, admin_token: str) -> dict:
    """recipient を登録して token / openPixelUrl / clickUrl を受け取る。

    エラー本文はそのまま例外に載せない（管理トークンが含まれる可能性を避ける）。
    """
    request = urllib.request.Request(
        config.TRACKING_REGISTER_URL,
        data=json.dumps(payload).encode("utf-8"),
        method="POST",
        headers={
            "content-type": "application/json",
            "x-email-tracking-admin-token": admin_token,
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            return json.loads(response.read())
    except urllib.error.HTTPError as error:
        raise TrackingError(
            f"計測登録が HTTP {error.code} で失敗した "
            f"(campaign={payload.get('campaignId')})"
        ) from error
    except (urllib.error.URLError, OSError) as error:
        raise TrackingError(f"計測登録に到達できない: {error}") from error


def register_lead(
    lead_id: str,
    campaign_id: str,
    industry_tracking_id: str,
    subject_variant: str,
    delivery_variant: str,
    destination_url: str,
    admin_token: str,
    cache: dict,
) -> dict:
    """1 リード分の計測登録。キャッシュに矛盾があれば止める。

    同じ lead_id に別条件で登録しようとした場合、黙って上書きすると
    集計が壊れるため例外にする。
    """
    expected = {
        "campaignId": campaign_id,
        "idempotencyKey": _idempotency_key(campaign_id, lead_id),
        "destinationUrl": destination_url,
        "industry": industry_tracking_id,
        "subjectVariant": f"subject_{subject_variant.lower()}",
        "bodyVariant": f"diagnosis_{delivery_variant.lower()}",
    }
    cache_key = f"{campaign_id}::{lead_id}"
    cached = cache.get(cache_key)
    if cached:
        if cached["request"] != expected:
            raise TrackingError(
                f"計測キャッシュの条件が一致しない: {cache_key}"
            )
        return cached["response"]

    response = register({**expected, "sentAt": utc_now()}, admin_token)
    cache[cache_key] = {"request": expected, "response": response}
    return response


def _idempotency_key(campaign_id: str, lead_id: str) -> str:
    # API 側の制約: [A-Za-z0-9_-]{16,100}
    raw = f"{campaign_id}_{lead_id}".lower().replace("-", "_")
    return "".join(char for char in raw if char.isalnum() or char == "_")[:100]


def campaign_id_for(run_date: str, copy_generation: str = "v2") -> str:
    """日次キャンペーン ID。日付ごとに分けてサイクル集計を可能にする。"""
    return f"outreach_{run_date.replace('-', '')}_free_diagnosis_{copy_generation}"


def fetch_summary(campaign_id: str, admin_token: str) -> dict:
    """キャンペーンの集計を取得する。

    返却: recipientCount / uniqueNonScannerOpened / uniqueNonScannerClicked /
    nonScannerOpenRate / nonScannerClickRate / スキャナ別内訳。
    """
    request = urllib.request.Request(
        config.tracking_summary_url(campaign_id),
        method="GET",
        headers={"x-email-tracking-admin-token": admin_token},
    )
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            return json.loads(response.read())
    except urllib.error.HTTPError as error:
        raise TrackingError(
            f"集計取得が HTTP {error.code} で失敗した (campaign={campaign_id})"
        ) from error
    except (urllib.error.URLError, OSError) as error:
        raise TrackingError(f"集計 API に到達できない: {error}") from error
