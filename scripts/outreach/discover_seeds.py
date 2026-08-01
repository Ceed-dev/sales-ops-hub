#!/usr/bin/env python3
"""業界団体の公開ディレクトリから公式サイト URL のシードを集める。

collect_contacts の入力になる。シードが尽きるとメール抽出も止まるため、
日次で追記していく。既に持っている URL は再取得しない。
"""

from __future__ import annotations

import csv
import json
import re
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from urllib.parse import urljoin, urlparse

import requests
from bs4 import BeautifulSoup

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from outreach import config  # noqa: E402

OUTPUT = config.SEEDS_PATH
SEED_FIELDS = ["industry", "company_hint", "url", "directory_source_url"]
HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 Chrome/126.0 Safari/537.36"
    ),
}
SOCIAL_HOSTS = {
    "facebook.com", "instagram.com", "twitter.com", "x.com",
    "youtube.com", "line.me",
}


def get_soup(url: str) -> BeautifulSoup | None:
    try:
        response = requests.get(url, headers=HEADERS, timeout=20)
        response.raise_for_status()
        if not response.encoding or response.encoding.lower() == "iso-8859-1":
            response.encoding = response.apparent_encoding
        return BeautifulSoup(response.text, "html.parser")
    except requests.RequestException:
        return None


def host(url: str) -> str:
    value = urlparse(url).netloc.lower().split(":")[0]
    return value[4:] if value.startswith("www.") else value


def valid_external(url: str, directory_host: str) -> bool:
    target = host(url)
    return bool(
        target
        and directory_host not in target
        and not any(target == social or target.endswith("." + social) for social in SOCIAL_HOSTS)
    )


def detail_official_url(job: tuple[str, str, str, str]) -> dict | None:
    industry, source, company, url = job
    soup = get_soup(url)
    if soup is None:
        return None
    directory_host = host(url)
    labels = ("公式サイトを見る", "オフィシャルサイト", "公式サイト", "ホームページ")
    for anchor in soup.find_all("a", href=True):
        label = anchor.get_text(" ", strip=True)
        target = urljoin(url, anchor["href"])
        if any(key in label for key in labels) and valid_external(target, directory_host):
            return {
                "industry": industry,
                "company_hint": company,
                "url": target,
                "directory_source_url": source,
            }
    return None


def renovation_jobs() -> list[tuple[str, str, str, str]]:
    source = "https://www.renovation.or.jp/app/member_list"
    soup = get_soup(source)
    if soup is None:
        return []
    jobs = []
    seen = set()
    for anchor in soup.find_all("a", href=True):
        target = urljoin(source, anchor["href"])
        if not re.search(r"/app/members/\d+/?$", target) or target in seen:
            continue
        seen.add(target)
        jobs.append(("建築・住宅", source, anchor.get_text(" ", strip=True), target))
    return jobs


def hotel_jobs() -> list[tuple[str, str, str, str]]:
    source = "https://www.j-hotel.or.jp/memberlist/"
    soup = get_soup(source)
    if soup is None:
        return []
    jobs = []
    seen = set()
    for anchor in soup.find_all("a", href=True):
        target = urljoin(source, anchor["href"])
        if not re.search(r"/hotel/\d+/?$", target) or target in seen:
            continue
        seen.add(target)
        jobs.append(("観光・宿泊", source, anchor.get_text(" ", strip=True), target))
    return jobs


def direct_external_seeds(
    industry: str,
    source_urls: list[str],
    required_terms: tuple[str, ...] = (),
) -> list[dict]:
    rows = []
    seen = set()
    for source in source_urls:
        soup = get_soup(source)
        if soup is None:
            continue
        directory_host = host(source)
        for anchor in soup.find_all("a", href=True):
            company = anchor.get_text(" ", strip=True)
            target = urljoin(source, anchor["href"])
            if not valid_external(target, directory_host):
                continue
            if required_terms and not any(
                term.lower() in company.lower() or term.lower() in target.lower()
                for term in required_terms
            ):
                continue
            key = host(target)
            if not key or key in seen:
                continue
            seen.add(key)
            rows.append({
                "industry": industry,
                "company_hint": company,
                "url": target,
                "directory_source_url": source,
            })
    return rows


def main() -> None:
    jobs = renovation_jobs() + hotel_jobs()
    rows = []
    with ThreadPoolExecutor(max_workers=20) as executor:
        for result in executor.map(detail_official_url, jobs):
            if result:
                rows.append(result)

    rows.extend(direct_external_seeds(
        "観光・宿泊",
        [f"https://www.anha.or.jp/area{index}-list/" for index in range(1, 10)],
    ))
    rows.extend(direct_external_seeds(
        "ブライダル",
        [
            "https://www.bia.or.jp/members/facility/",
            "https://www.bia.or.jp/members/related/",
        ],
        (
            "ブライダル", "ウェディング", "ウエディング", "婚礼",
            "結婚", "ドレス", "衣裳", "衣装", "写真", "フォト",
            "ホテル", "式場", "花嫁",
        ),
    ))

    existing = load_existing_seeds()
    by_key = {(row["industry"], host(row["url"])): row for row in existing}
    added = 0
    for row in rows:
        key = (row["industry"], host(row["url"]))
        if key in by_key:
            continue
        by_key[key] = row
        added += 1

    final = sorted(
        by_key.values(), key=lambda row: (row["industry"], row["company_hint"])
    )
    write_seeds(final)

    counts = {}
    for row in final:
        counts[row["industry"]] = counts.get(row["industry"], 0) + 1
    print(
        json.dumps(
            {
                "added": added,
                "total": len(final),
                "by_industry": counts,
                "output": str(OUTPUT),
            },
            ensure_ascii=False,
        )
    )


def load_existing_seeds() -> list[dict]:
    """既に持っているシード。上書きせず追記するために読む。"""
    if not OUTPUT.is_file():
        return []
    with OUTPUT.open("r", encoding="utf-8-sig", newline="") as handle:
        return [
            {field: (row.get(field) or "") for field in SEED_FIELDS}
            for row in csv.DictReader(handle)
            if (row.get("url") or "").strip()
        ]


def write_seeds(rows: list[dict]) -> None:
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    with OUTPUT.open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=SEED_FIELDS)
        writer.writeheader()
        writer.writerows(rows)


if __name__ == "__main__":
    main()
