#!/usr/bin/env python3
"""公開されている法人の問い合わせ先を収集してリードプールへ追記する。

検索結果は候補となる公式サイトを見つけるためだけに使う。アドレスは
その公式サイト自体に掲載されている場合にのみ採用する（掲載元 URL を記録する）。

日次バッチとして動く。目標件数に届かなくても異常終了はしない
（届かないのは在庫の問題であって処理の失敗ではないため）。在庫が
閾値を割った場合は inventory.py が別途警告する。
"""

from __future__ import annotations

import argparse
import csv
import html
import json
import os
import random
import re
import sys
import threading
import time
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import date
from pathlib import Path
from urllib.parse import parse_qs, unquote, urljoin, urlparse, urlunparse

import requests
from bs4 import BeautifulSoup

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from outreach import config, leadpool, templates  # noqa: E402

DEFAULT_OUTPUT = config.DATA_ROOT / "discovery"

PREFECTURES = [
    "北海道", "青森", "岩手", "宮城", "秋田", "山形", "福島",
    "茨城", "栃木", "群馬", "埼玉", "千葉", "東京", "神奈川",
    "新潟", "富山", "石川", "福井", "山梨", "長野", "岐阜",
    "静岡", "愛知", "三重", "滋賀", "京都", "大阪", "兵庫",
    "奈良", "和歌山", "鳥取", "島根", "岡山", "広島", "山口",
    "徳島", "香川", "愛媛", "高知", "福岡", "佐賀", "長崎",
    "熊本", "大分", "宮崎", "鹿児島", "沖縄",
]

# 業界定義は config/industries.json が正本。旧実装ではここと templates 側に
# 二重定義されており、業界を足すたびに両方を直す必要があった。
_INDUSTRIES = templates.load_industries()
INDUSTRY_TAGS = {
    name: list(spec["search_tags"]) for name, spec in _INDUSTRIES.items()
}
INDUSTRY_TERMS = {
    name: tuple(spec["terms"]) for name, spec in _INDUSTRIES.items()
}

SEARCH_SUFFIXES = (
    '"お問い合わせ" "メール"',
    '"会社概要" "E-mail"',
    '"お問い合わせ" "info@"',
)

REGIONS = [
    ("北海道・東北", ["北海道", "青森", "岩手", "宮城", "秋田", "山形", "福島"]),
    ("北関東", ["茨城", "栃木", "群馬", "埼玉"]),
    ("南関東", ["千葉", "東京", "神奈川"]),
    ("甲信越・北陸", ["新潟", "富山", "石川", "福井", "山梨", "長野"]),
    ("東海", ["岐阜", "静岡", "愛知", "三重"]),
    ("近畿", ["滋賀", "京都", "大阪", "兵庫", "奈良", "和歌山"]),
    ("中国・四国", ["鳥取", "島根", "岡山", "広島", "山口", "徳島", "香川", "愛媛", "高知"]),
    ("九州・沖縄", ["福岡", "佐賀", "長崎", "熊本", "大分", "宮崎", "鹿児島", "沖縄"]),
]

CONTACT_TERMS = (
    "contact", "inquiry", "otoiawase", "toiawase", "company",
    "corporate", "about", "profile", "gaiyo", "form", "mail",
    "お問い合わせ", "お問合せ", "会社概要", "企業情報", "運営会社",
)

FORM_HOSTS = (
    "forms.gle", "docs.google.com/forms", "form.run", "hubspot",
    "hsforms", "salesforce", "pardot", "kintoneapp.com",
)

EXCLUDED_HOST_PARTS = (
    "duckduckgo.com", "google.com", "yahoo.co.jp", "bing.com",
    "facebook.com", "instagram.com", "x.com", "twitter.com", "youtube.com",
    "wikipedia.org", "prtimes.jp", "wantedly.com", "indeed.com",
    "townwork.net", "en-gage.net", "job-medley.com", "mynavi.jp",
    "suumo.jp", "homes.co.jp", "athome.co.jp", "rehouse.co.jp",
    "jalan.net", "travel.rakuten.co.jp", "booking.com", "tripadvisor",
    "ikyu.com", "rurubu.jp", "hotpepper.jp", "weddingpark.net",
    "mwed.jp", "zexy.net", "caloo.jp", "medicaldoc.jp", "byoinnavi.jp",
    "jsaas.jp", "baseconnect.in", "buffett-code.com", "mapion.co.jp",
)

