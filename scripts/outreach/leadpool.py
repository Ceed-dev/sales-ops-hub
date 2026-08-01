#!/usr/bin/env python3
"""リードプールの正本管理。

有限バッチ（2,500 件のマスタ CSV に send_day 1〜5 を割り当てる方式）をやめ、
継続的に補充されるプールへ移行するための中核モジュール。

重複送信は営業上の事故になるため、除外判定はここに一元化する。除外元は
過去キャンペーンのディレクトリ・送信ログ・プール本体・配信停止リストの 4 つ。
"""

from __future__ import annotations

import csv
import html
import os
import re
import sys
import tempfile
from datetime import datetime
from pathlib import Path
from urllib.parse import urlparse, urlunparse

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from outreach import config  # noqa: E402

# プールの列。collector の出力に運用状態（status 系）を足した superset。
POOL_FIELDS = [
    "lead_id",
    "status",
    "industry",
    "prefecture",
    "search_tag",
    "company",
    "email",
    "email_use",
    "email_source_url",
    "homepage",
    "form_url",
    "domain",
    "confidence",
    "verification",
    "added_at",
    "queued_date",
    "sent_at",
    "hold_reason",
    "notes",
]

STATUS_NEW = "new"
STATUS_QUEUED = "queued"
STATUS_SENT = "sent"
STATUS_HELD = "held"
STATUS_SUPPRESSED = "suppressed"

SUPPRESSION_FIELDS = ["email", "domain", "reason", "added_at", "notes"]

EMAIL_RE = re.compile(
    r"(?<![\w.+-])([A-Z0-9._%+\-]+@[A-Z0-9.\-]+\.[A-Z]{2,})(?![\w.+-])",
    re.IGNORECASE,
)

_JP_SECOND_LEVEL = {"co.jp", "or.jp", "ne.jp", "ac.jp", "go.jp", "ed.jp"}

_COMPANY_SUFFIX_RE = re.compile(
    r"(株式会社|有限会社|合同会社|一般社団法人|医療法人(?:社団)?|"
    r"社会福祉法人|学校法人|（株）|\(株\))"
)


# --- 正規化（重複判定の基準） -----------------------------------------------


def root_domain(url_or_host: str) -> str:
    """URL でもホストでもメールアドレスでもルートドメインを返す。"""
    if not url_or_host:
        return ""
    host = urlparse(url_or_host).netloc if "://" in url_or_host else url_or_host
    host = host.lower().split("@")[-1].split(":")[0].strip(".")
    if host.startswith("www."):
        host = host[4:]
    parts = host.split(".")
    if len(parts) >= 3 and ".".join(parts[-2:]) in _JP_SECOND_LEVEL:
        return ".".join(parts[-3:])
    return ".".join(parts[-2:]) if len(parts) >= 2 else host


def normalize_company(value: str) -> str:
    """法人格・空白・記号を落として企業名を比較可能にする。"""
    value = html.unescape(value or "")
    value = re.sub(r"\s+", "", value).lower()
    value = _COMPANY_SUFFIX_RE.sub("", value)
    return re.sub(r"[^0-9a-zぁ-んァ-ヶ一-龠ー]", "", value)


def email_domain(email: str) -> str:
    return (email or "").strip().lower().split("@")[-1]


def clean_url(url: str) -> str:
    if not url:
        return ""
    parsed = urlparse(url.strip())
    if parsed.scheme not in ("http", "https"):
        return ""
    path = re.sub(r"/{2,}", "/", parsed.path or "/")
    return urlunparse(
        (parsed.scheme, parsed.netloc.lower(), path, "", parsed.query, "")
    )


def emails_in(raw: str) -> list[str]:
    """任意のテキストからメールアドレスを拾う（除外元 CSV の走査に使う）。"""
    return [match.lower() for match in EMAIL_RE.findall(html.unescape(raw or ""))]


# --- CSV 入出力 -------------------------------------------------------------


def read_csv(path: Path) -> tuple[list[str], list[dict]]:
    if not Path(path).is_file():
        return [], []
    with Path(path).open("r", encoding="utf-8-sig", newline="") as handle:
        reader = csv.DictReader(handle)
        return list(reader.fieldnames or []), list(reader)


