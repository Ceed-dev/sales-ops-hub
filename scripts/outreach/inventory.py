#!/usr/bin/env python3
"""リード在庫の水位監視。

「毎営業日 500 通」を続けられるかは在庫で決まる。閾値を割ったら
業界を追加するか収集の目標値を上げる必要があり、その判断は Zack が行う。
ここは判断材料を出すところまでを担当する。
"""

from __future__ import annotations

import argparse
import json
import sys
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from outreach import config, leadpool, notify  # noqa: E402


def snapshot() -> dict:
    leadpool.apply_suppression_to_pool()
    pool = leadpool.load_pool()
    by_status = Counter(row.get("status", "") for row in pool)
    available = by_status.get(leadpool.STATUS_NEW, 0)
    target = max(config.DAILY_SEND_TARGET, 1)
    return {
        "pool_total": len(pool),
        "by_status": dict(by_status),
        "available": available,
        "daily_target": target,
        # 営業日換算。MX 不通で落ちる分があるため実際はこれより短くなる。
        "business_days_remaining": round(available / target, 1),
        "threshold_business_days": config.INVENTORY_MIN_BUSINESS_DAYS,
        "by_industry": dict(
            Counter(
                row.get("industry", "")
                for row in pool
                if row.get("status") == leadpool.STATUS_NEW
            )
        ),
    }


def check(notify_on_low: bool = True) -> dict:
    state = snapshot()
    low = state["business_days_remaining"] < state["threshold_business_days"]
    state["below_threshold"] = low

    if low and notify_on_low:
        by_industry = "\n".join(
            f"  {name}: {count:,} 件"
            for name, count in sorted(
                state["by_industry"].items(), key=lambda item: -item[1]
            )
        )
        notify.warn(
            "営業メール: リード在庫が閾値を下回った",
            (
                f"送信可能 {state['available']:,} 件 = "
                f"約 {state['business_days_remaining']} 営業日分"
                f"（閾値 {state['threshold_business_days']} 営業日）\n"
                f"業界別内訳:\n{by_industry}\n\n"
                "対応の選択肢: 業界を追加する / 収集の目標件数を上げる。"
                "どの業界を足すかは判断が必要なため自動化していない。"
            ),
        )
    return state


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--quiet",
        action="store_true",
        help="閾値を割っても Slack へ通知しない",
    )
    args = parser.parse_args()
    state = check(notify_on_low=not args.quiet)
    print(json.dumps(state, ensure_ascii=False))
    # 在庫不足は処理の失敗ではないため終了コードは 0 のまま。
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