FREE_MAIL_DOMAINS = (
    "gmail.com", "yahoo.co.jp", "outlook.jp", "outlook.com", "hotmail.com",
    "icloud.com", "me.com", "nifty.com", "mbr.nifty.com", "ocn.ne.jp",
    "plala.or.jp", "biglobe.ne.jp", "so-net.ne.jp", "tiki.ne.jp",
)

BAD_EMAIL_PARTS = (
    "example@", "sample@", "test@", "dummy@", "your-email", "yourname",
    "noreply", "no-reply", "donotreply", "sentry", "wixpress",
    "wordpress", "privacy@", "legal@", "abuse@", "webmaster@",
)

EXCLUDED_LOCAL_HINTS = (
    "recruit", "saiyo", "career", "job", "reserve", "reservation",
    "booking", "yoyaku", "patient", "customer", "support", "helpdesk",
    "privacy", "personal", "ir@", "investor",
)

EXCLUDED_LOCAL_EXACT = (
    "cs", "csg", "service", "guest", "member",
)

SALES_BLOCK_PHRASES = (
    "営業メールお断り", "営業目的のメール", "営業目的の連絡",
    "セールスお断り", "営業・勧誘", "営業や勧誘",
    "営業のご連絡は", "営業の連絡は", "営業メールはお控え",
)

PREFERRED_LOCAL_PREFIXES = (
    "info", "contact", "office", "hello", "mail", "business", "sales",
    "corporate", "pr", "public", "koho", "web", "general",
)

EMAIL_RE = re.compile(
    r"(?<![\w.+-])([A-Z0-9._%+\-]+@[A-Z0-9.\-]+\.[A-Z]{2,})(?![\w.+-])",
    re.IGNORECASE,
)
COMPANY_RE = re.compile(
    r"(株式会社|有限会社|合同会社|一般社団法人|医療法人(?:社団)?|"
    r"社会福祉法人|学校法人)[^\n|｜<>]{1,55}"
)

_thread_local = threading.local()


def session() -> requests.Session:
    current = getattr(_thread_local, "session", None)
    if current is None:
        current = requests.Session()
        current.headers.update({
            "User-Agent": (
                "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                "AppleWebKit/537.36 Chrome/126.0 Safari/537.36"
            ),
            "Accept-Language": "ja,en-US;q=0.8,en;q=0.6",
        })
        _thread_local.session = current
    return current


def clean_url(url: str) -> str:
    if not url:
        return ""
    parsed = urlparse(url.strip())
    if parsed.scheme not in ("http", "https"):
        return ""
    path = re.sub(r"/{2,}", "/", parsed.path or "/")
    return urlunparse((parsed.scheme, parsed.netloc.lower(), path, "", parsed.query, ""))


def root_domain(url_or_host: str) -> str:
    host = urlparse(url_or_host).netloc if "://" in url_or_host else url_or_host
    host = host.lower().split("@")[-1].split(":")[0].strip(".")
    if host.startswith("www."):
        host = host[4:]
    parts = host.split(".")
    if len(parts) >= 3 and ".".join(parts[-2:]) in {
        "co.jp", "or.jp", "ne.jp", "ac.jp", "go.jp", "ed.jp",
    }:
        return ".".join(parts[-3:])
    return ".".join(parts[-2:]) if len(parts) >= 2 else host


def normalize_company(value: str) -> str:
    value = html.unescape(value or "")
    value = re.sub(r"\s+", "", value).lower()
    value = re.sub(
        r"(株式会社|有限会社|合同会社|一般社団法人|医療法人(?:社団)?|"
        r"社会福祉法人|学校法人|（株）|\(株\))",
        "",
        value,
    )
    return re.sub(r"[^0-9a-zぁ-んァ-ヶ一-龠ー]", "", value)


def decode_ddg_url(href: str) -> str:
    href = html.unescape(href or "")
    if href.startswith("//"):
        href = "https:" + href
    parsed = urlparse(href)
    if "duckduckgo.com" in parsed.netloc:
        target = parse_qs(parsed.query).get("uddg", [""])[0]
        return clean_url(unquote(target))
    return clean_url(href)


def fetch(url: str, timeout: int = 14) -> requests.Response | None:
    try:
        response = session().get(url, timeout=timeout, allow_redirects=True)
        ctype = response.headers.get("content-type", "").lower()
        if response.status_code >= 400:
            return None
        if "html" not in ctype and not response.text.lstrip().startswith("<"):
            return None
        if not response.encoding or response.encoding.lower() in {
            "iso-8859-1", "ascii",
        }:
            response.encoding = response.apparent_encoding
        return response
    except requests.RequestException:
        return None