def atomic_write_csv(path: Path, fieldnames: list[str], rows: list[dict]) -> None:
    """途中で落ちてもプールを壊さないよう一時ファイル経由で置換する。"""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temp_name = tempfile.mkstemp(
        prefix=f".{path.name}.", suffix=".tmp", dir=path.parent
    )
    try:
        with os.fdopen(fd, "w", encoding="utf-8-sig", newline="") as handle:
            writer = csv.DictWriter(
                handle, fieldnames=fieldnames, extrasaction="ignore"
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


# --- プール本体 -------------------------------------------------------------


def load_pool() -> list[dict]:
    _, rows = read_csv(config.LEADS_POOL_PATH)
    for row in rows:
        for field in POOL_FIELDS:
            row.setdefault(field, "")
    return rows


def save_pool(rows: list[dict]) -> None:
    atomic_write_csv(config.LEADS_POOL_PATH, POOL_FIELDS, rows)


def load_suppression() -> tuple[set[str], set[str]]:
    """配信停止・バウンス・断りのアドレスとドメイン。

    ここに載ったものは二度と送らない。返信検知が使えるようになるまでは
    Zack が手で追記する運用（プラン「未解決の論点」参照）。
    """
    _, rows = read_csv(config.SUPPRESSION_PATH)
    emails = set()
    domains = set()
    for row in rows:
        email = (row.get("email") or "").strip().lower()
        domain = (row.get("domain") or "").strip().lower()
        if email:
            emails.add(email)
        if domain:
            domains.add(root_domain(domain))
    return emails, domains


def load_history_exclusions() -> tuple[set[str], set[str], set[str]]:
    """過去に接触済みのアドレス・企業・ドメインを集める。

    走査対象は config.HISTORY_DIRS 配下の全 CSV と送信ログディレクトリ。
    列名を見て中身を拾うため、キャンペーンごとに列構成が違っても動く。

    重要: 旧実装は 2 ディレクトリ決め打ちで、2026-07-27 キャンペーンの
    送信済み 1,500 件が除外対象から漏れていた。ここで取りこぼすと
    同じ相手に二度送ることになる。
    """
    emails: set[str] = set()
    companies: set[str] = set()
    domains: set[str] = set()

    directories = list(config.HISTORY_DIRS) + [config.LOG_DIR, config.QUEUE_DIR]
    for directory in directories:
        if not Path(directory).is_dir():
            continue
        for path in sorted(Path(directory).glob("*.csv")):
            try:
                with path.open("r", encoding="utf-8-sig", newline="") as handle:
                    for row in csv.DictReader(handle):
                        _collect_exclusions(row, emails, companies, domains)
            except (csv.Error, UnicodeDecodeError, OSError):
                # 壊れた CSV 1 本で除外全体を落とさない。
                continue
    return emails, companies, domains


def _collect_exclusions(
    row: dict,
    emails: set[str],
    companies: set[str],
    domains: set[str],
) -> None:
    for key, value in row.items():
        value = (value or "").strip()
        if not value:
            continue
        key_lower = (key or "").lower()
        if "メール" in (key or "") or "email" in key_lower or key == "送信先":
            emails.update(emails_in(value))
        if key in {"企業名", "会社名"} or key_lower == "company":
            normalized = normalize_company(value)
            if normalized:
                companies.add(normalized)
        if key in {"HPリンク", "公式HP", "homepage"} or "hp" in key_lower:
            domain = root_domain(value)
            if domain:
                domains.add(domain)


def pool_exclusions(rows: list[dict]) -> tuple[set[str], set[str], set[str]]:
    """プール自身に既にいるリードを除外キーにする。"""
    emails = {(row.get("email") or "").strip().lower() for row in rows}
    companies = {normalize_company(row.get("company") or "") for row in rows}
    domains = {(row.get("domain") or "").strip().lower() for row in rows}
    return emails - {""}, companies - {""}, domains - {""}


def next_lead_id(rows: list[dict], run_date: str) -> callable:
    """`CEED-YYYYMMDD-NNNN` を採番する関数を返す。既存 ID と衝突させない。"""
    prefix = f"CEED-{run_date.replace('-', '')}-"
    used = {row.get("lead_id", "") for row in rows}
    counter = {"value": 0}

    def allocate() -> str:
        while True:
            counter["value"] += 1
            candidate = f"{prefix}{counter['value']:04d}"
            if candidate not in used:
                used.add(candidate)
                return candidate

    return allocate


def append_leads(new_rows: list[dict], run_date: str) -> dict:
    """新規リードをプールへ追記する。除外に触れたものは捨てる。

    戻り値には追加数と除外理由の内訳を入れる。0 件でも例外にはしない
    （日次運用で目標未達のたびに異常終了させないため）。
    """
    pool = load_pool()
    hist_emails, hist_companies, hist_domains = load_history_exclusions()
    pool_emails, pool_companies, pool_domains = pool_exclusions(pool)
    supp_emails, supp_domains = load_suppression()

    blocked_emails = hist_emails | pool_emails | supp_emails
    blocked_companies = hist_companies | pool_companies
    blocked_domains = hist_domains | pool_domains | supp_domains

    allocate = next_lead_id(pool, run_date)
    added_at = datetime.now(config.TIMEZONE).isoformat(timespec="seconds")
    stats = {
        "added": 0,
        "skipped_duplicate_email": 0,
        "skipped_duplicate_company": 0,
        "skipped_duplicate_domain": 0,
        "skipped_suppressed": 0,
        "skipped_invalid": 0,
    }

    for row in new_rows:
        email = (row.get("email") or "").strip().lower()
        if not email or "@" not in email:
            stats["skipped_invalid"] += 1
            continue
        domain = (row.get("domain") or "").strip().lower() or root_domain(email)
        company = normalize_company(row.get("company") or "")

        if email in supp_emails or domain in supp_domains:
            stats["skipped_suppressed"] += 1
            continue
        if email in blocked_emails:
            stats["skipped_duplicate_email"] += 1
            continue
        if company and company in blocked_companies:
            stats["skipped_duplicate_company"] += 1
            continue
        if domain and domain in blocked_domains:
            stats["skipped_duplicate_domain"] += 1
            continue

        entry = {field: (row.get(field) or "") for field in POOL_FIELDS}
        entry.update(
            {
                "lead_id": allocate(),
                "status": STATUS_NEW,
                "email": email,
                "domain": domain,
                "added_at": added_at,
            }
        )
        pool.append(entry)
        blocked_emails.add(email)
        if company:
            blocked_companies.add(company)
        if domain:
            blocked_domains.add(domain)
        stats["added"] += 1

    save_pool(pool)
    stats["pool_total"] = len(pool)
    return stats


def available_leads(rows: list[dict] | None = None) -> list[dict]:
    """キューへ回せるリード（status=new）。"""
    pool = load_pool() if rows is None else rows
    return [row for row in pool if row.get("status") == STATUS_NEW]


def apply_suppression_to_pool() -> int:
    """配信停止に載ったリードをプール側でも suppressed に落とす。

    build_queue の除外だけに頼らず、プール本体にも反映して在庫数を正しくする。
    """
    pool = load_pool()
    supp_emails, supp_domains = load_suppression()
    changed = 0
    for row in pool:
        if row.get("status") in {STATUS_SENT, STATUS_SUPPRESSED}:
            continue
        email = (row.get("email") or "").strip().lower()
        domain = (row.get("domain") or "").strip().lower()
        if email in supp_emails or domain in supp_domains:
            row["status"] = STATUS_SUPPRESSED
            row["hold_reason"] = "suppression_list"
            changed += 1
    if changed:
        save_pool(pool)
    return changed


def mark_status(lead_ids: set[str], status: str, **fields: str) -> int:
    """指定リードの status を更新する。"""
    pool = load_pool()
    changed = 0
    for row in pool:
        if row.get("lead_id") in lead_ids:
            row["status"] = status
            for key, value in fields.items():
                if key in POOL_FIELDS:
                    row[key] = value
            changed += 1
    if changed:
        save_pool(pool)
    return changed
