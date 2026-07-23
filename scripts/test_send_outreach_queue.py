#!/usr/bin/env python3
import importlib.util
import tempfile
import unittest
from email import message_from_bytes
from pathlib import Path


SCRIPT_PATH = Path(__file__).with_name("send_outreach_queue.py")
SPEC = importlib.util.spec_from_file_location("send_outreach_queue", SCRIPT_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class FakeResponse:
    def __init__(self, status):
        self.status = status


class FakeHttpError(Exception):
    def __init__(self, status):
        self.resp = FakeResponse(status)


class OutreachSenderTests(unittest.TestCase):
    def base_row(self):
        return {
            "送信先": "recipient@example.com",
            "送信元": MODULE.SENDER_EMAIL,
            "送付形式": "LP",
            "添付PDF": "",
            "件名": "件名",
            "本文": "本文",
            "本文HTML": (
                '<a href="https://tracker.example/t/c/token">CTA</a>'
                '<img src="https://tracker.example/t/o/token.gif">'
            ),
        }

    def test_lp_message_has_no_attachment(self):
        message = MODULE.build_email(self.base_row())
        parsed = message_from_bytes(message.as_bytes())
        filenames = [
            part.get_filename() for part in parsed.walk() if part.get_filename()
        ]
        self.assertEqual(filenames, [])
        self.assertEqual(parsed["To"], "recipient@example.com")
        self.assertIn(MODULE.SENDER_EMAIL, parsed["From"])

    def test_pdf_message_attaches_exact_file(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "guide.pdf"
            path.write_bytes(b"%PDF-test")
            row = self.base_row()
            row["送付形式"] = "PDF"
            row["添付PDF"] = str(path)
            message = MODULE.build_email(row)
            filenames = [
                part.get_filename()
                for part in message.walk()
                if part.get_filename()
            ]
            self.assertEqual(filenames, ["guide.pdf"])

    def test_sender_mismatch_is_rejected(self):
        row = self.base_row()
        row["送信元"] = "other@example.com"
        with self.assertRaisesRegex(ValueError, "sender mismatch"):
            MODULE.build_email(row)

    def test_tracking_elements_are_required(self):
        row = self.base_row()
        row["本文HTML"] = "<div>missing tracking</div>"
        with self.assertRaisesRegex(ValueError, "tracked click"):
            MODULE.build_email(row)

    def test_rate_and_auth_errors_are_fatal(self):
        for status in (401, 403, 429, 500):
            self.assertTrue(MODULE.is_fatal_http_error(FakeHttpError(status)))
        self.assertFalse(MODULE.is_fatal_http_error(FakeHttpError(400)))


if __name__ == "__main__":
    unittest.main()
