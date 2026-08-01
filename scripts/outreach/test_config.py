#!/usr/bin/env python3
"""outreach.config の単体テスト。

検証対象は 2026-08-01 の Plan Phase 0 で入れた 3 点:
  1. run-date の `today` 解決（plist への日付焼き込み廃止）
  2. 添付の読み取り可否検証（macOS TCC による停止の検出）
  3. パスの環境変数上書き（常時稼働機への移設耐性）
"""

import importlib
import os
import stat
import sys
import tempfile
import unittest
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from outreach import config  # noqa: E402


class ResolveRunDateTests(unittest.TestCase):
    def test_today_resolves_to_current_date(self):
        self.assertEqual(config.resolve_run_date("today"), date.today().isoformat())

    def test_none_resolves_to_current_date(self):
        self.assertEqual(config.resolve_run_date(None), date.today().isoformat())

    def test_iso_date_is_passed_through(self):
        self.assertEqual(config.resolve_run_date("2026-07-29"), "2026-07-29")

    def test_invalid_date_is_rejected(self):
        with self.assertRaises(ValueError):
            config.resolve_run_date("2026/07/29")


class AttachmentReadabilityTests(unittest.TestCase):
    def test_readable_file_passes(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "deck.pdf"
            path.write_bytes(b"%PDF-test")
            config.assert_attachment_readable(path)

    def test_missing_file_is_reported(self):
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaisesRegex(config.AssetAccessError, "存在しない"):
                config.assert_attachment_readable(Path(directory) / "absent.pdf")

    def test_unreadable_file_explains_the_tcc_cause(self):
        if os.geteuid() == 0:
            self.skipTest("root ではパーミッションを無視するため検証できない")
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "deck.pdf"
            path.write_bytes(b"%PDF-test")
            path.chmod(stat.S_IWUSR)  # 書き込みのみ = 読み取り不可
            try:
                with self.assertRaises(config.AssetAccessError) as caught:
                    config.assert_attachment_readable(path)
                self.assertIn("TCC", str(caught.exception))
                self.assertIn("フルディスクアクセス", str(caught.exception))
            finally:
                path.chmod(stat.S_IRUSR | stat.S_IWUSR)


class PathOverrideTests(unittest.TestCase):
    def test_paths_follow_environment_variables(self):
        original = dict(os.environ)
        try:
            os.environ["OUTREACH_STATE_DIR"] = "/tmp/ceed-test-state"
            os.environ["OUTREACH_DATA_ROOT"] = "/tmp/ceed-test-data"
            reloaded = importlib.reload(config)
            self.assertEqual(reloaded.STATE_DIR, Path("/tmp/ceed-test-state"))
            self.assertEqual(
                reloaded.TOKEN_PATH,
                Path("/tmp/ceed-test-state/gmail-oauth.json"),
            )
            self.assertEqual(reloaded.ASSET_DIR, Path("/tmp/ceed-test-state/assets"))
            self.assertEqual(reloaded.DATA_ROOT, Path("/tmp/ceed-test-data"))
            self.assertEqual(
                reloaded.queue_path_for("2026-08-01"),
                Path("/tmp/ceed-test-data/queues/outreach-queue-2026-08-01.csv"),
            )
        finally:
            os.environ.clear()
            os.environ.update(original)
            importlib.reload(config)

    def test_defaults_avoid_tcc_protected_directories(self):
        protected = ("/Downloads", "/Desktop", "/Documents")
        for path in (config.ASSET_DIR, config.STATE_DIR, config.TOKEN_PATH):
            for name in protected:
                self.assertNotIn(name, str(path))


if __name__ == "__main__":
    unittest.main()
