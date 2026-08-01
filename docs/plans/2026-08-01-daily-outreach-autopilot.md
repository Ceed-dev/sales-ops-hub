# Plan: 営業メール日次オートパイロット（送信・供給・計測・PDCA） (2026-08-01)

## 0. 目的（Purpose）

営業メール 500 通/日の運用から、Zack の手作業（キュー生成・plist 書き換え・結果の目視集計）を外し、
**朝 9 時に自動で送られ、翌朝に判断材料が Slack に揃っている状態**にする。

観測可能な達成状態:

- Zack が何もしなくても、毎営業日 09:00 に 500 通が送信される（キュー生成も自動）
- 送信キューの在庫が常に 14 営業日分以上あり、下回ったら Slack で警告が出る
- 毎朝、前日の「送信数 / バウンス / ユニーク開封 / ユニーククリック / 返信数と内訳」が
  セル別（件名 A/B × LP/PDF）・業界別で Slack に投稿される
- 「希望」返信が来たら、Zack が受信箱を掘らなくても Slack に通知が飛ぶ
- レポートに「次回配分の提案」が載り、Zack が承認したら翌日のキューに反映される

達成されないと起きること: 現状 Day5（446 件）を送り切った時点で在庫ゼロになり、
毎日 500 通の運用が止まる。かつ返信率が計測されていないため、A/B の勝ち負けが永久に確定しない。

## 0.1. あるべき姿（Should-be State）

依頼者（Zack）の設計図:

- `/Users/zacky/ceed-workspace/docs/60-workflow/automation-backlog-20260801.md` の
  「3. 営業メール日次500通の自動送信＋PDCA」
  > 朝 9 時になったら自動で送られるようにする / 結果を見て PDCA を回すプロセスを組む
- 同ドキュメント「ギャップ」表の 4 行（毎日9時 / キュー準備 / 結果を見る / PDCA を回す）を全て埋める

2026-08-01 の口頭確認で確定した 4 点:

1. **リード供給も自動化スコープに入れる**（在庫が 2 日で尽きるため）
2. **PDCA は 3 日サイクル**。送信は毎日完全自動で、承認ゲートを一切置かない。
   3 日ごとにサイクルレポートを出し、Zack がフィードバックを返す。
   **フィードバックが無くても送信は止めない**（現行 config のまま次サイクルへ継続）
3. **「希望」返信の検知を今回のスコープに入れる**（PDCA の主要指標であり、#1 ミーティング準備のデータ源になるため）
4. 実行環境は自宅の MacBook Air を常時稼働させ、そこから定期起動する

## 0.3. 障害診断（2026-08-01 実機確認）

着手前に「送信のたびに Gmail 認証が入る」という申告を検証した。**認証は障害ではなかった。**

| 検証 | 結果 |
|---|---|
| リフレッシュトークンの有効性 | **有効**（`expires_in=3598`、スコープ 3 種を正常に返す）。2026-07-23 発行のものが 08-01 時点で生存 |
| 送信経路の認証方式 | `load_credentials()` は `refresh_token` のみを使う。**対話的認証は構造上発生しない** |
| 実行ログの認証エラー | Day1/2/3 の err ログに `invalid_grant` 等は **0 件**。送信ログは 3 日とも 500/500 で `sent` |

**実際の障害は以下 3 点だった:**

1. **macOS TCC による添付ファイルの読み取り拒否**（最重要）
   ```
   PermissionError: [Errno 1] Operation not permitted:
   '/Users/zacky/Downloads/株式会社Ceed ご説明資料.pdf'
   ```
   launchd 起動プロセスが `~/Downloads` にアクセスできず、PDF 版の送信中に停止。
   Day3 は order 352 で落ちて手動再実行しており、分割実行になっていた。
   利用者が体感していた「毎回入る認証」はこの **macOS のプライバシー許可ダイアログ**と推定される。
2. **起動ウィンドウ外での起動**: `outreach-20260724.log` に
   `ERROR outside the authorized start window`。10:59 起動で 09:00±30 分を外し、**その日は 0 通**。
