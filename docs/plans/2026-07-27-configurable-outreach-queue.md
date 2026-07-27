# Configurable Outreach Queue Plan

## 0. 目的（Purpose）

旧Campaignの送信キューを変更せず、2026-07-27に準備した500件の
キューと専用送信ログを明示指定して、既存の重複防止・安全停止条件の
ままドライランおよび送信を実行できるようにする。

観測可能な達成状態:

- キューと送信ログをCLI引数で指定できる
- 引数を省略した既存運用は従来のパスを使う
- `--execute` を指定しない限りGmail API送信は実行されない
- 2026-07-27キューの500件をドライランで検証できる

## 0.1. あるべき姿（Should-be State）

- `/Users/zacky/ceed-workspace/business/sales-leads-20260727/outreach-day1-preflight-20260727.md`
  の「結果」
- `/Users/zacky/ceed-workspace/business/sales-leads-20260727/outreach-day1-send-queue-20260727.csv`
  の500件

旧キュー、旧送信ログ、既存の成功記録には変更を加えない。

## 0.2. 実装基盤（Implementation Basis）

- 既存送信処理:
  `/Users/zacky/Programming/sales-ops-hub/scripts/send_outreach_queue.py`
- 既存テスト:
  `/Users/zacky/Programming/sales-ops-hub/scripts/test_send_outreach_queue.py`
- Gmail認証、送信元検証、追跡要素検証、添付検証、ロック、
  冪等なログ照合は既存実装をそのまま使う

## 1. 実装

1. `--queue-path` と `--send-log-path` を追加する
2. 読み書き先を引数で指定されたパスへ統一する
3. 省略時の既定値が旧パスのままであることをテストする
4. 任意パスを受け取れることをテストする
5. 本日の500件を実送信なしでドライランする

## 2. 完了条件

- 単体テストが成功する
- 本日のキューが `pending=500 / LP=250 / PDF=250` と表示される
- 送信ログが空のままで、キュー全件が `pending_send` のままである