def is_excluded_host(url: str) -> bool:
    host = urlparse(url).netloc.lower()
    return not host or any(part in host for part in EXCLUDED_HOST_PARTS)


def discover_query(query: str, industry: str, prefecture: str, tag: str) -> list[dict]:
    endpoint = "https://html.duckduckgo.com/html/"
    try:
        response = session().get(
            endpoint,
            params={"q": query, "kl": "jp-jp"},
            timeout=20,
        )
    except requests.RequestException:
        return []
    if response.status_code != 200:
        return []
    soup = BeautifulSoup(response.text, "html.parser")
    found = []
    for result in soup.select(".result"):
        anchor = result.select_one(".result__a")
        if not anchor:
            continue
        url = decode_ddg_url(anchor.get("href", ""))
        if not url or is_excluded_host(url):
            continue
        title = anchor.get_text(" ", strip=True)
        snippet_node = result.select_one(".result__snippet")
        snippet = snippet_node.get_text(" ", strip=True) if snippet_node else ""
        found.append({
            "industry": industry,
            "prefecture": prefecture,
            "search_tag": tag,
            "query": query,
            "result_title": title,
            "result_snippet": snippet,
            "url": url,
            "domain": root_domain(url),
        })
    return found


def parse_grounded_candidates(raw: str, industry: str, query: str) -> list[dict]:
    raw = (raw or "").replace("```csv", "").replace("```", "")
    found = []
    for line in raw.splitlines():
        urls = re.findall(r"https?://[^\s,\"'<>）)]+", line)
        if not urls:
            continue
        url = clean_url(urls[0].rstrip("。、"))
        if not url or is_excluded_host(url):
            continue
        prefix = line[:line.find(url)].strip(" \t,\"'-")
        parts = [part.strip(" \t,\"'") for part in prefix.split(",") if part.strip()]
        prefecture = next((p for p in PREFECTURES if p in prefix), "")
        company = ""
        for part in reversed(parts):
            if part != prefecture and not part.lower().startswith(("会社名", "prefecture")):
                company = part
                break
        if not company:
            company = prefix[-80:]
        found.append({
            "industry": industry,
            "prefecture": prefecture,
            "search_tag": "Google検索候補",
            "query": query,
            "result_title": company,
            "result_snippet": "",
            "url": url,
            "domain": root_domain(url),
        })
    return found


def discover_region_with_gemini(
    industry: str,
    region_name: str,
    prefectures: list[str],
    variant: int,
) -> list[dict]:
    from google import genai
    from google.genai import types

    api_key = os.environ.get("GOOGLE_API_KEY")
    if not api_key:
        raise RuntimeError("GOOGLE_API_KEY is not set")
    tags = INDUSTRY_TAGS[industry]
    if variant == 0:
        focus = "、".join(tags[:4])
    else:
        focus = "、".join(tags[3:])
    query = (
        f"{industry}/{region_name}/variant-{variant + 1}: "
        + ",".join(prefectures)
    )
    prompt = f"""
日本国内の「{industry}」企業の公式サイト候補を調査してください。
対象地域: {region_name}（{", ".join(prefectures)}）
対象業態: {focus}

各都道府県につき最大30社、地域全体で可能な限り多く挙げてください。
Google検索で実在と公式サイトを確認できた企業だけにしてください。
ポータル、比較サイト、SNS、求人、ニュース記事、支店ページは除外してください。
同一企業・同一ドメインは1件だけにしてください。

出力はCSVデータ行だけとし、1行を次の順にしてください。
都道府県,会社名,公式サイトURL
説明、番号、Markdown表は不要です。
"""
    client = genai.Client(api_key=api_key)
    for attempt in range(3):
        try:
            response = client.models.generate_content(
                model=os.environ.get("GEMINI_MODEL", "gemini-2.5-flash"),
                contents=prompt,
                config=types.GenerateContentConfig(
                    tools=[types.Tool(google_search=types.GoogleSearch())],
                    max_output_tokens=32768,
                    temperature=0.1,
                ),
            )
            return parse_grounded_candidates(response.text or "", industry, query)
        except Exception:
            if attempt == 2:
                return []
            time.sleep(4 * (attempt + 1))
    return []


