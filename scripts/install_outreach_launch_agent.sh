#!/usr/bin/env bash
set -euo pipefail

LABEL="cloud.ceed.outreach-20260724"
PLIST="${HOME}/Library/LaunchAgents/${LABEL}.plist"
LOG_DIR="${HOME}/Library/Logs/Ceed"
UID_VALUE="$(id -u)"

mkdir -p "$(dirname "${PLIST}")" "${LOG_DIR}"

cat >"${PLIST}" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>cloud.ceed.outreach-20260724</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/caffeinate</string>
    <string>-dimsu</string>
    <string>/opt/homebrew/bin/python3</string>
    <string>/Users/zacky/Programming/sales-ops-hub/scripts/send_outreach_queue.py</string>
    <string>--execute</string>
    <string>--run-date</string>
    <string>2026-07-24</string>
    <string>--start-hour</string>
    <string>9</string>
    <string>--start-minute</string>
    <string>0</string>
    <string>--start-window-minutes</string>
    <string>30</string>
    <string>--max-messages</string>
    <string>490</string>
    <string>--delay-seconds</string>
    <string>60</string>
    <string>--batch-size</string>
    <string>50</string>
    <string>--batch-pause-seconds</string>
    <string>900</string>
  </array>
  <key>WorkingDirectory</key>
  <string>/Users/zacky/Programming/sales-ops-hub</string>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Month</key>
    <integer>7</integer>
    <key>Day</key>
    <integer>24</integer>
    <key>Hour</key>
    <integer>9</integer>
    <key>Minute</key>
    <integer>0</integer>
  </dict>
  <key>StandardOutPath</key>
  <string>/Users/zacky/Library/Logs/Ceed/outreach-20260724.log</string>
  <key>StandardErrorPath</key>
  <string>/Users/zacky/Library/Logs/Ceed/outreach-20260724.log</string>
  <key>ProcessType</key>
  <string>Background</string>
</dict>
</plist>
PLIST

chmod 600 "${PLIST}"
plutil -lint "${PLIST}"
launchctl bootout "gui/${UID_VALUE}/${LABEL}" >/dev/null 2>&1 || true
launchctl bootstrap "gui/${UID_VALUE}" "${PLIST}"
launchctl enable "gui/${UID_VALUE}/${LABEL}"
launchctl print "gui/${UID_VALUE}/${LABEL}" >/dev/null

printf 'Installed %s for 2026-07-24 09:00 JST\n' "${LABEL}"
