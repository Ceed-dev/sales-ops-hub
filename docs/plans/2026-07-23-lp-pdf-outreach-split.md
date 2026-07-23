# LP / PDF Outreach Split Plan

## 0. 目的（Purpose）

未送信の営業メール490件をLP版245件・PDF版245件へ割り当て、業界と件名の偏りを抑えた状態で、開封・クリック・返信・商談化を比較できる送信キューを作る。専用のGmail送信認証を使い、2026年7月24日9:00 JSTから重複を防ぎながら自動送信できる状態まで整える。

観測可能な達成状態:

- LP版とPDF版が各245件ある
- 各業界でLP版とPDF版が同数になる
- 件名A/Bが各送付形式へほぼ同数で割り当てられる
- LP版はPDFを添付せず、個別計測リンクから `https://lp.ceed.cloud/` へ遷移する
- PDF版は従来どおりPDFを添付し、個別計測リンクからCalendlyへ遷移する
- 送信済み10件は変更せず、残り490件が送信開始まで未送信で維持される
- 送信元は `yusaku.takahashi@ceed.cloud` に固定される
- 2026年7月24日9:00 JSTに1分間隔、50件ごとに15分休止で起動する
- 認証・レート制限・サーバーエラーでは全体停止し、個別の恒久エラーだけをスキップする
- 成功ごとに送信ログとキューを原子的に更新し、再実行時の重複を抑止する

## 0.1. あるべき姿（Should-be State）

- `/Users/zacky/ceed-workspace/business/sales-leads-20260722/README.md` の「Send Preparation」
- `/Users/zacky/ceed-workspace/business/sales-leads-20260722/README.md` の「Send Execution」
- `/Users/zacky/Programming/sales-ops-hub/docs/plans/2026-07-22-email-engagement-tracking.md` の「3. API」
- `/Users/zacky/Programming/sales-ops-hub/docs/plans/2026-07-22-email-engagement-tracking.md` の「7. リスクと対策」

クリック先はサーバー側の許可済みHTTPS URLへ固定し、公開URLにメールアドレスや企業名を含めない。

## 0.2. 実装基盤（Implementation Basis）

- 計測API: `/Users/zacky/Programming/sales-ops-hub/src/lib/emailTracking.ts`
- 計測テスト: `/Users/zacky/Programming/sales-ops-hub/src/lib/emailTracking.test.ts`
- 送信キュー: `/Users/zacky/ceed-workspace/business/sales-leads-20260722/multisector-email-queue-subject-review-20260722.csv`
- LP: `https://lp.ceed.cloud/`
- PDF: `/Users/zacky/Downloads/株式会社Ceed ご説明資料.pdf`
- 送信処理: `/Users/zacky/Programming/sales-ops-hub/scripts/send_outreach_queue.py`
- 認証処理: `/Users/zacky/Programming/sales-ops-hub/scripts/authorize-gmail-send.mjs`
- 自動起動設定: `/Users/zacky/Programming/sales-ops-hub/scripts/install_outreach_launch_agent.sh`
- Gmail OAuth: `sales-ops-hub` の社内専用デスクトップクライアント

既存の匿名token、開封ピクセル、クリック転送、Campaign summaryを再利用する。新しい外部サービスや依存は追加しない。

## 1. 実装

1. `lp.ceed.cloud` をクリック遷移先の許可ホストへ追加する
2. URL validation、build、既存テストを実行する
3. Cloud Runへ反映し、LPへの302転送を本番確認する
4. 未送信490件を業界・件名ごとに安定したハッシュ順で二分する
5. 新Campaignで送付形式を `bodyVariant=lp_v1/pdf_v1` として登録する
6. LP版は本文CTAをLPへ変更し、添付欄を空にする
7. PDF版は従来本文と添付を維持する
8. 送信済み10件を含む全500件の不変条件を検証する
9. Gmail送信専用scopeで `yusaku.takahashi@ceed.cloud` を認証する
10. LP版・PDF版をテスト宛先へ各1通送り、Gmail APIの送信IDを確認する
11. 送信ロック、開始時間窓、致命的エラー停止、個別エラースキップ、原子的ログ更新を実装する
12. macOS LaunchAgentへ2026年7月24日9:00 JSTの実行を登録する

## 2. 完了条件

- 機構動作: LP用クリックURLが302で `https://lp.ceed.cloud/` へ遷移する
- 機構動作: Gmail APIテスト送信がLP版・PDF版とも成功する
- 機構動作: LaunchAgentが2026年7月24日9:00 JSTの待機状態として登録される
- 目的達成: 245件ずつの比較可能なキューが完成し、送信開始前は送信済み10件と送信ログが変わっていない
- 目的達成: 送信成功ごとにログとキューへ記録され、残件数を復元できる

## 3. 検証結果

- Gmail APIテスト送信: LP版・PDF版とも成功
- キューdry-run: pending 490、LP 245、PDF 245
- sender unit tests: 5件成功
- Python compile / shell syntax: 成功
- OAuthクライアント・トークンの保存権限: 600
- LaunchAgent: `cloud.ceed.outreach-20260724`、実行回数0、待機中
