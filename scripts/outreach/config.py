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

# --- 送信データ -------------------------------------------------------------
# 日付を含まない安定したルート。日付名ディレクトリ（sales-leads-YYYYMMDD）は
# 有限バッチ運用の名残で、日次運用と噛み合わないため使わない。
DATA_ROOT = _env_path(
    "OUTREACH_DATA_ROOT", "~/ceed-workspace/business/sales-outreach"
)
POOL_DIR = _env_path("OUTREACH_POOL_DIR", DATA_ROOT / "pool")
QUEUE_DIR = _env_path("OUTREACH_QUEUE_DIR", DATA_ROOT / "queues")
LOG_DIR = _env_path("OUTREACH_LOG_DIR", DATA_ROOT / "send-logs")
REPORT_DIR = _env_path("OUTREACH_REPORT_DIR", DATA_ROOT / "reports")
CACHE_DIR = _env_path("OUTREACH_CACHE_DIR", DATA_ROOT / "cache")

LEADS_POOL_PATH = _env_path("OUTREACH_LEADS_POOL_PATH", POOL_DIR / "leads.csv")
SEEDS_PATH = _env_path("OUTREACH_SEEDS_PATH", POOL_DIR / "seeds.csv")
SUPPRESSION_PATH = _env_path(
    "OUTREACH_SUPPRESSION_PATH", POOL_DIR / "suppression.csv"
)

# 過去キャンペーンのディレクトリ。重複送信を防ぐ除外元として読み取り専用で参照する。
# 移動はしない（既存の送信実績がここにしか無いため）。
HISTORY_DIRS = [
    Path(raw).expanduser()
    for raw in _env_str(
        "OUTREACH_HISTORY_DIRS",
        "~/ceed-workspace/business/sales-leads-20260713"
        ":~/ceed-workspace/business/sales-leads-20260722"
        ":~/ceed-workspace/business/sales-leads-20260727",
    ).split(":")
    if raw.strip()
]

# --- 設定ファイル（リポジトリ管理） -----------------------------------------
CONFIG_DIR = _env_path("OUTREACH_CONFIG_DIR", REPO_ROOT / "config")
ALLOCATION_PATH = _env_path(
    "OUTREACH_ALLOCATION_PATH", CONFIG_DIR / "allocation.json"
)
INDUSTRIES_PATH = _env_path(
    "OUTREACH_INDUSTRIES_PATH", CONFIG_DIR / "industries.json"
)

# --- 送信者 -----------------------------------------------------------------
SENDER_EMAIL = _env_str("OUTREACH_SENDER_EMAIL", "yusaku.takahashi@ceed.cloud")
SENDER_NAME = _env_str(
    "OUTREACH_SENDER_NAME", "株式会社Ceed 代表取締役 高橋勇作"
)

TIMEZONE = ZoneInfo(_env_str("OUTREACH_TIMEZONE", "Asia/Tokyo"))

# --- 運用パラメータ ---------------------------------------------------------
DAILY_SEND_TARGET = int(_env_str("OUTREACH_DAILY_SEND_TARGET", "500"))
# 在庫がこの営業日数分を割ったら警告する。週 2,500 通の消費ペース基準。
INVENTORY_MIN_BUSINESS_DAYS = int(
    _env_str("OUTREACH_INVENTORY_MIN_BUSINESS_DAYS", "14")
)
# PDCA のサイクル長（営業日）。この日数ごとに判断材料をまとめて出す。
CYCLE_BUSINESS_DAYS = int(_env_str("OUTREACH_CYCLE_BUSINESS_DAYS", "3"))

# --- 遷移先とトラッキング ---------------------------------------------------
LP_URL = _env_str("OUTREACH_LP_URL", "https://lp.ceed.cloud/")
COMPANY_URL = _env_str("OUTREACH_COMPANY_URL", "https://ceed.cloud/")
TRACKING_BASE_URL = _env_str(
    "OUTREACH_TRACKING_BASE_URL",
    "https://sales-ops-bot-863195311806.asia-northeast1.run.app",
)
TRACKING_REGISTER_URL = f"{TRACKING_BASE_URL}/internal/email-tracking/recipients"


def tracking_summary_url(campaign_id: str) -> str:
    return (
        f"{TRACKING_BASE_URL}/internal/email-tracking/campaigns/"
        f"{campaign_id}/summary"
    )


def tracking_admin_token() -> str:
    """計測 API の管理トークン。値はログにも例外にも出さない。"""
    token = os.environ.get("EMAIL_TRACKING_ADMIN_TOKEN", "").strip()
    if not token:
        raise RuntimeError(
            "EMAIL_TRACKING_ADMIN_TOKEN が設定されていない"
        )
    return token


# --- Slack 通知 -------------------------------------------------------------
# 未設定でも送信は止めない。notify 側でログ出力にフォールバックする。
SLACK_CHANNEL = _env_str("OUTREACH_SLACK_CHANNEL", "")
SLACK_WEBHOOK_URL = _env_str("OUTREACH_SLACK_WEBHOOK_URL", "")


def is_business_day(value: date) -> bool:
    """営業日（月〜金）か。土日に送ると開封されずリードを損なうため送らない。

    祝日は判定しない。祝日対応が必要になった時点で別途判断する。
    """
    return value.weekday() < 5

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
