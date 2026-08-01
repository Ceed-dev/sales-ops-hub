#!/usr/bin/env python3
"""送信先ドメインの MX 判定。

MX が引けないドメインへ送るとバウンスし、送信ドメインの評判を落とす。
キューへ入れるのは mx_ready のものだけに限る。

判定は `dig` に依存する（追加の Python 依存を増やさないため）。結果は
キャッシュして日々の再照会を避けるが、一時的失敗はキャッシュしない。
"""

from __future__ import annotations

import json
import re
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from outreach import config  # noqa: E402

VERDICT_READY = "mx_ready"
VERDICT_NULL_MX = "null_mx"
VERDICT_NO_MX = "no_mx"
VERDICT_NXDOMAIN = "nxdomain"
VERDICT_TEMPORARY = "dns_temporary"

# 一時的失敗は確定判定ではないため保存しない。翌日再挑戦させる。
_UNCACHEABLE = {VERDICT_TEMPORARY}


def cache_path() -> Path:
    return config.CACHE_DIR / "domain-mx-cache.json"


def load_cache() -> dict:
    path = cache_path()
    if not path.is_file():
        return {}
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return {}


def save_cache(cache: dict) -> None:
    path = cache_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    storable = {
        domain: result
        for domain, result in cache.items()
        if result.get("verdict") not in _UNCACHEABLE
    }
    path.write_text(
        json.dumps(storable, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


def utc_now() -> str:
    return (
        datetime.now(timezone.utc)
        .replace(microsecond=0)
        .isoformat()
        .replace("+00:00", "Z")
    )


def dig_mx(domain: str) -> dict:
    command = [
        "dig", "+time=3", "+tries=1", "+noall", "+comments", "+answer",
        "MX", domain,
    ]
    try:
        result = subprocess.run(
            command, capture_output=True, text=True, timeout=6, check=False
        )
    except (subprocess.TimeoutExpired, OSError) as error:
        return {
            "domain": domain,
            "dns_status": type(error).__name__,
            "verdict": VERDICT_TEMPORARY,
            "mx": [],
            "checked_at": utc_now(),
        }

    output = f"{result.stdout}\n{result.stderr}"
    match = re.search(r"status:\s*([A-Z]+)", output)
    status = match.group(1) if match else "COMMAND_ERROR"

    mx_targets = []
    for line in result.stdout.splitlines():
        if re.search(r"\sIN\s+MX\s+", line):
            parts = line.split()
            if len(parts) >= 2:
                mx_targets.append(parts[-1].rstrip(".").lower())

    if status == "NOERROR" and mx_targets and mx_targets != ["."]:
        verdict = VERDICT_READY
    elif status == "NOERROR" and mx_targets == ["."]:
        # RFC 7505 の null MX。メールを受け取らない明示的な宣言。
        verdict = VERDICT_NULL_MX
    elif status == "NOERROR":
        verdict = VERDICT_NO_MX
    elif status == "NXDOMAIN":
        verdict = VERDICT_NXDOMAIN
    else:
        verdict = VERDICT_TEMPORARY

    return {
        "domain": domain,
        "dns_status": status,
        "verdict": verdict,
        "mx": mx_targets,
        "checked_at": utc_now(),
    }


def resolve(domains, cache: dict | None = None, workers: int = 24) -> dict:
    """未判定ドメインを並列で照会する。一時的失敗は 1 度だけ再試行する。"""
    results = dict(cache or {})
    missing = [d for d in dict.fromkeys(domains) if d and d not in results]
    if not missing:
        return results

    with ThreadPoolExecutor(max_workers=workers) as executor:
        futures = {executor.submit(dig_mx, domain): domain for domain in missing}
        for future in as_completed(futures):
            domain = futures[future]
            try:
                results[domain] = future.result()
            except Exception as error:  # noqa: BLE001 - 1 件で全体を落とさない
                results[domain] = {
                    "domain": domain,
                    "dns_status": type(error).__name__,
                    "verdict": VERDICT_TEMPORARY,
                    "mx": [],
                    "checked_at": utc_now(),
                }

    retry = [d for d in missing if results[d]["verdict"] == VERDICT_TEMPORARY]
    if retry:
        time.sleep(2)
        with ThreadPoolExecutor(max_workers=8) as executor:
            futures = {executor.submit(dig_mx, domain): domain for domain in retry}
            for future in as_completed(futures):
                domain = futures[future]
                try:
                    results[domain] = future.result()
                except Exception:  # noqa: BLE001
                    pass
    return results


def is_sendable(verdict: str) -> bool:
    return verdict == VERDICT_READY