3. **日付固定 plist**: `StartCalendarInterval` が `Month 7 / Day 24` の単発設定のため、
   毎回 plist を作り直す必要があり、上記 2 の起動時刻ズレを誘発していた。

3 点とも Phase 0 と Phase 2 で解消する。`gmail.readonly` の追加（返信検知用）だけは
ブラウザでの再認可が 1 回必要なため、**Phase 3 は認可が取れるまで着手しない**。

## 0.2. 実装基盤（Implementation Basis）

**送信エンジンは既存を温存する。作り直さない。**

- 送信本体: `/Users/zacky/Programming/sales-ops-hub/scripts/send_outreach_queue.py`
  - 既にある安全機構をそのまま使う: `fcntl` 排他ロック / 送信ログ照合による冪等性 /
    `--execute` なしはドライラン / 起動ウィンドウ外は `FatalSendError` / 1 通ごとの atomic write /
    Gmail HTTP エラーの致命/非致命判定 / 添付・計測 URL・送信元の行単位検証
- 既存テスト: `/Users/zacky/Programming/sales-ops-hub/scripts/test_send_outreach_queue.py`
- 計測基盤: `/Users/zacky/Programming/sales-ops-hub/src/lib/emailTracking.ts`（Cloud Run `sales-ops-bot`, asia-northeast1）
  - 集計 API `GET /internal/email-tracking/campaigns/:campaignId/summary` は**実装済み・未使用**。これを叩く
  - 設計根拠: `docs/plans/2026-07-22-email-engagement-tracking.md`
    （開封は補助指標、クリック・返信・商談が主要指標）
- キュー生成の原型: `/Users/zacky/ceed-workspace/business/sales-leads-20260727/prepare-outreach-remaining-20260731.py`
  - 流用する関数: `sent_addresses` / `address_issue` / `classify_rows`（DNS/MX）/
    `tracking_for`（計測 URL 登録）/ `build_queue` / `validate_queues`
- リード発掘の原型: `/Users/zacky/ceed-workspace/scratch/build_association_seeds_20260727.py`
  （業界団体ディレクトリ → 公式サイト URL）
- メール抽出の原型: `/Users/zacky/ceed-workspace/scratch/collect_outreach_contacts_20260727.py`
  （公式サイト上に掲載されているアドレスのみ採用する検証付き）
- 既存 launchd インストーラ: `/Users/zacky/Programming/sales-ops-hub/scripts/install_outreach_launch_agent.sh`

## 1. 既存コードの要約

### 送信（完成度: 高）

`send_outreach_queue.py` は 468 行。`--queue-path` / `--send-log-path` が
2026-07-27 の Plan で外部化済みのため、日付ごとのキューを渡せる状態にはなっている。
ただし `--run-date` が ISO 日付の必須引数（`date.fromisoformat`）で、
`within_start_window()` がその日付の 09:00±30 分でしか送信を許さない。
**このため plist に日付を焼き込む運用になっており、恒常スケジュール化を阻んでいる唯一の箇所**。

### キュー生成（完成度: 中・使い捨て）

`prepare-outreach-remaining-20260731.py` は 17,812 バイトの単体スクリプト。
ロジックは完成しているが `BASE_DIR` / PDF パス / 日付 / 出力ファイル名が全てハードコードで、
日ごとにコピーして書き換える運用になっている。

### 計測（完成度: 高・未接続）

Firestore に `emailTrackingRecipients` / `emailTrackingEvents` /
`emailTrackingCampaignSummaryShards` があり、スキャナ除外・日次重複抑止・20 shard 集計まで実装済み。
**summary API を叩く消費者が存在しないだけ**。

### リード供給（完成度: 中・散在）

`~/ceed-workspace/scratch/` に発掘系スクリプトが 6 本散在。requests + BeautifulSoup + ThreadPoolExecutor。
在庫の実態:

| 資産 | 件数 | 内容 |
|---|---|---|
| `combined-official-site-seeds-20260727.csv` | 5,682 | 公式サイト URL（industry, url） |
| `association-official-site-seeds-20260727.csv` | 1,090 | 業界団体ディレクトリ由来 |
| `web-search-email-page-seeds-20260727.csv` | 2,087 | メール掲載ページ候補 |
| `source-sales-sheet-eligible-20260727.csv` | 11,772 | 既存営業シート（**うち HP URL 保有は 892 件のみ**） |
| メール抽出済み（`outreach-leads-2500`） | 2,500 | うち送信済 1,000 / キュー化済 1,446 |