def extract_emails(raw: str) -> list[str]:
    raw = html.unescape(raw or "")
    emails = []
    for match in EMAIL_RE.findall(raw):
        email = match.lower().strip(".,;:()[]{}<>")
        if any(part in email for part in BAD_EMAIL_PARTS):
            continue
        if email.endswith((".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp")):
            continue
        local = email.split("@", 1)[0]
        if local in EXCLUDED_LOCAL_EXACT or any(
            hint in local for hint in EXCLUDED_LOCAL_HINTS
        ):
            continue
        emails.append(email)
    return list(dict.fromkeys(emails))


def link_score(text: str, href: str) -> int:
    blob = f"{text} {href}".lower()
    score = sum(3 for term in CONTACT_TERMS if term.lower() in blob)
    if any(host in blob for host in FORM_HOSTS):
        score += 6
    if any(term in blob for term in ("recruit", "career", "採用", "予約", "reserve")):
        score -= 6
    if any(term in blob for term in ("privacy", "terms", "login")):
        score -= 4
    return score


def extract_page(response: requests.Response) -> dict:
    soup = BeautifulSoup(response.text, "html.parser")
    for node in soup(["script", "style", "noscript"]):
        node.decompose()
    text = soup.get_text(" ", strip=True)
    emails = extract_emails(response.text + " " + text)
    links = []
    forms = []
    for anchor in soup.find_all("a"):
        href = anchor.get("href") or ""
        label = anchor.get_text(" ", strip=True)
        if href.startswith("mailto:"):
            emails.extend(extract_emails(unquote(href[7:].split("?")[0])))
            continue
        if href.startswith(("tel:", "javascript:", "#")):
            continue
        absolute = clean_url(urljoin(response.url, href))
        if not absolute:
            continue
        score = link_score(label, absolute)
        if score > 0:
            links.append((score, absolute, label))
    if soup.find("form"):
        forms.append(clean_url(response.url))
    links.sort(key=lambda item: (-item[0], len(item[1])))
    return {
        "soup": soup,
        "text": text,
        "emails": list(dict.fromkeys(emails)),
        "links": links,
        "forms": forms,
    }


def infer_company(soup: BeautifulSoup, page_text: str, fallback_title: str) -> str:
    for script in soup.find_all("script", attrs={"type": "application/ld+json"}):
        try:
            payload = json.loads(script.string or "{}")
        except (json.JSONDecodeError, TypeError):
            continue
        objects = payload if isinstance(payload, list) else [payload]
        for obj in objects:
            if not isinstance(obj, dict):
                continue
            types = obj.get("@type", "")
            types = types if isinstance(types, list) else [types]
            if any(t in {"Organization", "Corporation", "LocalBusiness", "Hotel", "MedicalClinic"} for t in types):
                name = str(obj.get("name", "")).strip()
                if 2 <= len(name) <= 80:
                    return name
    for selector, attr in (
        ('meta[property="og:site_name"]', "content"),
        ('meta[name="application-name"]', "content"),
    ):
        node = soup.select_one(selector)
        if node and node.get(attr):
            name = node.get(attr).strip()
            if 2 <= len(name) <= 80:
                return name
    match = COMPANY_RE.search(page_text[:12000])
    if match:
        return re.split(r"[。|｜・]", match.group(0))[0].strip()
    title = soup.title.get_text(" ", strip=True) if soup.title else fallback_title
    return re.split(r"[|｜–—\-]", title or fallback_title)[0].strip()[:80]


def valid_business_email(email: str, site_domain: str) -> bool:
    email_domain = root_domain(email.split("@", 1)[1])
    if not email_domain:
        return False
    return email_domain == site_domain or email_domain in FREE_MAIL_DOMAINS


def email_score(email: str, site_domain: str) -> tuple[int, int, str]:
    local, domain = email.split("@", 1)
    prefix_score = 0
    for index, prefix in enumerate(PREFERRED_LOCAL_PREFIXES):
        if local == prefix or local.startswith(prefix + ".") or local.startswith(prefix + "-"):
            prefix_score = 100 - index
            break
    domain_score = 20 if root_domain(domain) == site_domain else 0
    return (prefix_score + domain_score, -len(local), email)


def choose_form(forms: list[str], site_domain: str) -> str:
    for url in forms:
        host = urlparse(url).netloc.lower()
        if root_domain(host) == site_domain or any(part in host for part in FORM_HOSTS):
            return url
    return ""


