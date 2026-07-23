# LP / PDF Outreach Split Plan

## 0. 目的（Purpose）

未送信の営業メール490件をLP版245件・PDF版245件へ割り当て、業界と件名の偏りを抑えた状態で、開封・クリック・返信・商談化を比較できる送信保留キューを作る。

観測可能な達成状態:

- LP版とPDF版が各245件ある
- 各業界でLP版とPDF版が同数になる
- 件名A/Bが各送付形式へほぼ同数で割り当てられる
- LP版はPDFを添付せず、個別計測リンクから `https://lp.ceed.cloud/` へ遷移する
- PDF版は従来どおりPDFを添付し、個別計測リンクからCalendlyへ遷移する
- 送信済み10件は変更せず、残り490件は未送信のまま維持される

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

## 2. 完了条件

- 機構動作: LP用クリックURLが302で `https://lp.ceed.cloud/` へ遷移する
- 目的達成: 245件ずつの比較可能な送信保留キューが完成し、送信済み10件と送信ログが変わっていない