対象業界は 5 つ（ブライダル / 不動産 / 建築・住宅 / 美容医療 / 観光・宿泊）。
**ボトルネックは URL ではなくメール抽出の歩留まり**。500 通/日を維持するには
1 日あたり新規 500 アドレスの抽出が必要で、シード 5,682 件は数日分しかない。
業界の追加が volume を伸ばす主レバーになる。

## 2. 影響ファイル一覧

すべて `/Users/zacky/Programming/sales-ops-hub/` 配下に集約する
（現状 `~/ceed-workspace/scratch/` と `business/sales-leads-*/` に散っているものを引き取る）。

| ファイルパス | 変更内容 |
|---|---|
| `scripts/outreach/config.py` | **新規**。全パス・閾値を環境変数から解決（`OUTREACH_DATA_ROOT` / `OUTREACH_PDF_PATH` / `OUTREACH_TOKEN_PATH` / `SLACK_WEBHOOK_URL` 等）。絶対パスのハードコードを廃止 |
| `scripts/send_outreach_queue.py` | `--run-date` に `today` を許可。既定パスの定数を `config.py` 経由に置換。既存の安全機構は変更しない |
| `scripts/outreach/discover_seeds.py` | **新規**。`build_association_seeds` を恒常化。業界リストを config 駆動、robots/レート制限、既知 URL の除外 |
| `scripts/outreach/collect_contacts.py` | **新規**。`collect_outreach_contacts` を恒常化。掲載元 URL 付きで検証、抽出済みドメインの重複排除 |
| `scripts/outreach/build_queue.py` | **新規**。`prepare-outreach-remaining` を恒常化。`--date` で当日キューを生成。DNS/MX 判定・A/B×LP/PDF 割当・計測登録・重複検証を継承 |
| `scripts/outreach/inventory.py` | **新規**。在庫水位を算出（未送信の send_ready 件数 ÷ 日次送信数 = 残日数）。閾値割れで Slack 警告 |
| `scripts/outreach/poll_replies.py` | **新規**。Gmail API で返信を検知・分類し、送信ログへ反映 + Slack 通知 |
| `scripts/outreach/daily_report.py` | **新規**。summary API + 送信ログ + 返信ログを突合し、セル別・業界別集計と配分提案を Slack 投稿 |
| `scripts/authorize-gmail-send.mjs` | `gmail.readonly` スコープを追加（返信検知に必要）。**再認証が発生する** |
| `scripts/install_outreach_launch_agent.sh` | 日付固定の単発 plist を廃止し、恒常 4 ジョブのインストーラに置換 |
| `scripts/outreach/test_*.py` | **新規**。純粋関数（分類・割当・集計・在庫算出）の単体テスト |

## 3. 実装ステップ

### Phase 0: 基盤（パス外部化 + Air 移設耐性）

1. `scripts/outreach/config.py` を作り、環境変数 + `.env` から全パスを解決する
2. `send_outreach_queue.py` の `QUEUE_PATH` / `SEND_LOG_PATH` / `TOKEN_PATH` / `LOCK_PATH` を config 経由に置換
3. `--run-date today` を許可（`date.today().isoformat()` に解決）。既存の ISO 指定も維持
4. PDF（`株式会社Ceed ご説明資料.pdf`）を `~/Downloads` からリポ管理下 or `OUTREACH_ASSET_DIR` へ移設
5. 既存テストが通ることを確認（`npm test` は TS 側、Python は `test_send_outreach_queue.py`）

### Phase 1: 供給（リード在庫の自動補充）

