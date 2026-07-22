# Email Engagement Tracking Implementation Plan

## 0. 目的（Purpose）

Ceedの次回ToB営業メールから、個人情報を追跡URLに含めずに開封・クリックをCampaign単位で記録し、業界・件名・本文別の反応を比較できるようにする。

観測可能な達成状態:

- 管理APIで匿名recipient tokenを発行できる
- 1px画像へのアクセスがFirestoreへopen eventとして保存される
- 計測リンクへのアクセスがclick eventとして保存され、安全な登録済みURLへ転送される
- Campaign summaryで送信対象数、ユニーク開封、ユニーククリック、総イベント数を確認できる
- 内部テストメールをGmailへ送り、実際の開封イベントを確認できる
- 追跡処理に失敗してもメール画像・遷移先の利用を妨げない

## 0.1. あるべき姿（Should-be State）

依頼者の運用設計:

- `/Users/zacky/ceed-workspace/business/sales-leads-20260713/outreach-unified-operations-handoff-20260714.md` の「17.4. 開封・クリック計測の状態」
- `/Users/zacky/ceed-workspace/business/sales-leads-20260713/outreach-unified-operations-handoff-20260714.md` の「17.5. 次回リスト作成前の必須作業」
- `/Users/zacky/ceed-workspace/design/tob-revenue-productization-control-plane-20260721.md` の「5. イベントと自動同期」

開封率は補助指標とし、クリック・返信・商談を主要指標として扱う。メールアドレス、企業名、Campaign情報を公開URLへ直接載せない。

## 0.2. 実装基盤（Implementation Basis）

- 既存コード: `/Users/zacky/Programming/sales-ops-hub/src/index.ts`
- DB: `/Users/zacky/Programming/sales-ops-hub/src/lib/firebase.ts` のFirestore
- 実行環境: 既存Cloud Run `sales-ops-bot`（asia-northeast1）
- デプロイ: `/Users/zacky/Programming/sales-ops-hub/scripts/deploy.sh`
- 認証: 新規 `EMAIL_TRACKING_ADMIN_TOKEN` Secret Manager secret
- URL署名: 新規 `EMAIL_TRACKING_SIGNING_SECRET` Secret Manager secret
- 公開URL: 既存 `PUBLIC_BASE_URL` を使用

新しい外部サービスやランタイム依存は追加しない。Node標準暗号API、Express、Firebase Adminのみを使う。

## 1. 既存コード要約

- Express 5の単一Cloud Runサービス
- Firebase AdminをADCまたはサービスアカウントで初期化
- FirestoreへTelegram、通知、週次レポート等を保存
- `src/index.ts`でルート登録とHTTP server起動を行う
- テストスクリプトは未定義だがTypeScript strict buildは通る

## 2. データモデル

### `emailTrackingRecipients/{tokenHash}`

- `campaignId`: string
- `recipientId`: string（サーバーが生成する匿名ID）
- `registrationFingerprint`: string（冪等payloadのSHA-256）
- `destinationUrl`: string（httpsのみ）
- `industry`, `subjectVariant`, `bodyVariant`: optional string
- `createdAt`, `sentAt`: Timestamp
- `expiresAt`: Timestamp（365日保持用。Firestore TTL対象）
- `firstOpenedAt`, `lastOpenedAt`, `openCount`
- `firstClickedAt`, `lastClickedAt`, `clickCount`
- `scannerOpenCount`, `scannerClickCount`

token plaintextはレスポンス時だけ返し、FirestoreにはSHA-256 hashだけを保存する。
専用署名secretでtokenのMACをDB照会前に検証する。

### `emailTrackingRegistrations/{idempotencyHash}`

- token hash、recipientId、登録payload fingerprint、署名期限
- 同じidempotencyKeyのpayload変更を409にし、キー世代変更後も旧tokenを再現する
- 集計はPIIを含まないためCampaign履歴として保持する

### `emailTrackingEvents/{autoId}`

- `tokenHash`, `campaignId`
- `eventType`: open / click
- `occurredAt`, `expiresAt`（90日保持用。Firestore TTL対象）
- `clientCategory`: google_image_proxy / outlook_proxy / automated_scanner / unknown
- `isLikelyAutomated`: boolean

IPアドレスと生のUser-Agentは保存しない。

### `emailTrackingCampaignSummaryShards/{campaignId}_{shard}`