def research_candidate(candidate: dict) -> dict | None:
    first = fetch(candidate["url"])
    if first is None:
        scheme = urlparse(candidate["url"]).scheme
        alternate = candidate["url"].replace(f"{scheme}://", "https://", 1)
        first = fetch(alternate)
    if first is None or is_excluded_host(first.url):
        return None

    site_domain = root_domain(first.url)
    first_data = extract_page(first)
    blocked_pages = {
        clean_url(first.url)
        for phrase in SALES_BLOCK_PHRASES
        if phrase in first_data["text"]
    }
    industry_blob = (
        candidate["result_title"] + " " + candidate["result_snippet"] + " "
        + first_data["text"][:12000]
    ).lower()
    if candidate["industry"] == "美容医療":
        medical = any(
            term in industry_blob
            for term in ("クリニック", "医院", "医療", "皮膚科", "形成外科", "美容外科")
        )
        aesthetic = any(
            term in industry_blob
            for term in ("美容", "医療脱毛", "aga", "形成外科")
        )
        industry_match = medical and aesthetic
    else:
        industry_match = any(
            term.lower() in industry_blob
            for term in INDUSTRY_TERMS[candidate["industry"]]
        )
    if not industry_match:
        return None

    found_emails = [(email, clean_url(first.url)) for email in first_data["emails"]]
    forms = list(first_data["forms"])
    source_pages = [clean_url(first.url)]
    same_site_links = []
    for score, url, label in first_data["links"]:
        host = urlparse(url).netloc.lower()
        if root_domain(host) == site_domain or any(part in host for part in FORM_HOSTS):
            same_site_links.append((score, url, label))

    seen = {clean_url(first.url)}
    for _, url, _ in same_site_links[:7]:
        if url in seen:
            continue
        seen.add(url)
        page = fetch(url)
        if page is None:
            continue
        data = extract_page(page)
        page_url = clean_url(page.url)
        source_pages.append(page_url)
        if any(phrase in data["text"] for phrase in SALES_BLOCK_PHRASES):
            blocked_pages.add(page_url)
        found_emails.extend((email, page_url) for email in data["emails"])
        forms.extend(data["forms"])
        if data["soup"].find("form") or link_score("", page_url) >= 3:
            forms.append(page_url)

    accepted = {}
    for email, source_url in found_emails:
        if (
            source_url not in blocked_pages
            and valid_business_email(email, site_domain)
            and email not in accepted
        ):
            accepted[email] = source_url
    if not accepted:
        return None

    selected = max(accepted, key=lambda value: email_score(value, site_domain))
    company = infer_company(
        first_data["soup"], first_data["text"], candidate["result_title"]
    )
    if len(normalize_company(company)) < 2 or "�" in company:
        return None
    homepage = f"{urlparse(first.url).scheme}://{urlparse(first.url).netloc}/"
    form_url = choose_form(list(dict.fromkeys(forms)), site_domain)
    prefecture = candidate.get("prefecture", "")
    if not prefecture:
        prefecture = next(
            (name for name in PREFECTURES if name in first_data["text"][:20000]),
            "",
        )
    local = selected.split("@", 1)[0]
    email_use = (
        "法人・営業窓口" if any(local.startswith(p) for p in ("sales", "business"))
        else "広報窓口" if any(local.startswith(p) for p in ("pr", "koho", "public"))
        else "総合問い合わせ"
    )
    return {
        "industry": candidate["industry"],
        "prefecture": prefecture,
        "search_tag": candidate["search_tag"],
        "company": company,
        "email": selected,
        "email_use": email_use,
        "email_source_url": accepted[selected],
        "homepage": homepage,
        "form_url": form_url,
        "domain": site_domain,
        "confidence": "high" if root_domain(selected.split("@", 1)[1]) == site_domain else "medium",
        "verification": "公式サイト掲載メール確認",
        "notes": f"検索元: {candidate['query']}",
    }


def load_past_exclusions() -> tuple[set[str], set[str], set[str]]:
    """接触済みの相手を集める。判定ロジックは leadpool に一元化してある。

    旧実装はここに独自実装を持ち、参照先も過去 2 ディレクトリの決め打ちだった
    ため、2026-07-27 キャンペーンの送信済み 1,500 件を除外できていなかった。
    プールと配信停止リストもここで併せて除外する。
    """
    emails, companies, domains = leadpool.load_history_exclusions()
    pool_emails, pool_companies, pool_domains = leadpool.pool_exclusions(
        leadpool.load_pool()
    )
    supp_emails, supp_domains = leadpool.load_suppression()
    return (
        emails | pool_emails | supp_emails,
        companies | pool_companies,
        domains | pool_domains | supp_domains,
    )


