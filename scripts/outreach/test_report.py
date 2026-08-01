#!/usr/bin/env python3
"""report と poll_replies の単体テスト。

返信が未計測のときに 0 件と表示すると「返信ゼロ」と誤読される。
未計測と 0 件の区別、およびサンプル不足時の判断保留を検証する。
"""

import sys
import unittest
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from outreach import config, poll_replies, report  # noqa: E402


class BusinessDayTests(unittest.TestCase):
    def test_weekend_is_not_a_business_day(self):
        self.assertFalse(config.is_business_day(date(2026, 8, 1)))  # 土
        self.assertFalse(config.is_business_day(date(2026, 8, 2)))  # 日
        self.assertTrue(config.is_business_day(date(2026, 7, 31)))  # 金

    def test_business_days_back_skips_weekend(self):
        # 2026-08-03(月) から 3 営業日 = 7/30(木) 7/31(金) 8/3(月)
        days = report.business_days_back(date(2026, 8, 3), 3)
        self.assertEqual(days, ["2026-07-30", "2026-07-31", "2026-08-03"])


class AllocationProposalTests(unittest.TestCase):
    def cells(self, sent, replies):
        return {
            "cells": {
                cell: {"sent": sent, "replies": replies, "interested": 0}
                for cell in ("AxLP", "AxPDF", "BxLP", "BxPDF")
            },
            "industries": {},
        }

    def test_holds_judgement_when_replies_unavailable(self):
        text = report.propose_allocation(self.cells(1000, 20), False)
        self.assertIn("判断保留", text)
        self.assertIn("未計測", text)

    def test_holds_judgement_when_sample_is_small(self):
        text = report.propose_allocation(self.cells(200, 2), True)
        self.assertIn("判断保留", text)
        self.assertIn("サンプル不足", text)

    def test_proposes_when_sample_is_sufficient(self):
        tabs = self.cells(1200, 12)
        tabs["cells"]["BxPDF"] = {"sent": 1200, "replies": 60, "interested": 5}
        text = report.propose_allocation(tabs, True)
        self.assertIn("BxPDF", text)
        self.assertNotIn("判断保留", text)

    def test_holds_judgement_without_any_sends(self):
        text = report.propose_allocation({"cells": {}, "industries": {}}, True)
        self.assertIn("判断保留", text)


class PercentTests(unittest.TestCase):
    def test_zero_denominator_is_not_zero_percent(self):
        """送信 0 のときに 0.0% と出すと実績が出たように誤読される。"""
        self.assertEqual(report.percent(0, 0), "—")

    def test_normal_rate(self):
        self.assertEqual(report.percent(25, 500), "5.0%")


class ReplyClassificationTests(unittest.TestCase):
    def test_opt_out_wins_over_interest(self):
        """配信停止の取りこぼしは法令上の問題になるため優先して判定する。"""
        self.assertEqual(
            poll_replies.classify("Re: 無料診断", "希望しません。配信停止でお願いします"),
            poll_replies.CLASS_OPT_OUT,
        )

    def test_bounce_is_detected(self):
        self.assertEqual(
            poll_replies.classify("Undelivered Mail Returned to Sender", ""),
            poll_replies.CLASS_BOUNCE,
        )

    def test_interested_reply(self):
        self.assertEqual(
            poll_replies.classify("Re: 30分無料診断", "希望"),
            poll_replies.CLASS_INTERESTED,
        )

    def test_auto_reply(self):
        self.assertEqual(
            poll_replies.classify("自動返信: お問い合わせ", "夏季休業のお知らせ"),
            poll_replies.CLASS_AUTO,
        )

    def test_decline(self):
        self.assertEqual(
            poll_replies.classify("Re: ご案内", "今回は見送らせていただきます"),
            poll_replies.CLASS_DECLINED,
        )

    def test_unknown_falls_back_to_other(self):
        self.assertEqual(
            poll_replies.classify("Re:", "ありがとうございました"),
            poll_replies.CLASS_OTHER,
        )


class ScopeGateTests(unittest.TestCase):
    def test_reply_polling_is_gated_on_read_scope(self):
        """認可が無い状態で受信箱を読みにいかないこと。"""
        self.assertIn(
            "gmail.readonly", poll_replies.GMAIL_READONLY_SCOPE
        )


if __name__ == "__main__":
    unittest.main()