- recipient数
- non-scanner open/clickとunique数
- known scanner open/click
- 20 shardで一斉登録・開封時の単一document競合を避ける
- summary APIは最大20 shardを合算する
- PIIを含まない集計履歴として保持する（最大20 documents / Campaign）

## 3. API

### `POST /internal/email-tracking/recipients`

- `x-email-tracking-admin-token` 必須
- 冪等な匿名 `idempotencyKey` 必須
- `sentAt` 必須。tokenとrecipientは送信日時から365日で失効
- Campaign情報と登録済み遷移先を受け取る
- token、recipientId、openPixelUrl、clickUrlを返す
- destinationはhttpsかつCeedの許可済みホストのみ
- recipientIdはクライアントから受け取らずサーバーで生成
- 専用署名secretとidempotencyKeyから同じtokenを再現し、再試行で二重登録しない
- 署名secretは現行＋過去2世代のkey ringを許可し、ローテーション後も旧URLを検証する

### `GET /t/o/:token.gif`

- 公開
- open eventをbest-effortで保存
- 同一recipient・日・client種別は1件に重複抑止
- tokenのMACをDB照会前に検証
- 既知scannerはnon-scanner指標から除外
- 常に1x1透明GIFを返す
- `Cache-Control: no-store, no-cache, must-revalidate, private`

### `GET /t/c/:token`

- 公開
- Firestoreに登録済みのdestinationだけへ302転送
- 任意URLをqueryから受け取らずopen redirectを防止
- event保存失敗時も登録先へ転送

### `GET /internal/email-tracking/campaigns/:campaignId/summary`

- `x-email-tracking-admin-token` 必須
- recipient、non-scanner open/click、known scanner件数を返す

## 4. 影響ファイル

- `/Users/zacky/Programming/sales-ops-hub/src/index.ts`
- `/Users/zacky/Programming/sales-ops-hub/src/lib/emailTracking.ts`（新規）
- `/Users/zacky/Programming/sales-ops-hub/src/lib/emailTracking.test.ts`（新規）
- `/Users/zacky/Programming/sales-ops-hub/src/lib/emailTracking.integration.test.ts`（新規）
- `/Users/zacky/Programming/sales-ops-hub/src/types/emailTracking.ts`（新規）
- `/Users/zacky/Programming/sales-ops-hub/package.json`
- `/Users/zacky/Programming/sales-ops-hub/scripts/deploy.sh`
- `/Users/zacky/Programming/sales-ops-hub/.env.example`

## 5. 実装ステップ

1. 型、token hash、URL validation、client分類を実装
2. Firestore transactionでopen/click counterとeventを記録
3. 管理API、画像API、クリックAPI、summary APIを登録
4. Node test runnerで純粋関数、入力validation、HTTP/Firestore統合をテスト
5. strict TypeScript buildとテストを実行
6. 管理tokenとURL署名secretをSecret Managerへ安全に作成
7. Cloud Runへデプロイし、health/API/GIF/redirectを検証
8. テストrecipientを作成し、追跡HTML入りメールを `ykaun16@gmail.com` へ1通送る
9. ユーザー開封後にFirestore summaryでeventを確認

## 6. 検証方法

- `npm run build`
- `npm test`
- 無効なtoken、http destination、認証なし管理APIが拒否される
- GIFレスポンスがimage/gifかつ空でない
- クリック先が登録済みhttps URLに限定される
- 同一tokenの日次重複抑止とscanner除外が正しく更新される
- 本番Cloud Runで管理API、画像、redirect、summaryを確認
- Gmail実機開封は画像プロキシ経由として記録されることを許容

## 7. リスクと対策

- Gmail画像プロキシ: openを参考値として表示する
- セキュリティスキャナ: clientCategoryを記録しnon-scanner指標から除外する
- open redirect: destinationを作成時にhttps検証しDB固定する
- token漏洩: 128-bit identifier、32-bit期限、96-bit MAC、DBにはhashのみ保存
- Firestore障害: pixel/redirectはfail-open、管理APIは明示的に5xx
- 大量イベント: DB前MAC/期限検証、日次重複抑止、20 shard集計、TTLを使う

## 8. スコープ外

- 過去622件への遡及計測
- IPアドレス・位置情報の保存
- ブラウザ指紋
- 独自のマーケティングオートメーションUI
- 返信・商談の自動分類（別Phase）
