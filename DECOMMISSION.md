# 廃止記録 (2026-09-11)

Sales Ops Hub は **2026-09-11 に終了**した。駿冴の判断 (「過去のものなので完全に削除してよい」) による。

**GCP 上のリソースとデータは全て削除する方針。本リポジトリのコードと本ファイルが唯一の記録である。**

2026-09-10 開始の GCP 全体棚卸し (アカウント `pochi@0xqube.xyz`) の一環。同じ棚卸しの他の記録は [`Ceed-dev/data-collection`](https://github.com/Ceed-dev/data-collection/blob/main/docs/decommission-log.md) / [`Ceed-dev/InvoiceFlow`](https://github.com/Ceed-dev/InvoiceFlow/blob/main/DECOMMISSION.md) / [`Ceed-dev/ceed-ads`](https://github.com/Ceed-dev/ceed-ads/blob/main/DECOMMISSION.md) にある。

## 1. 何をしていたか

営業活動を支える常時稼働のサーバーレス基盤。GCP プロジェクト `sales-ops-hub` (project number `863195311806`)。

Cloud Run サービス **`sales-ops-bot`** (`asia-northeast1`) が単体で以下を担っていた。

| 機能 | エンドポイント | 起動方法 |
|---|---|---|
| スプレッドシート同期 | `POST /api/sheets/sync` | Cloud Scheduler `sheets-sync-daily` (毎日 12:00 JST) |
| AI 週次レポート生成 | `POST /tasks/weekly-report` | Cloud Scheduler `weekly-report-ai` (毎週金 11:00 JST) |
| Telegram ボット受信 | `POST /webhook/telegram` | Telegram の Webhook |
| 営業メールの開封トラッキング | `GET /t/o/{署名付きID}.gif` | 送信済みメール内の 1px 画像 |

`src/lib` の構成は `cloudTasks` / `firebase` / `isInternal` / `sheets` / `telegram` / `weeklyReport`。AI 部分は Vertex AI を使用。

### 外部サービス連携

| 連携先 | 識別子 |
|---|---|
| Telegram ボット | **Qube AI Assistant** (`@sales_ops_assistant_bot`、bot ID `7867738775`) |
| Slack Incoming Webhook | ワークスペース `T023YFP93ML` に 2 本 (`B09GTTVHXHC` / `B09NH79FFA7`) |
| Google Sheets | `CHATS_SPREADSHEET_ID` (Secret Manager 管理) |
| Vertex AI | `VERTEX_API_KEY` (Secret Manager 管理) |

### GCP リソース

| 要素 | 内容 |
|---|---|
| Cloud Run | `sales-ops-bot` 1 サービス。最終デプロイ **2026-07-23 (`zach@0xqube.xyz`)**、リビジョンは `00037` まで |
| Cloud Scheduler | `sheets-sync-daily` / `weekly-report-ai` の 2 件 (どちらも ENABLED) |
| Cloud Tasks | キュー `notification-queue` (RUNNING) |
| Firestore | Native、コレクション 9 種 |
| Secret Manager | シークレット 14 本 |
| Artifact Registry | `cloud-run-source-deploy` 約 2.1 GB |
| GCS | `run-sources-sales-ops-hub-asia-northeast1` (デプロイ用ソース置き場) |
| VM / Cloud SQL | **無し** |

### Secret Manager のシークレット一覧 (値は記録しない)

`CHATS_SPREADSHEET_ID` / `EMAIL_TRACKING_ADMIN_TOKEN` / `EMAIL_TRACKING_SIGNING_SECRET` / `FIREBASE_PROJECT_ID` / `GCP_LOCATION_ID` / `GCP_PROJECT_ID` / `GCP_TASKS_QUEUE` / `MESSAGE_TTL_DAYS` / `PUBLIC_BASE_URL` / `SLACK_WEBHOOK_URL` / `SLACK_WEBHOOK_URL_SECOND` / `TELEGRAM_BOT_TOKEN` / `TELEGRAM_WEBHOOK_SECRET` / `VERTEX_API_KEY`

### Firestore のデータ構造 (削除時点)

| コレクション | 件数 | 役割 |
|---|---|---|
| `emailTrackingEvents` | 300+ | メール開封イベント |
| `emailTrackingRecipients` | 300+ | 送信先 |
| `emailTrackingRegistrations` | 300+ | 送信登録 |
| `emailTrackingCampaignSummaryShards` | 189 | キャンペーン集計 (シャード) |
| `notificationDeliveries` | 170 | 通知送信履歴 |
| `tg_users` | 157 | Telegram ユーザー |
| `tg_chats` | 117 | Telegram チャット |
| `reports_settings` | 117 | レポート設定 |
| `people` | 9 | 連絡先 |

件数の `300+` は REST API の 1 ページ上限による打ち切り。実数はこれ以上。

## 2. 終了時点の稼働状況 (実測)

**停止直前まで動いていた。** 「完全に止まっていたから消す」のではなく、**駿冴の判断で稼働中のものを止めた**という点に注意。

| 観点 | 実測値 (2026-09-11 時点) |
|---|---|
| シート同期 | 2026-09-11 03:00 UTC に HTTP 200 |
| 週次レポート | 2026-09-11 02:00 UTC に HTTP 200 |
| Telegram 受信 | 2026-09-10 16:35 UTC に HTTP 200 |
| メール開封トラッキング | 2026-09-10 01:29 UTC に `/t/o/*.gif` へアクセス (送信済みメールが開かれた記録) |

## 3. 実施した作業

| 日時 (JST) | 操作 | 結果 |
|---|---|---|
| 2026-09-11 | Telegram Webhook 削除 (`deleteWebhook?drop_pending_updates=true`) | `Webhook was deleted`。`getWebhookInfo` で URL 未設定を確認 |

(以降の作業は実施後に追記)

## 4. 別途手作業が必要なもの

GCP の外にあるため、プロジェクト削除では消えない。

| 対象 | 必要な作業 |
|---|---|
| Telegram ボット `@sales_ops_assistant_bot` | BotFather (`@BotFather`) で `/deletebot` を実行。**Bot API では削除できない** |
| Slack Incoming Webhook 2 本 | Slack のアプリ設定画面から取り消す。**API では revoke できない**。ワークスペース `T023YFP93ML` の該当アプリを開き、Incoming Webhooks を削除 |

Webhook URL 自体はプロジェクト削除後も有効なままで、URL を知る者は Slack に投稿できる。**URL は Secret Manager 内にのみ存在しており、プロジェクト削除で失われるため実リスクは低い**が、念のため取り消しを推奨。

## 5. 再開する場合

1. 新規 GCP プロジェクトを作成し、Firestore (Native) / Cloud Tasks / Cloud Scheduler / Secret Manager / Vertex AI を有効化
2. 本リポジトリを `gcloud run deploy` で Cloud Run にデプロイ (`.env.example` に必要な環境変数あり)
3. 上記 14 本のシークレットを Secret Manager に再登録。**Telegram / Slack / Vertex の資格情報は再発行が必要**
4. Cloud Tasks キュー `notification-queue` を作成
5. Cloud Scheduler を 2 件登録 (毎日 12:00 JST / 毎週金 11:00 JST)
6. Telegram の Webhook を `setWebhook` で再設定
7. **メール開封トラッキングは復旧できない。** 署名鍵 (`EMAIL_TRACKING_SIGNING_SECRET`) が失われるため、送信済みメール内の既存の追跡 URL は永久に無効になる