def load_seed_file(path: Path | None) -> dict[str, list[dict]]:
    grouped: dict[str, list[dict]] = defaultdict(list)
    if not path or not path.exists():
        return grouped
    with path.open(encoding="utf-8-sig", newline="") as handle:
        for row in csv.DictReader(handle):
            industry = (row.get("industry") or "").strip()
            url = clean_url(row.get("url") or "")
            if industry not in INDUSTRY_TAGS or not url:
                continue
            grouped[industry].append({
                "industry": industry,
                "prefecture": "",
                "search_tag": "公開メール検索",
                "query": "公開メール掲載ページ検索",
                "result_title": "",
                "result_snippet": "",
                "url": url,
                "domain": root_domain(url),
            })
    return grouped


def parse_zennichi_page(page: int) -> list[dict]:
    url = (
        "https://www.zennichi.or.jp/member_search/list/"
        f"?prefecture=&branch=&address=&representative=&shogo=&shogo_kana="
        f"&license_holder=&number=&region=&hosho_approved=&pages={page}"
    )
    response = fetch(url, timeout=20)
    if response is None:
        return []
    soup = BeautifulSoup(response.text, "html.parser")
    rows = []
    for tr in soup.select("table.member-result-table tbody tr"):
        cells = tr.find_all("td", recursive=False)
        if len(cells) < 3:
            continue
        company_text = cells[1].get_text(" ", strip=True)
        company = re.split(r"代表者[:：]", company_text)[0].strip()
        contact_text = cells[2].get_text(" ", strip=True)
        emails = extract_emails(contact_text)
        if not company or not emails:
            continue
        homepage = ""
        for anchor in cells[2].find_all("a", href=True):
            target = clean_url(anchor["href"])
            if target and not is_excluded_host(target):
                homepage = target
                break
        prefecture = next(
            (name for name in PREFECTURES if name in contact_text),
            "",
        )
        email = max(
            emails,
            key=lambda value: email_score(
                value,
                root_domain(homepage) if homepage else root_domain(value.split("@", 1)[1]),
            ),
        )
        email_domain = root_domain(email.split("@", 1)[1])
        site_domain = root_domain(homepage) if homepage else email_domain
        rows.append({
            "industry": "不動産",
            "prefecture": prefecture,
            "search_tag": "全日本不動産協会会員",
            "company": company,
            "email": email,
            "email_use": "総合問い合わせ",
            "email_source_url": url,
            "homepage": homepage,
            "form_url": "",
            "domain": site_domain,
            "confidence": "high" if homepage and email_domain == site_domain else "medium",
            "verification": "全日本不動産協会の公開会員情報で確認",
            "notes": f"協会会員名簿 page={page}",
        })
    return rows


def collect_zennichi(
    target: int,
    workers: int,
    excluded_emails: set[str],
    excluded_companies: set[str],
    excluded_domains: set[str],
) -> list[dict]:
    accepted = []
    seen_emails: set[str] = set()
    seen_companies: set[str] = set()
    seen_domains: set[str] = set()
    for start in range(1, 1200, workers * 3):
        pages = range(start, start + workers * 3)
        with ThreadPoolExecutor(max_workers=workers) as executor:
            results = executor.map(parse_zennichi_page, pages)
            for page_rows in results:
                for row in page_rows:
                    email = row["email"].lower()
                    company = normalize_company(row["company"])
                    domain = row["domain"]
                    domain_unique = domain not in FREE_MAIL_DOMAINS
                    if (
                        email in excluded_emails or email in seen_emails
                        or company in excluded_companies or company in seen_companies
                        or (
                            domain_unique
                            and (domain in excluded_domains or domain in seen_domains)
                        )
                    ):
                        continue
                    seen_emails.add(email)
                    seen_companies.add(company)
                    if domain_unique:
                        seen_domains.add(domain)
                    accepted.append(row)
                    if len(accepted) >= target:
                        return accepted
        print(f"[verify] 不動産: {len(accepted):,}/{target:,}", flush=True)
    return accepted


def write_csv(path: Path, rows: list[dict], fieldnames: list[str]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)


