# 営業メール自動化 運用手順

日次オートパイロットの構成と、動かすために必要な設定。
設計の背景は `docs/plans/2026-08-01-daily-outreach-autopilot.md` を参照。

## 全体の流れ

```
discover_seeds  →  collect_contacts  →  pool/leads.csv
     (平日 02:00)                            │
                                            ▼
                              build_queue (平日 07:00)
                                            │
                              queues/outreach-queue-YYYY-MM-DD.csv
                                            ▼
                       send_outreach_queue (平日 09:00)
                                            │
                              send-logs/outreach-send-log-*.csv
                                            ▼
                    poll_replies → report (平日 08:30 / 08:45)
```

送信は**営業日のみ**。土日に届く B2B メールは開封されずリードを損なうため。

## launchd ジョブ

| ラベル | 時刻 | 内容 |
|---|---|---|
| `cloud.ceed.outreach-leads` | 平日 02:00 | シード発掘 → 連絡先収集 → 在庫チェック |
| `cloud.ceed.outreach-queue` | 平日 07:00 | 当日 500 件のキュー生成 |
| `cloud.ceed.outreach-report` | 平日 08:30 | 返信検知 → 日次レポート |
| `cloud.ceed.outreach-cycle` | 平日 08:45 | 3 日サイクルのレポート |
| `cloud.ceed.outreach-send` | 平日 09:00 | 実送信（**既定では未導入**） |

```bash
./scripts/install_outreach_launch_agents.sh               # 送信以外を導入
./scripts/install_outreach_launch_agents.sh --enable-send # 送信も有効化
./scripts/install_outreach_launch_agents.sh --uninstall   # 全削除
launchctl print "gui/$(id -u)/cloud.ceed.outreach-queue"  # 状態確認
```

## 必要な設定

### 1. 環境変数ファイル

`~/Library/Application Support/Ceed/outreach/env` に置く。
plist には書かない（`~/Library/LaunchAgents` は他ユーザーからも読めるため）。

```sh
EMAIL_TRACKING_ADMIN_TOKEN=...     # 計測 API の管理トークン
OUTREACH_SLACK_WEBHOOK_URL=...     # 通知先（未設定ならログへ退避して継続）
OUTREACH_SLACK_CHANNEL=...         # 任意
```

### 2. 添付 PDF

`~/Library/Application Support/Ceed/outreach/assets/` に**1 つだけ**置く。
複数あるとどれを送るか決められないため、キュー生成時に停止する。

`~/Downloads` `~/Desktop` `~/Documents` は macOS の TCC 保護対象で
launchd から読めない。ここに置くと送信が止まる（2026-07-31 の停止原因）。

### 3. フルディスクアクセス

`/opt/homebrew/bin/python3` に対して
システム設定 → プライバシーとセキュリティ → フルディスクアクセス を許可する。
TCC の恒久対策。

## 手動操作

```bash
# 在庫確認
python3 scripts/outreach/inventory.py

# キュー生成のドライラン（送信しない・通知も出さない）
python3 scripts/outreach/build_queue.py --date today --dry-run

# 送信のドライラン（--execute が無ければ 1 通も送らない）
python3 scripts/send_outreach_queue.py \
  --queue-path <queue.csv> --send-log-path <log.csv> --run-date today

# レポートを Slack へ出さずに確認
python3 scripts/outreach/report.py --mode cycle --no-slack
```

## 配信停止の扱い

`pool/suppression.csv` に載ったアドレス・ドメインには二度と送らない。
キュー生成時に検証で弾き、混入していればキューを書かずに停止する。

返信検知が有効になるまでは**手で追記する**。列は
`email,domain,reason,added_at,notes`。

## 配分の変更

`config/allocation.json` の `weight` を編集する。3 日サイクルのレポートを見た
上での判断でのみ変更する。自動では書き換えない。

文面を変えたら `copy_generation` も上げる。上げないと、サイクルレポートが
どの世代の文面の成績かを区別できなくなる。

## 止め方

```bash
launchctl bootout "gui/$(id -u)/cloud.ceed.outreach-send"   # 送信だけ止める
./scripts/install_outreach_launch_agents.sh --uninstall     # 全部止める
```

送信中に止めたい場合はプロセスを落とす。送信ログは 1 通ごとに書かれ、
再実行時は送信済みを照合してスキップするため、途中で止めても二重送信しない。

## ログ

`~/Library/Logs/Ceed/outreach-<job>.log`
Slack が未設定のときの通知退避先は `reports/notifications.log`。
