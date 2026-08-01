#!/usr/bin/env python3
"""leadpool の単体テスト。

重複送信は営業上の事故になるため、除外判定を最優先で検証する。
"""

import csv
import importlib
import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from outreach import config, leadpool  # noqa: E402


def write_csv(path: Path, fieldnames, rows):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)


class NormalizationTests(unittest.TestCase):
    def test_root_domain_handles_jp_second_level(self):
        self.assertEqual(leadpool.root_domain("https://www.example.co.jp/a"), "example.co.jp")
        self.assertEqual(leadpool.root_domain("info@sub.example.com"), "example.com")
        self.assertEqual(leadpool.root_domain("example.or.jp"), "example.or.jp")

    def test_normalize_company_drops_legal_forms(self):
        self.assertEqual(
            leadpool.normalize_company("株式会社 テスト工務店"),
            leadpool.normalize_company("テスト工務店（株）"),
        )

    def test_emails_in_extracts_from_free_text(self):
        found = leadpool.emails_in("お問い合わせ: INFO@Example.co.jp まで")
        self.assertEqual(found, ["info@example.co.jp"])


class PoolIsolationMixin(unittest.TestCase):
    """プールと除外元をテンポラリへ隔離する。実データを一切触らない。"""

    def setUp(self):
        self._original_env = dict(os.environ)
        self._tmp = tempfile.TemporaryDirectory()
        root = Path(self._tmp.name)
        (root / "history").mkdir(parents=True, exist_ok=True)
        os.environ["OUTREACH_DATA_ROOT"] = str(root / "data")
        os.environ["OUTREACH_HISTORY_DIRS"] = str(root / "history")
        importlib.reload(config)
        importlib.reload(leadpool)
        self.root = root

    def tearDown(self):
        self._tmp.cleanup()
        os.environ.clear()
        os.environ.update(self._original_env)
        importlib.reload(config)
        importlib.reload(leadpool)

    def lead(self, **overrides):
        base = {
            "company": "株式会社テスト",
            "email": "info@test-example.com",
            "domain": "test-example.com",
            "industry": "建築・住宅",
            "homepage": "https://test-example.com/",
        }
        base.update(overrides)
        return base


class AppendLeadsTests(PoolIsolationMixin):
    def test_new_lead_is_added(self):
        stats = leadpool.append_leads([self.lead()], "2026-08-01")
        self.assertEqual(stats["added"], 1)
        pool = leadpool.load_pool()
        self.assertEqual(len(pool), 1)
        self.assertEqual(pool[0]["status"], leadpool.STATUS_NEW)
        self.assertTrue(pool[0]["lead_id"].startswith("CEED-20260801-"))

    def test_duplicate_within_same_batch_is_skipped(self):
        stats = leadpool.append_leads([self.lead(), self.lead()], "2026-08-01")
        self.assertEqual(stats["added"], 1)
        self.assertEqual(stats["skipped_duplicate_email"], 1)

    def test_lead_already_in_pool_is_skipped(self):
        leadpool.append_leads([self.lead()], "2026-08-01")
        stats = leadpool.append_leads([self.lead()], "2026-08-02")
        self.assertEqual(stats["added"], 0)
        self.assertEqual(stats["skipped_duplicate_email"], 1)

    def test_previously_sent_address_is_excluded(self):
        """過去キャンペーンの送信ログに載る相手へは二度と送らない。"""
        write_csv(
            self.root / "history" / "day1-send-log.csv",
            ["企業名", "送信先", "status"],
            [{"企業名": "別名義", "送信先": "info@test-example.com", "status": "sent"}],
        )
        stats = leadpool.append_leads([self.lead()], "2026-08-01")
        self.assertEqual(stats["added"], 0)
        self.assertEqual(stats["skipped_duplicate_email"], 1)

    def test_same_company_different_address_is_excluded(self):
        write_csv(
            self.root / "history" / "past.csv",
            ["企業名", "送信先"],
            [{"企業名": "株式会社テスト", "送信先": "other@somewhere.com"}],
        )
        stats = leadpool.append_leads(
            [self.lead(email="sales@test-example.com")], "2026-08-01"
        )
        self.assertEqual(stats["added"], 0)
        self.assertEqual(stats["skipped_duplicate_company"], 1)

    def test_suppressed_address_is_never_added(self):
        write_csv(
            config.SUPPRESSION_PATH,
            leadpool.SUPPRESSION_FIELDS,
            [{"email": "info@test-example.com", "reason": "配信停止"}],
        )
        stats = leadpool.append_leads([self.lead()], "2026-08-01")
        self.assertEqual(stats["added"], 0)
        self.assertEqual(stats["skipped_suppressed"], 1)

    def test_suppressed_domain_blocks_all_addresses(self):
        write_csv(
            config.SUPPRESSION_PATH,
            leadpool.SUPPRESSION_FIELDS,
            [{"domain": "test-example.com", "reason": "バウンス"}],
        )
        stats = leadpool.append_leads(
            [self.lead(email="anything@test-example.com")], "2026-08-01"
        )
        self.assertEqual(stats["added"], 0)
        self.assertEqual(stats["skipped_suppressed"], 1)

    def test_invalid_address_is_rejected(self):
        stats = leadpool.append_leads([self.lead(email="not-an-address")], "2026-08-01")
        self.assertEqual(stats["added"], 0)
        self.assertEqual(stats["skipped_invalid"], 1)

    def test_empty_input_does_not_raise(self):
        stats = leadpool.append_leads([], "2026-08-01")
        self.assertEqual(stats["added"], 0)
        self.assertEqual(stats["pool_total"], 0)


class StatusTests(PoolIsolationMixin):
    def test_apply_suppression_marks_existing_pool_rows(self):
        leadpool.append_leads([self.lead()], "2026-08-01")
        write_csv(
            config.SUPPRESSION_PATH,
            leadpool.SUPPRESSION_FIELDS,
            [{"email": "info@test-example.com", "reason": "配信停止"}],
        )
        self.assertEqual(leadpool.apply_suppression_to_pool(), 1)
        pool = leadpool.load_pool()
        self.assertEqual(pool[0]["status"], leadpool.STATUS_SUPPRESSED)
        self.assertEqual(leadpool.available_leads(), [])

    def test_sent_rows_are_not_downgraded_by_suppression(self):
        leadpool.append_leads([self.lead()], "2026-08-01")
        pool = leadpool.load_pool()
        leadpool.mark_status({pool[0]["lead_id"]}, leadpool.STATUS_SENT)
        write_csv(
            config.SUPPRESSION_PATH,
            leadpool.SUPPRESSION_FIELDS,
            [{"email": "info@test-example.com", "reason": "配信停止"}],
        )
        self.assertEqual(leadpool.apply_suppression_to_pool(), 0)
        self.assertEqual(leadpool.load_pool()[0]["status"], leadpool.STATUS_SENT)

    def test_available_leads_only_returns_new(self):
        leadpool.append_leads(
            [self.lead(), self.lead(email="a@other-example.com", company="別会社", domain="other-example.com")],
            "2026-08-01",
        )
        pool = leadpool.load_pool()
        leadpool.mark_status({pool[0]["lead_id"]}, leadpool.STATUS_QUEUED)
        self.assertEqual(len(leadpool.available_leads()), 1)


if __name__ == "__main__":
    unittest.main()