6. `discover_seeds.py`: 業界 config（現行 5 業界 + 拡張可能）→ ディレクトリ巡回 → 新規公式サイト URL を追記。既知 URL は除外
7. `collect_contacts.py`: 未処理シード URL を巡回し、**サイト上に掲載されているアドレスのみ**採用。掲載元 URL を必ず記録
8. `inventory.py`: 送信可能在庫の残日数を算出。14 日分を下回ったら Slack 警告（業界追加の提案を添える）
9. 上記 2 本を日次バッチ化（深夜帯に実行し、朝までに在庫を積む）

### Phase 2: 送信（毎日 9 時）

10. `build_queue.py`: 当日分 500 件を生成。継承する検証 —
    - 過去送信済み（Gmail message ID 保有行）との重複排除
    - キュー内のアドレス重複ゼロ
    - MX 応答確認済みドメインのみ `send_ready`
    - 件名 A/B × LP/PDF の 4 セル均等割（配分 config が指定されていればそれに従う）
    - 計測 URL（`/t/o/` `/t/c/` 各 1 個）の登録と行単位検証
11. 恒常 launchd を 4 ジョブ構成でインストール:

| ラベル | 時刻 | 処理 |
|---|---|---|
| `cloud.ceed.outreach-leads` | 02:00 | `discover_seeds` → `collect_contacts` → `inventory` |
| `cloud.ceed.outreach-queue` | 07:00 | `build_queue --date today`（ドライラン検証込み） |
| `cloud.ceed.outreach-send` | 09:00 | `send_outreach_queue.py --execute --run-date today` |
| `cloud.ceed.outreach-report` | 08:30 | `poll_replies` → `daily_report`（前日実績・通知のみ） |
| `cloud.ceed.outreach-cycle` | 08:45 | 3 日サイクルの締め日のみ `cycle_report`（判断材料 + 提案） |

12. キューが無い / 検証失敗の場合は**送信せずに Slack へエスカレーション**（無言スキップ禁止）
13. 起動ウィンドウは launchd の起動時刻と必ず一致させる。plist に日付を焼かない
    （2026-07-24 の 0 通事故の再発防止）

### Phase 3: 計測（返信検知 + 日次レポート）

> **🔒 ブロック中**: `gmail.readonly` の追加にブラウザでの再認可が 1 回必要で、
> 2026-08-01 時点で Zack が実施できない。**Phase 0 / 1 / 2 は Phase 3 を待たずに進める**。
> 再認可が取れるまで、レポートは開封・クリック・送信実績のみで構成し、返信率の欄は
> 「未計測（認可待ち）」と明示する。返信の目視確認は当面 Zack の受信箱で行う。

13. `authorize-gmail-send.mjs` に `gmail.readonly` を追加し、Zack が再認証（**保留中**）
14. `poll_replies.py`:
    - 送信ログの `gmail_message_id` から `Message-ID` を引き、`In-Reply-To` / `References` 一致でスレッドを特定
    - 分類: `希望`（商談化）/ `断り` / `不在・後日` / `自動返信` / `バウンス`
    - 送信ログに返信フラグと分類を追記。`希望` は Slack に個別通知（企業名・業界・セル・本文抜粋）
15. `daily_report.py`: 以下を 1 メッセージで Slack に投稿

```
📧 営業メール日次レポート (YYYY-MM-DD)
送信 500 / エラー N / バウンス N
ユニーク開封 N (X%) ※スキャナ除外・参考値
ユニーククリック N (X%)
返信 N (希望 N / 断り N / 不在 N / 自動 N)

セル別  | 送信 | クリック率 | 返信率
A×LP   |  125 |      x.x% |  x.x%
A×PDF  |  125 |      x.x% |  x.x%
B×LP   |  125 |      x.x% |  x.x%
B×PDF  |  125 |      x.x% |  x.x%

業界別  | 送信 | クリック率 | 返信率
（5業界）

📦 在庫: N 件 / 残り N 営業日
💡 次回配分の提案: （下記 Phase 4）
```

### Phase 4: PDCA（3 日サイクル）

**送信は毎日完全自動。承認ゲートはどこにも置かない。**
Zack のフィードバックは 3 日ごとに受け取り、次サイクルの config に反映する。

