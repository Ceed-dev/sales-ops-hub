#!/usr/bin/env python3
"""build_queue と allocation の単体テスト。

キューの検証が崩れると重複送信・配信停止無視に直結するため、
validate() の各条件を個別に落として確実に弾かれることを確認する。
"""

import csv
import importlib
import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from outreach import allocation, config, leadpool  # noqa: E402


class AllocationTests(unittest.TestCase):
    def test_equal_split_across_four_cells(self):
        sequence = allocation.assign(500, allocation.DEFAULT_CELLS)
        self.assertEqual(len(sequence), 500)
        counts = {}
        for cell in sequence:
            counts[cell] = counts.get(cell, 0) + 1
        self.assertEqual(sorted(counts.values()), [125, 125, 125, 125])

    def test_remainder_is_distributed_not_dropped(self):
        sequence = allocation.assign(502, allocation.DEFAULT_CELLS)
        self.assertEqual(len(sequence), 502)

    def test_weighted_split_follows_weights(self):
        cells = [
            {"subject_variant": "B", "delivery_variant": "PDF", "weight": 3},
            {"subject_variant": "A", "delivery_variant": "LP", "weight": 1},
        ]
        sequence = allocation.assign(400, cells)
        counts = {}
        for cell in sequence:
            counts[cell] = counts.get(cell, 0) + 1
        self.assertEqual(counts[("B", "PDF")], 300)
        self.assertEqual(counts[("A", "LP")], 100)

    def test_cells_are_interleaved_so_partial_sends_stay_balanced(self):
        """途中で送信が止まってもセルが偏らないこと。"""
        sequence = allocation.assign(500, allocation.DEFAULT_CELLS)
        first_twenty = set(sequence[:20])
        self.assertEqual(len(first_twenty), 4)

    def test_zero_weight_cell_receives_nothing(self):
        cells = [
            {"subject_variant": "A", "delivery_variant": "LP", "weight": 1},
            {"subject_variant": "B", "delivery_variant": "PDF", "weight": 0},
        ]
        sequence = allocation.assign(100, cells)
        self.assertEqual(len(sequence), 100)
        self.assertNotIn(("B", "PDF"), set(sequence))


