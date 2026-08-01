#!/usr/bin/env python3
"""A/B × LP/PDF の配分。

配分を書き換えるのは 3 日サイクルのレポートを見た Zack のフィードバックだけ。
少数サンプルで勝者を固定すると 1 日 500 通の規模で誤りが一気に効くため、
自動では変更しない（プラン Phase 4 の決定）。
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from outreach import config  # noqa: E402

DEFAULT_CELLS = [
    {"subject_variant": "A", "delivery_variant": "LP", "weight": 1},
    {"subject_variant": "A", "delivery_variant": "PDF", "weight": 1},
    {"subject_variant": "B", "delivery_variant": "LP", "weight": 1},
    {"subject_variant": "B", "delivery_variant": "PDF", "weight": 1},
]


class AllocationError(RuntimeError):
    pass


def load() -> dict:
    path = config.ALLOCATION_PATH
    if not Path(path).is_file():
        return {"copy_generation": "v2", "cells": list(DEFAULT_CELLS)}
    data = json.loads(Path(path).read_text(encoding="utf-8"))
    cells = data.get("cells") or []
    if not cells:
        raise AllocationError(f"配分定義に cells が無い: {path}")
    for cell in cells:
        if cell.get("subject_variant") not in {"A", "B"}:
            raise AllocationError(f"未知の件名バリアント: {cell}")
        if cell.get("delivery_variant") not in {"LP", "PDF"}:
            raise AllocationError(f"未知の送付形式: {cell}")
        if float(cell.get("weight", 0)) < 0:
            raise AllocationError(f"weight が負: {cell}")
    if sum(float(cell.get("weight", 0)) for cell in cells) <= 0:
        raise AllocationError(f"weight の合計が 0: {path}")
    return data


def assign(total: int, cells: list[dict] | None = None) -> list[tuple[str, str]]:
    """total 件を各セルへ割り当て、(件名, 送付形式) の並びを返す。

    端数は weight の大きいセルから順に配る。並びはセルを順繰りに使うため、
    途中で送信が止まってもセル間の偏りが最小になる。
    """
    cells = cells if cells is not None else load()["cells"]
    weights = [float(cell.get("weight", 0)) for cell in cells]
    total_weight = sum(weights)

    counts = [int(total * weight / total_weight) for weight in weights]
    remainder = total - sum(counts)
    # 端数は weight 降順（同率は定義順）で配る。
    order = sorted(range(len(cells)), key=lambda i: (-weights[i], i))
    for index in range(remainder):
        counts[order[index % len(order)]] += 1

    pools = [
        [(cells[i]["subject_variant"], cells[i]["delivery_variant"])] * counts[i]
        for i in range(len(cells))
    ]
    # ラウンドロビンで混ぜる。先頭 100 通だけ送れた場合でも 4 セルが揃う。
    sequence: list[tuple[str, str]] = []
    while any(pools):
        for pool in pools:
            if pool:
                sequence.append(pool.pop())
    return sequence


def copy_generation() -> str:
    return str(load().get("copy_generation", "v2"))