16. `cycle_report.py`: 3 日分（= 約 1,500 通）を 1 サイクルとして集計し、締め日の朝に Slack へ投稿
    - 主要指標は**クリック率と返信率**（開封は参考値。計測プランの方針に従う）
    - サイクル単位にすることで、日次では足りないサンプル数を確保する
    - 累積サンプルが閾値（セルあたり返信 10 件 or 送信 1,000 件）未満なら
      **「判断保留・均等配分継続」と明記**する。少数サンプルで勝者を固定しない
    - 閾値を満たしたら「B×PDF に 50% 寄せる」等の具体案 + 根拠数値を提示
17. Zack がサイクルレポートにフィードバックを返す
    → `config/allocation.json` および `config/copy.json` を更新
    → 次サイクルの `build_queue` がそれに従う
18. **フィードバックが無い場合も送信は継続する**。現行 config のまま次サイクルへ進み、
    レポートに「前サイクルのフィードバック未反映」と明記するだけに留める（2026-08-01 決定）
19. **自動では配分を変えない**。config を書き換えるのは Zack のフィードバックのみ

## 4. 検証方法

完了条件は「機構が動いたか」と「Section 0 の目的が達成されたか」の両方で判定する。

### 機構動作

- [ ] `pytest` / `python -m unittest` で新規純粋関数のテストが通る
- [ ] `send_outreach_queue.py --run-date today`（`--execute` なし）が `pending=500 / LP=250 / PDF=250` を返す
- [ ] 起動ウィンドウ外で `--execute` すると `FatalSendError` で停止する（既存挙動の非破壊確認）
- [ ] 送信ログに既存行がある状態で再実行しても二重送信されない（冪等性の非破壊確認）
- [ ] `launchctl print gui/$(id -u)/cloud.ceed.outreach-send` で 4 ジョブすべてが load 済み
- [ ] `poll_replies.py` がテスト返信を正しく分類し、送信ログに反映する
- [ ] `daily_report.py` が summary API から実データを取得し Slack に投稿する

### 目的達成

- [ ] **Zack が何も操作しない状態で 3 営業日連続、09:00 に 500 通が送信される**
- [ ] 3 日目の朝、セル別・業界別の返信率を含むレポートが Slack に届いている
- [ ] 在庫水位が 14 営業日分を維持している（または割れた時に警告が出ている）
- [ ] 「希望」返信が発生した際、Zack が受信箱を開く前に Slack で気付ける

## 5. 不明点・確認事項

### Zack 側で用意が必要なもの

1. **Gmail OAuth の再認証**（`gmail.readonly` 追加）。返信検知に必須。**現在ブロック中のため Phase 3 は保留**。
   なお既存の送信用トークンは有効で、送信の自動化に再認証は不要（§0.3 で検証済み）
2. **MacBook Air のフルディスクアクセス付与**: launchd から起動する python に対して
   「システム設定 → プライバシーとセキュリティ → フルディスクアクセス」を許可する。
   §0.3 の TCC エラーの恒久対策（添付をリポ管理下へ移すことで回避もできるが、両方やるのが安全）
3. **Slack 通知先チャンネル**の決定（日次レポート用と 3 日サイクルレポート用を分けるか）
4. **MacBook Air の常時稼働設定**（スリープ抑止・電源設定・再起動後の launchd 復帰確認）

### 設計上の未確定点

4. 業界拡張の判断: 現行 5 業界のシードが尽きた時、どの業界を足すかは Zack の判断が要る（自動化しない）
5. 送信曜日: 土日を送るか。現状は「毎日」と「営業日のみ」のどちらか未確定（推奨: 営業日のみ）
6. `poll_replies` の実行頻度: 日次バッチだけで足りるか、「希望」返信は時間単位で拾うか（推奨: 日次レポート用は朝 1 回、希望検知は 2 時間おき）
7. Cloud Run 側（計測 API）は Air 移設の影響を受けないが、Air が落ちた時の死活監視は本 Plan のスコープ外

## 6. スコープ外

- 商談化以降のパイプライン管理（CRM 連携）
- 過去送信分への遡及計測
- 送信ドメインのウォームアップ・レピュテーション管理の自動化
- #1 ミーティング準備との統合（返信ログを #1 が読む形で後続 Plan にて接続）
