#!/usr/bin/env bash
# launchd から各ジョブを起動する共通ラッパ。
#
# plist に秘密情報を書かない（~/Library/LaunchAgents は他ユーザーからも読める）。
# 環境変数は下記の env ファイルから読み込む。
#
#   ~/Library/Application Support/Ceed/outreach/env
#     EMAIL_TRACKING_ADMIN_TOKEN=...
#     OUTREACH_SLACK_WEBHOOK_URL=...
#     OUTREACH_SLACK_CHANNEL=...
#
# 使い方: run_job.sh <job-name> [args...]

set -uo pipefail

JOB="${1:?job name required}"
shift || true

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
export REPO_DIR
PYTHON="${OUTREACH_PYTHON:-/opt/homebrew/bin/python3}"
STATE_DIR="${OUTREACH_STATE_DIR:-$HOME/Library/Application Support/Ceed/outreach}"
ENV_FILE="${OUTREACH_ENV_FILE:-$STATE_DIR/env}"
LOG_DIR="$HOME/Library/Logs/Ceed"
LOG_FILE="$LOG_DIR/outreach-$JOB.log"

mkdir -p "$LOG_DIR"

log() {
    printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >>"$LOG_FILE"
}

if [ -f "$ENV_FILE" ]; then
    # shellcheck disable=SC1090
    set -a && . "$ENV_FILE" && set +a
else
    log "WARN env ファイルが無い: $ENV_FILE (通知と計測が制限される)"
fi

if [ ! -x "$PYTHON" ]; then
    log "ERROR python が見つからない: $PYTHON"
    exit 1
fi

log "=== $JOB 開始 ==="

case "$JOB" in
    leads)
        # 供給は失敗しても送信を止めない。個別に実行して結果だけ記録する。
        "$PYTHON" "$REPO_DIR/scripts/outreach/discover_seeds.py" >>"$LOG_FILE" 2>&1 \
            || log "WARN discover_seeds が失敗した"
        "$PYTHON" "$REPO_DIR/scripts/outreach/collect_contacts.py" "$@" >>"$LOG_FILE" 2>&1 \
            || log "WARN collect_contacts が失敗した"
        "$PYTHON" "$REPO_DIR/scripts/outreach/inventory.py" >>"$LOG_FILE" 2>&1 \
            || log "WARN inventory が失敗した"
        STATUS=0
        ;;
    queue)
        "$PYTHON" "$REPO_DIR/scripts/outreach/build_queue.py" --date today "$@" >>"$LOG_FILE" 2>&1
        STATUS=$?
        ;;
    send)
        # 送信は caffeinate でスリープを抑止する。約 2.5 時間かかるため。
        /usr/bin/caffeinate -dimsu "$PYTHON" \
            "$REPO_DIR/scripts/send_outreach_queue.py" \
            --execute --run-date today "$@" >>"$LOG_FILE" 2>&1
        STATUS=$?
        ;;
    report)
        "$PYTHON" "$REPO_DIR/scripts/outreach/poll_replies.py" >>"$LOG_FILE" 2>&1 \
            || log "WARN poll_replies が失敗した"
        "$PYTHON" "$REPO_DIR/scripts/outreach/report.py" --mode daily "$@" >>"$LOG_FILE" 2>&1
        STATUS=$?
        ;;
    cycle)
        "$PYTHON" "$REPO_DIR/scripts/outreach/report.py" --mode cycle "$@" >>"$LOG_FILE" 2>&1
        STATUS=$?
        ;;
    *)
        log "ERROR 未知のジョブ: $JOB"
        exit 1
        ;;
esac

log "=== $JOB 終了 (exit=$STATUS) ==="

# 送信とキュー生成の失敗は営業が止まるため、スクリプト側の通知に加えて
# ラッパからも必ず 1 通出す（python が起動前に落ちた場合を拾うため）。
if [ "$STATUS" -ne 0 ] && { [ "$JOB" = "send" ] || [ "$JOB" = "queue" ]; }; then
    OUTREACH_FAILED_JOB="$JOB" \
    OUTREACH_FAILED_STATUS="$STATUS" \
    OUTREACH_FAILED_LOG="$LOG_FILE" \
    "$PYTHON" -c '
import os, sys
sys.path.insert(0, os.path.join(os.environ["REPO_DIR"], "scripts"))
from outreach import notify
notify.alert(
    f"営業メール: {os.environ[\"OUTREACH_FAILED_JOB\"]} ジョブが失敗した",
    f"exit={os.environ[\"OUTREACH_FAILED_STATUS\"]}\nログ: {os.environ[\"OUTREACH_FAILED_LOG\"]}",
)
' >>"$LOG_FILE" 2>&1 || log "WARN 失敗通知の送出にも失敗した"
fi

exit "$STATUS"
