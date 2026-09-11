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

### 2.1 HTTP レベルでは動いて見えた

| 観点 | 実測値 (2026-09-11 時点) |
|---|---|
| シート同期 | 2026-09-11 03:00 UTC に HTTP 200 |
| 週次レポート | 2026-09-11 02:00 UTC に HTTP 200 |
| Telegram 受信 | 2026-09-10 16:35 UTC に HTTP 200 |
| メール開封トラッキング | 2026-09-10 01:29 UTC に `/t/o/*.gif` へアクセス |

### 2.2 しかしデータは 2026-07-31 で止まっていた (決め手)

Firestore の全ドキュメントの `createTime` を集計した結果、**新しいデータは一切生まれていない**ことが判明した。

| コレクション | 件数 | 最新 `createTime` | 直近 7 日 | 直近 30 日 |
|---|---|---|---|---|
| `emailTrackingRecipients` | 3,967 | **2026-07-31** | 0 | 0 |
| `emailTrackingRegistrations` | 3,967 | **2026-07-31** | 0 | 0 |
| `emailTrackingCampaignSummaryShards` | 189 | 2026-07-31 | 0 | 0 |
| `emailTrackingEvents` | 636 | 2026-09-10 | 2 | 21 |
| `tg_users` | 157 | 2026-08-26 | 0 | 2 |
| `tg_chats` | 117 | 2026-05-22 | 0 | 0 |
| `reports_settings` | 117 | 2026-05-22 | 0 | 0 |
| `notificationDeliveries` | 170 | 2026-06-01 | 0 | 0 |
| `people` | 9 | 2025-09-30 | 0 | 0 |

**解釈**:

- 営業メールの配信は **2026-07-31 が最後**。以降、新しい送信先も登録も 0 件
- `emailTrackingEvents` だけが増えていたのは、**過去に送ったメールが今ごろ開かれていた**ため (直近 7 日でわずか 2 件)
- Telegram も直近 7 日はゼロ、チャットは 5 月が最後
- Cloud Scheduler の日次・週次ジョブは HTTP 200 を返していたが、**処理対象が無いまま空回りしていた**

**教訓**: 「HTTP 200 が返っている = 使われている」ではない。**データが増えているかどうかで判断すること。** ai-influencer-vm では逆に「アプリ A が死んでいる = VM が死んでいる」と誤判断しており、どちらも一段深い実測が必要だった事例。

なお最終デプロイは **2026-07-23 `zach@0xqube.xyz`** で、メール配信停止の直前にあたる。削除は駿冴の判断で実施。

## 3. 実施した作業

| 日時 (JST) | 操作 | 結果 |
|---|---|---|
| 2026-09-11 | Telegram Webhook 削除 (`deleteWebhook?drop_pending_updates=true`) | `Webhook was deleted`。`getWebhookInfo` で URL 未設定を確認 |
| 2026-09-11 | 残骸の網羅確認 | Scheduler は `asia-northeast1` の 2 件のみ (他ロケーション 0)。Hosting `sales-ops-hub.web.app` は **HTTP 404** (未デプロイ)、カスタムドメイン無し。API キー 2 本、サービスアカウント 5 個。**全て本プロジェクト内に閉じている**ことを確認 |
| 2026-09-11 | **GCP プロジェクト `sales-ops-hub` を削除** | `DELETE_REQUESTED`。Cloud Run / Firestore / Scheduler / Cloud Tasks / Secret Manager / Artifact Registry / GCS / サービスアカウントを含む全リソースが対象。`sales-ops-bot` の URL が **HTTP 404** になったことを確認 |

**Firestore のデータ (合計約 9,400 件) は控えを取らずに消去した。** 「コードと作業ログは GitHub のみに残す」という駿冴の方針による。復元はできない。

### 関連するが別扱いのもの

GCP プロジェクト一覧に `Lead Conversion Timestamp` という名前の Apps Script 系プロジェクトが 2 つ存在する (`sys-87746295492886303289329225` / `sys-63171755286613312959744128`)。名称から営業/リード関連が疑われるが、**本プロジェクトからの参照は無く、課金も無効**。別途棚卸しの対象とする。

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