def load_jsonl(path: Path) -> list[dict]:
    if not path.exists():
        return []
    rows = []
    with path.open(encoding="utf-8") as handle:
        for line in handle:
            try:
                rows.append(json.loads(line))
            except json.JSONDecodeError:
                continue
    return rows


def append_jsonl(path: Path, rows: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as handle:
        for row in rows:
            handle.write(json.dumps(row, ensure_ascii=False) + "\n")


def discover_industry(
    industry: str,
    output_dir: Path,
    max_candidates: int,
    workers: int,
    backend: str,
) -> list[dict]:
    path = output_dir / f".candidates-{industry}.jsonl"
    existing = load_jsonl(path)
    by_domain = {row["domain"]: row for row in existing if row.get("domain")}
    if len(by_domain) >= max_candidates:
        return list(by_domain.values())

    if backend == "gemini":
        jobs = [
            (region_name, prefectures, variant)
            for variant in range(2)
            for region_name, prefectures in REGIONS
        ]
    else:
        jobs = []
        for prefecture in PREFECTURES:
            for tag in INDUSTRY_TAGS[industry]:
                suffix = SEARCH_SUFFIXES[(len(jobs) + len(tag)) % len(SEARCH_SUFFIXES)]
                jobs.append((f"{prefecture} {tag} {suffix}", prefecture, tag))
        random.Random(f"ceed-{industry}-20260727").shuffle(jobs)

    for start in range(0, len(jobs), workers):
        batch = jobs[start:start + workers]
        discovered = []
        with ThreadPoolExecutor(max_workers=workers) as executor:
            if backend == "gemini":
                futures = {
                    executor.submit(
                        discover_region_with_gemini,
                        industry,
                        region_name,
                        prefectures,
                        variant,
                    ): (region_name, variant)
                    for region_name, prefectures, variant in batch
                }
            else:
                futures = {
                    executor.submit(discover_query, query, industry, prefecture, tag):
                    (query, prefecture, tag)
                    for query, prefecture, tag in batch
                }
            for future in as_completed(futures):
                try:
                    discovered.extend(future.result())
                except Exception:
                    continue
        fresh = []
        for row in discovered:
            if row["domain"] and row["domain"] not in by_domain:
                by_domain[row["domain"]] = row
                fresh.append(row)
        if fresh:
            append_jsonl(path, fresh)
        print(
            f"[discover] {industry}: {len(by_domain):,}/{max_candidates:,}",
            flush=True,
        )
        if len(by_domain) >= max_candidates:
            break
        time.sleep(0.35)
    return list(by_domain.values())


def collect_industry(
    industry: str,
    candidates: list[dict],
    output_dir: Path,
    target: int,
    workers: int,
    excluded_emails: set[str],
    excluded_companies: set[str],
    excluded_domains: set[str],
    global_emails: set[str],
    global_companies: set[str],
    global_domains: set[str],
) -> list[dict]:
    checkpoint = output_dir / f".verified-{industry}.jsonl"
    verified = load_jsonl(checkpoint)
    accepted = []
    seen_emails = set(global_emails)
    seen_companies = set(global_companies)
    seen_domains = set(global_domains)

    def add_row(row: dict) -> bool:
        email = row["email"].lower()
        local = email.split("@", 1)[0]
        company = normalize_company(row["company"])
        domain = row["domain"]
        if (
            local in EXCLUDED_LOCAL_EXACT
            or any(hint in local for hint in EXCLUDED_LOCAL_HINTS)
            or email in excluded_emails or email in seen_emails
            or company in excluded_companies or company in seen_companies
            or domain in excluded_domains or domain in seen_domains
        ):
            return False
        seen_emails.add(email)
        seen_companies.add(company)
        seen_domains.add(domain)
        accepted.append(row)
        return True

    for row in verified:
        add_row(row)
    if len(accepted) >= target:
        return accepted[:target]

    completed_domains = {row.get("domain", "") for row in verified}
    pending = [
        row for row in candidates
        if row.get("domain")
        and row["domain"] not in completed_domains
        and row["domain"] not in excluded_domains
        and row["domain"] not in seen_domains
    ]
    random.Random(f"crawl-{industry}-20260727").shuffle(pending)

    for start in range(0, len(pending), 160):
        batch = pending[start:start + 160]
        results = []
        with ThreadPoolExecutor(max_workers=workers) as executor:
            futures = [executor.submit(research_candidate, row) for row in batch]
            for future in as_completed(futures):
                try:
                    result = future.result()
                except Exception:
                    result = None
                if result:
                    results.append(result)
        if results:
            append_jsonl(checkpoint, results)
            for result in results:
                add_row(result)
        print(f"[verify] {industry}: {len(accepted):,}/{target:,}", flush=True)
        if len(accepted) >= target:
            break
    return accepted[:target]


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--target-per-industry", type=int, default=500)
    parser.add_argument("--candidate-multiplier", type=float, default=4.5)
    parser.add_argument("--search-workers", type=int, default=5)
    parser.add_argument("--crawl-workers", type=int, default=20)
    parser.add_argument(
        "--discovery-backend",
        choices=("gemini", "ddg"),
        default="gemini",
    )
    parser.add_argument("--seed-file", type=Path)
    parser.add_argument(
        "--industries",
        nargs="+",
        choices=tuple(INDUSTRY_TAGS),
        default=list(INDUSTRY_TAGS),
    )
    parser.add_argument("--skip-discovery", action="store_true")
    parser.add_argument("--output-dir", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument(
        "--run-date",
        default="today",
        help="lead_id の採番に使う日付。today または YYYY-MM-DD",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="プールへ書き込まず、収集結果の件数だけ表示する",
    )
    args = parser.parse_args()

    if args.seed_file is None and config.SEEDS_PATH.is_file():
        # discover_seeds が積んだシードを既定の入力にする。
        args.seed_file = config.SEEDS_PATH
    run_date = config.resolve_run_date(args.run_date)

    args.output_dir.mkdir(parents=True, exist_ok=True)
    excluded_emails, excluded_companies, excluded_domains = load_past_exclusions()
    print(
        "[exclude] "
        f"emails={len(excluded_emails):,} "
        f"companies={len(excluded_companies):,} "
        f"domains={len(excluded_domains):,}",
        flush=True,
    )

    all_rows = []
    global_emails: set[str] = set()
    global_companies: set[str] = set()
    global_domains: set[str] = set()
    target_candidates = int(args.target_per_industry * args.candidate_multiplier)
    seed_rows = load_seed_file(args.seed_file)

    for industry in args.industries:
        if industry == "不動産":
            rows = collect_zennichi(
                args.target_per_industry,
                min(args.crawl_workers, 16),
                excluded_emails,
                excluded_companies,
                excluded_domains,
            )
        else:
            candidates = list(seed_rows.get(industry, []))
            if not args.skip_discovery and len(candidates) < target_candidates:
                supplemental = discover_industry(
                    industry,
                    args.output_dir,
                    target_candidates,
                    args.search_workers,
                    args.discovery_backend,
                )
                by_domain = {
                    row["domain"]: row
                    for row in candidates + supplemental
                    if row.get("domain")
                }
                candidates = list(by_domain.values())
            rows = collect_industry(
                industry,
                candidates,
                args.output_dir,
                args.target_per_industry,
                args.crawl_workers,
                excluded_emails,
                excluded_companies,
                excluded_domains,
                global_emails,
                global_companies,
                global_domains,
            )
        for row in rows:
            global_emails.add(row["email"].lower())
            global_companies.add(normalize_company(row["company"]))
            global_domains.add(row["domain"])
        all_rows.extend(rows)

    industry_order = {name: index for index, name in enumerate(INDUSTRY_TAGS)}
    all_rows.sort(key=lambda row: (industry_order[row["industry"]], row["company"]))

    summary = defaultdict(int)
    for row in all_rows:
        summary[row["industry"]] += 1

    if args.dry_run:
        print(
            json.dumps(
                {
                    "mode": "dry-run",
                    "collected": len(all_rows),
                    "by_industry": dict(summary),
                },
                ensure_ascii=False,
            ),
            flush=True,
        )
        return 0

    # send_day / daily_order の事前割り当ては廃止した。どのリードをいつ送るかは
    # build_queue が当日のプール状態から決める（有限バッチ方式の名残を断つ）。
    stats = leadpool.append_leads(all_rows, run_date)
    print(
        json.dumps(
            {
                "collected": len(all_rows),
                "by_industry": dict(summary),
                **stats,
                "pool": str(config.LEADS_POOL_PATH),
            },
            ensure_ascii=False,
        ),
        flush=True,
    )
    # 目標未達でも異常終了しない。届かないのは在庫の問題であって処理の失敗では
    # なく、日次で launchd に異常扱いされると本当の障害が埋もれる。
    # 在庫水位の警告は inventory.py が担当する。
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
