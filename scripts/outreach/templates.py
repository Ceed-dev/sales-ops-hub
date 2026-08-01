#!/usr/bin/env python3
"""営業メールの文面生成。

旧構成では件名・本文・業界定義が prepare-outreach-day2 に埋まっており、
prepare-outreach-remaining が importlib で day2 を、day2 が day1 を読み込む
連鎖になっていた。日付付きファイルが消えると壊れるため正式なモジュールへ移す。

文面を変えるときは config/allocation.json の copy 世代番号も上げること。
サイクルレポートが「どの世代の文面の成績か」を区別できなくなる。
"""

from __future__ import annotations

import html
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from outreach import config  # noqa: E402


class IndustryConfigError(RuntimeError):
    pass


def load_industries() -> dict:
    """業界定義を読む。欠けていたら黙って既定値を使わず落とす。"""
    path = config.INDUSTRIES_PATH
    if not Path(path).is_file():
        raise IndustryConfigError(f"業界定義が見つからない: {path}")
    data = json.loads(Path(path).read_text(encoding="utf-8"))
    industries = data.get("industries") or {}
    if not industries:
        raise IndustryConfigError(f"業界定義が空: {path}")
    return industries


def industry_names() -> list[str]:
    return list(load_industries().keys())


def _industry(name: str) -> dict:
    industries = load_industries()
    if name not in industries:
        raise IndustryConfigError(f"未定義の業界: {name}")
    return industries[name]


def tracking_id(industry: str) -> str:
    return _industry(industry)["tracking_id"]


def subject_for(industry: str, variant: str) -> str:
    """件名 A/B。A は業界名を差し込む型、B は実績を前に出す型。"""
    if variant == "A":
        label = _industry(industry)["subject_label"]
        return f"【30分無料診断】{label}領域のSNS・AI活用について"
    if variant == "B":
        return "【4,000万imp実績】SNS・AI活用の30分無料診断"
    raise ValueError(f"未知の件名バリアント: {variant}")


def body_for(industry: str, delivery_variant: str) -> str:
    """本文。LP 版はリンク、PDF 版は添付を案内する。"""
    if delivery_variant == "LP":
        resource = (
            "支援内容と実績は、以下のページにまとめています。\n"
            f"{config.LP_URL}"
        )
    elif delivery_variant == "PDF":
        resource = "支援内容と実績を添付資料にまとめております。"
    else:
        raise ValueError(f"未知の送付形式: {delivery_variant}")

    return f"""ご担当者様

突然のご連絡失礼いたします。
株式会社Ceed 代表取締役の高橋勇作と申します。

弊社では、AI動画制作、SNS運用、クリエイティブ生成、AI Agentを活用した業務自動化を、各社の事業課題や既存業務に合わせて支援しています。

{_industry(industry)["context"]}

Ceedでは独自AI Agentの開発を通じて、少人数で数百規模のSNSアカウントを運営し、立ち上げ3ヶ月で累計4,000万imp超を達成しました。

{resource}

現在、SNS・AI活用について30分の無料診断を実施しています。

すでにSNSを運用されている場合は、現在の体制や発信内容の改善余地を、まだ取り組まれていない場合は、立ち上げ方やAIを活用できる業務を整理します。

診断では、御社の状況を伺ったうえで、

・最初に試すべきSNS・AI施策
・AIで省力化できる業務
・導入する場合の優先順位

を具体的にお伝えします。

すぐの導入を前提としたものではありません。
無料診断をご希望の場合は、本メールに「希望」とだけご返信ください。

今後のご案内が不要な場合は、お手数ですが本メールへの返信にてお知らせください。

何卒よろしくお願いいたします。

--
株式会社Ceed 代表取締役
高橋勇作
東京都中央区日本橋茅場町1-8-1 茅場町一丁目平和ビル7階
{config.SENDER_EMAIL}
{config.COMPANY_URL}
"""


def render_html(
    text: str,
    destination_url: str,
    click_url: str,
    open_pixel_url: str,
) -> str:
    """本文を HTML 化し、遷移先 URL を計測リンクに 1 箇所だけ差し替える。

    差し替えを 1 回に限定しているのは、送信側の検証が計測リンクと
    開封ピクセルを各 1 個ずつしか許さないため。
    """
    escaped = html.escape(text)
    escaped_destination = html.escape(destination_url)
    escaped_click = html.escape(click_url, quote=True)
    linked = escaped.replace(
        escaped_destination,
        (
            f'<a href="{escaped_click}" '
            'style="color:#1155cc;text-decoration:underline">'
            f"{escaped_destination}</a>"
        ),
        1,
    )
    body = linked.replace("\n", "<br>\n")
    return (
        '<div style="font-family:Arial,Helvetica,sans-serif;'
        'font-size:14px;line-height:1.75;color:#202124">'
        f"{body}</div>"
        f'<img src="{html.escape(open_pixel_url, quote=True)}" '
        'width="1" height="1" alt="" style="display:none">'
    )


def destination_for(delivery_variant: str) -> str:
    """PDF 版は本文にリンクが無いため、計測リンクの遷移先は会社サイトにする。"""
    return config.LP_URL if delivery_variant == "LP" else config.COMPANY_URL
