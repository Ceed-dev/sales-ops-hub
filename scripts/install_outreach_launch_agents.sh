#!/usr/bin/env bash
# 営業メール自動化の launchd ジョブをインストールする。
#
# 旧インストーラ (install_outreach_launch_agent.sh) は plist に日付を
# 焼き込む単発設定で、毎回作り直す必要があった。その運用が原因で
# 2026-07-24 は起動時刻が送信ウィンドウを外れ 0 通で終わっている。
# ここでは日付を持たない恒常ジョブを作る。
#
# 送信ジョブだけは既定でインストールしない。実メールが外部に出るため、
# キュー生成のドライランを確認してから --enable-send で有効化する。
#
# 使い方:
#   ./scripts/install_outreach_launch_agents.sh              # 送信以外を導入
#   ./scripts/install_outreach_launch_agents.sh --enable-send # 送信も導入
#   ./scripts/install_outreach_launch_agents.sh --uninstall   # 全て削除

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNNER="$REPO_DIR/scripts/outreach/run_job.sh"
AGENT_DIR="$HOME/Library/LaunchAgents"
LOG_DIR="$HOME/Library/Logs/Ceed"
PREFIX="cloud.ceed.outreach"

ENABLE_SEND=0
UNINSTALL=0
for arg in "$@"; do
    case "$arg" in
        --enable-send) ENABLE_SEND=1 ;;
        --uninstall) UNINSTALL=1 ;;
        *) echo "未知の引数: $arg" >&2; exit 1 ;;
    esac
done

mkdir -p "$AGENT_DIR" "$LOG_DIR"

# ジョブ定義: 名前 時 分
JOBS=(
    "leads 2 0"
    "queue 7 0"
    "report 8 30"
    "cycle 8 45"
    "send 9 0"
)

unload_job() {
    local label="$1"
    launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
}

if [ "$UNINSTALL" -eq 1 ]; then
    for entry in "${JOBS[@]}"; do
        set -- $entry
        label="$PREFIX-$1"
        unload_job "$label"
        rm -f "$AGENT_DIR/$label.plist"
        echo "削除: $label"
    done
    exit 0
fi

if [ ! -x "$RUNNER" ]; then
    chmod +x "$RUNNER"
fi

write_plist() {
    local name="$1" hour="$2" minute="$3"
    local label="$PREFIX-$name"
    local plist="$AGENT_DIR/$label.plist"

    # 月〜金だけ起動する。土日に届く B2B メールは開封されずリードを損なう。
    # StartCalendarInterval の配列で Weekday 1..5 を個別に指定する。
    {
        cat <<PLIST_HEAD
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$label</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>$RUNNER</string>
    <string>$name</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$REPO_DIR</string>
  <key>StartCalendarInterval</key>
  <array>
PLIST_HEAD
        for weekday in 1 2 3 4 5; do
            cat <<PLIST_ENTRY
    <dict>
      <key>Weekday</key><integer>$weekday</integer>
      <key>Hour</key><integer>$hour</integer>
      <key>Minute</key><integer>$minute</integer>
    </dict>
PLIST_ENTRY
        done
        cat <<PLIST_TAIL
  </array>
  <key>StandardOutPath</key>
  <string>$LOG_DIR/outreach-$name.out.log</string>
  <key>StandardErrorPath</key>
  <string>$LOG_DIR/outreach-$name.err.log</string>
  <key>ProcessType</key>
  <string>Background</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>HOME</key>
    <string>$HOME</string>
  </dict>
</dict>
</plist>
PLIST_TAIL
    } >"$plist"

    unload_job "$label"
    launchctl bootstrap "gui/$(id -u)" "$plist"
    echo "導入: $label (平日 $(printf '%02d:%02d' "$hour" "$minute"))"
}

for entry in "${JOBS[@]}"; do
    set -- $entry
    name="$1" hour="$2" minute="$3"
    if [ "$name" = "send" ] && [ "$ENABLE_SEND" -eq 0 ]; then
        unload_job "$PREFIX-send"
        rm -f "$AGENT_DIR/$PREFIX-send.plist"
        echo "スキップ: $PREFIX-send (--enable-send で有効化する)"
        continue
    fi
    write_plist "$name" "$hour" "$minute"
done

echo
echo "確認: launchctl print gui/$(id -u)/$PREFIX-queue"
echo "秘密情報: $HOME/Library/Application Support/Ceed/outreach/env に置く"
