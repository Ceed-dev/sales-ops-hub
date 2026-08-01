#!/usr/bin/env python3
"""templates の単体テスト。

送信側 (send_outreach_queue.build_email) は計測リンクと開封ピクセルが
各 1 個であることを要求し、違反すると送信全体が停止する。生成側でも
同じ不変条件を検証する。
"""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from outreach import config, templates  # noqa: E402

CLICK_URL = "https://tracker.example/t/c/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
PIXEL_URL = "https://tracker.example/t/o/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA.gif"


class IndustryConfigTests(unittest.TestCase):
    def test_all_five_industries_are_defined(self):
        names = templates.industry_names()
        self.assertEqual(
            set(names),
            {"建築・住宅", "不動産", "美容医療", "観光・宿泊", "ブライダル"},
        )

    def test_tracking_ids_are_unique(self):
        ids = [templates.tracking_id(name) for name in templates.industry_names()]
        self.assertEqual(len(ids), len(set(ids)))

    def test_unknown_industry_is_rejected(self):
        with self.assertRaises(templates.IndustryConfigError):
            templates.tracking_id("存在しない業界")


class SubjectTests(unittest.TestCase):
    def test_variant_a_embeds_industry_label(self):
        self.assertIn("住宅・建築", templates.subject_for("建築・住宅", "A"))

    def test_variant_b_is_industry_independent(self):
        subjects = {
            templates.subject_for(name, "B") for name in templates.industry_names()
        }
        self.assertEqual(len(subjects), 1)

    def test_unknown_variant_is_rejected(self):
        with self.assertRaises(ValueError):
            templates.subject_for("不動産", "C")


class BodyTests(unittest.TestCase):
    def test_lp_body_contains_lp_url(self):
        body = templates.body_for("不動産", "LP")
        self.assertIn(config.LP_URL, body)

    def test_pdf_body_mentions_attachment(self):
        body = templates.body_for("不動産", "PDF")
        self.assertIn("添付資料", body)

    def test_body_keeps_the_reply_cta(self):
        """主 CTA は「希望」の返信。ここが消えると返信率が測れなくなる。"""
        for variant in ("LP", "PDF"):
            self.assertIn("「希望」", templates.body_for("ブライダル", variant))

    def test_body_keeps_opt_out_notice(self):
        """配信停止の申し出先を必ず残す。"""
        self.assertIn("ご案内が不要な場合", templates.body_for("不動産", "LP"))

    def test_unknown_delivery_variant_is_rejected(self):
        with self.assertRaises(ValueError):
            templates.body_for("不動産", "FAX")


class RenderHtmlTests(unittest.TestCase):
    def render(self, industry, variant):
        body = templates.body_for(industry, variant)
        destination = templates.destination_for(variant)
        return templates.render_html(body, destination, CLICK_URL, PIXEL_URL)

    def test_exactly_one_click_and_one_pixel_for_every_combination(self):
        for industry in templates.industry_names():
            for variant in ("LP", "PDF"):
                with self.subTest(industry=industry, variant=variant):
                    html_body = self.render(industry, variant)
                    self.assertEqual(html_body.count("/t/c/"), 1)
                    self.assertEqual(html_body.count("/t/o/"), 1)

    def test_destination_differs_by_variant(self):
        self.assertEqual(templates.destination_for("LP"), config.LP_URL)
        self.assertEqual(templates.destination_for("PDF"), config.COMPANY_URL)

    def test_newlines_become_breaks(self):
        self.assertIn("<br>", self.render("不動産", "LP"))


if __name__ == "__main__":
    unittest.main()