class ValidateTests(unittest.TestCase):
    """validate() は実データを読むため、隔離環境で動かす。"""

    def setUp(self):
        self._original_env = dict(os.environ)
        self._tmp = tempfile.TemporaryDirectory()
        root = Path(self._tmp.name)
        (root / "history").mkdir(parents=True, exist_ok=True)
        (root / "assets").mkdir(parents=True, exist_ok=True)
        (root / "assets" / "deck.pdf").write_bytes(b"%PDF-test")
        os.environ["OUTREACH_DATA_ROOT"] = str(root / "data")
        os.environ["OUTREACH_HISTORY_DIRS"] = str(root / "history")
        os.environ["OUTREACH_ASSET_DIR"] = str(root / "assets")
        importlib.reload(config)
        importlib.reload(leadpool)
        global build_queue
        from outreach import build_queue as module

        build_queue = importlib.reload(module)
        self.root = root
        self.sender = build_queue.load_sender_module()

    def tearDown(self):
        self._tmp.cleanup()
        os.environ.clear()
        os.environ.update(self._original_env)
        importlib.reload(config)
        importlib.reload(leadpool)

    def row(self, **overrides):
        base = {
            "送信先": "info@example-a.com",
            "送信元": config.SENDER_EMAIL,
            "送付形式": "LP",
            "添付PDF": "",
            "件名": "件名",
            "件名ABグループ": "A",
            "業界": "不動産",
            "本文": "本文",
            "本文HTML": (
                '<a href="https://tracker.example/t/c/token">CTA</a>'
                '<img src="https://tracker.example/t/o/token.gif">'
            ),
        }
        base.update(overrides)
        return base

    def test_valid_queue_passes(self):
        build_queue.validate([self.row()], self.sender)

    def test_empty_queue_is_rejected(self):
        with self.assertRaisesRegex(build_queue.QueueBuildError, "空"):
            build_queue.validate([], self.sender)

    def test_duplicate_address_within_queue_is_rejected(self):
        with self.assertRaisesRegex(build_queue.QueueBuildError, "重複"):
            build_queue.validate([self.row(), self.row()], self.sender)

    def test_previously_sent_address_is_rejected(self):
        path = self.root / "history" / "sent.csv"
        with path.open("w", encoding="utf-8-sig", newline="") as handle:
            writer = csv.DictWriter(
                handle, fieldnames=["送信先", "status", "gmail_message_id"]
            )
            writer.writeheader()
            writer.writerow(
                {
                    "送信先": "info@example-a.com",
                    "status": "sent",
                    "gmail_message_id": "abc123",
                }
            )
        with self.assertRaisesRegex(build_queue.QueueBuildError, "送信済み"):
            build_queue.validate([self.row()], self.sender)

    def test_unsent_candidate_list_does_not_block_the_queue(self):
        """未送信の候補リストに載っているだけでは送信を止めない。"""
        path = self.root / "history" / "candidates.csv"
        with path.open("w", encoding="utf-8-sig", newline="") as handle:
            writer = csv.DictWriter(handle, fieldnames=["email", "company"])
            writer.writeheader()
            writer.writerow({"email": "info@example-a.com", "company": "A社"})
        build_queue.validate([self.row()], self.sender)

    def test_suppressed_address_is_rejected(self):
        leadpool.atomic_write_csv(
            config.SUPPRESSION_PATH,
            leadpool.SUPPRESSION_FIELDS,
            [{"email": "info@example-a.com", "reason": "配信停止"}],
        )
        with self.assertRaisesRegex(build_queue.QueueBuildError, "配信停止"):
            build_queue.validate([self.row()], self.sender)

    def test_suppressed_domain_is_rejected(self):
        leadpool.atomic_write_csv(
            config.SUPPRESSION_PATH,
            leadpool.SUPPRESSION_FIELDS,
            [{"domain": "example-a.com", "reason": "バウンス"}],
        )
        with self.assertRaisesRegex(build_queue.QueueBuildError, "配信停止"):
            build_queue.validate([self.row()], self.sender)

    def test_attachment_outside_asset_dir_is_rejected(self):
        outside = self.root / "elsewhere.pdf"
        outside.write_bytes(b"%PDF-test")
        row = self.row(送付形式="PDF", 添付PDF=str(outside))
        with self.assertRaisesRegex(build_queue.QueueBuildError, "資産ディレクトリの外"):
            build_queue.validate([row], self.sender)

    def test_attachment_inside_asset_dir_passes(self):
        row = self.row(
            送付形式="PDF", 添付PDF=str(config.ASSET_DIR / "deck.pdf")
        )
        build_queue.validate([row], self.sender)

    def test_missing_tracking_pixel_is_rejected(self):
        row = self.row(本文HTML='<a href="https://x/t/c/t">CTA</a>')
        with self.assertRaises(ValueError):
            build_queue.validate([row], self.sender)

    def test_duplicated_tracking_link_is_rejected(self):
        row = self.row(
            本文HTML=(
                '<a href="https://x/t/c/a">A</a><a href="https://x/t/c/b">B</a>'
                '<img src="https://x/t/o/a.gif">'
            )
        )
        with self.assertRaises(ValueError):
            build_queue.validate([row], self.sender)

    def test_sender_mismatch_is_rejected(self):
        with self.assertRaises(ValueError):
            build_queue.validate([self.row(送信元="other@example.com")], self.sender)

    def test_attachment_picker_rejects_ambiguous_assets(self):
        (config.ASSET_DIR / "second.pdf").write_bytes(b"%PDF-2")
        with self.assertRaisesRegex(build_queue.QueueBuildError, "複数"):
            build_queue.attachment_path()


if __name__ == "__main__":
    unittest.main()
