"""営業メール自動化の設定を 1 箇所に集約する。

すべてのファイル位置は環境変数から解決する。常時稼働機（自宅の MacBook Air）へ
移設したときにソースを書き換えずに済ませるため。

注意（2026-08-01 の障害より）:
    macOS は ~/Downloads · ~/Desktop · ~/Documents を TCC で保護しており、
    launchd から起動したプロセスは既定でこれらを読めない。実際に添付 PDF を
    ~/Downloads に置いていたため送信が停止した。したがって既定の添付置き場には
    TCC 保護対象外のディレクトリだけを使う。
"""

from __future__ import annotations

import os
from datetime import date
from pathlib import Path
from zoneinfo import ZoneInfo


def _env_path(name: str, default: Path | str) -> Path:
    """環境変数があればそれを、無ければ既定値を Path として返す。"""
    raw = os.environ.get(name)
    return Path(raw).expanduser() if raw else Path(default).expanduser()


def _env_str(name: str, default: str) -> str:
    value = os.environ.get(name)
    return value if value else default


REPO_ROOT = Path(__file__).resolve().parents[2]

# --- 状態（OAuth トークン・排他ロック・添付資産） ---------------------------
# ~/Library/Application Support は TCC 保護対象外で、launchd からも読める。
STATE_DIR = _env_path(
    "OUTREACH_STATE_DIR", "~/Library/Application Support/Ceed/outreach"
)
TOKEN_PATH = _env_path("OUTREACH_TOKEN_PATH", STATE_DIR / "gmail-oauth.json")
LOCK_PATH = _env_path("OUTREACH_LOCK_PATH", STATE_DIR / "send.lock")
ASSET_DIR = _env_path("OUTREACH_ASSET_DIR", STATE_DIR / "assets")

# --- 送信データ（キュー・送信ログ） -----------------------------------------
DATA_ROOT = _env_path(
    "OUTREACH_DATA_ROOT", "~/ceed-workspace/business/sales-leads-20260727"
)
QUEUE_DIR = _env_path("OUTREACH_QUEUE_DIR", DATA_ROOT / "queues")
LOG_DIR = _env_path("OUTREACH_LOG_DIR", DATA_ROOT / "send-logs")

# --- 送信者 -----------------------------------------------------------------
SENDER_EMAIL = _env_str("OUTREACH_SENDER_EMAIL", "yusaku.takahashi@ceed.cloud")
SENDER_NAME = _env_str(
    "OUTREACH_SENDER_NAME", "株式会社Ceed 代表取締役 高橋勇作"
)

TIMEZONE = ZoneInfo(_env_str("OUTREACH_TIMEZONE", "Asia/Tokyo"))

# --- 移行期の既定パス -------------------------------------------------------
# 日付ベースの新レイアウト（QUEUE_DIR / LOG_DIR）へ移行するまでの間、
# 既存 campaign のパスを引数省略時の既定として維持する。
LEGACY_QUEUE_PATH = _env_path(
    "OUTREACH_LEGACY_QUEUE_PATH",
    "~/ceed-workspace/business/sales-leads-20260722/"
    "multisector-email-queue-subject-review-20260722.csv",
)
LEGACY_SEND_LOG_PATH = _env_path(
    "OUTREACH_LEGACY_SEND_LOG_PATH",
    "~/ceed-workspace/business/sales-leads-20260722/"
    "multisector-email-send-log-20260722.csv",
)


def queue_path_for(run_date: str) -> Path:
    """日付ベースの新レイアウトでの送信キューの位置。"""
    return QUEUE_DIR / f"outreach-queue-{run_date}.csv"


def send_log_path_for(run_date: str) -> Path:
    """日付ベースの新レイアウトでの送信ログの位置。"""
    return LOG_DIR / f"outreach-send-log-{run_date}.csv"


def resolve_run_date(value: str | None) -> str:
    """`today` と ISO 日付の両方を受け取り ISO 日付を返す。

    launchd の plist に日付を焼き込む運用（2026-07-24 に 0 通で終わった事故の
    原因）を廃止するために使う。
    """
    if value is None or value == "today":
        return date.today().isoformat()
    # 不正な値をここで弾く。呼び出し側の fromisoformat と同じ検証。
    return date.fromisoformat(value).isoformat()


class AssetAccessError(RuntimeError):
    """添付ファイルを読めないときに、原因と対処を添えて投げる。"""


def assert_attachment_readable(path: Path) -> None:
    """添付が実在し、かつ読み取れることを送信前に確認する。

    TCC で拒否された場合、素の PermissionError は原因が分かりにくいため
    対処方法を含むメッセージに変換する。
    """
    path = Path(path)
    if not path.is_file():
        raise AssetAccessError(f"添付ファイルが存在しない: {path}")
    try:
        with path.open("rb") as handle:
            handle.read(1)
    except PermissionError as error:
        raise AssetAccessError(
            f"添付ファイルを読めない（macOS の TCC 保護の可能性）: {path}\n"
            f"対処: 添付を {ASSET_DIR} 配下へ移すか、launchd が起動する "
            "python にフルディスクアクセスを付与する。"
            "~/Downloads · ~/Desktop · ~/Documents は launchd から読めない。"
        ) from error
