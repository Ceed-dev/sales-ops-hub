#!/usr/bin/env python3
"""送信キューの添付パスを TCC 保護外の資産ディレクトリへ張り替える。

背景:
    既存キューの「添付PDF」列は ~/Downloads の絶対パスを持つ。macOS の TCC は
    launchd から起動したプロセスに ~/Downloads の読み取りを許さないため、
    2026-07-31 の送信は添付の読み取りで停止した（Plan §0.3）。

このスクリプトは対象キューの添付パスを config.ASSET_DIR 配下へ書き換える。
ファイル名は変えず、資産ディレクトリに同名ファイルが実在し読める場合にのみ
書き換える。既定はドライランで、--apply を付けたときだけ書き込む。
"""

from __future__ import annotations

import argparse
import csv
import shutil
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from outreach import config  # noqa: E402

ATTACHMENT_COLUMN = "添付PDF"


def load_csv(path: Path) -> tuple[list[str], list[dict]]:
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        reader = csv.DictReader(handle)
        return list(reader.fieldnames or []), list(reader)


def write_csv(path: Path, fieldnames: list[str], rows: list[dict]) -> None:
    with path.open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)


def retarget(rows: list[dict]) -> tuple[int, list[str]]:
    """添付パスを資産ディレクトリへ張り替え、(変更行数, 未解決パス) を返す。"""
    changed = 0
    unresolved: list[str] = []
    for row in rows:
        current = (row.get(ATTACHMENT_COLUMN) or "").strip()
        if not current:
            continue
        target = config.ASSET_DIR / Path(current).name
        if target == Path(current):
            continue
        try:
            config.assert_attachment_readable(target)
        except config.AssetAccessError:
            if current not in unresolved:
                unresolved.append(current)
            continue
        row[ATTACHMENT_COLUMN] = str(target)
        changed += 1
    return changed, unresolved


def process(path: Path, apply: bool) -> int:
    fieldnames, rows = load_csv(path)
    if ATTACHMENT_COLUMN not in fieldnames:
        print(f"skip (列なし): {path.name}")
        return 0
    changed, unresolved = retarget(rows)
    for missing in unresolved:
        # 資産ディレクトリに実体が無いものは黙って通さない。
        print(f"  !! 未解決（資産ディレクトリに実体なし）: {missing}")
    print(f"{path.name}: 書き換え対象 {changed} 行 / 全 {len(rows)} 行")
    if changed and apply:
        backup = path.with_suffix(path.suffix + ".bak")
        if not backup.exists():
            shutil.copy2(path, backup)
        write_csv(path, fieldnames, rows)
        print(f"  -> 書き込み完了（バックアップ: {backup.name}）")
    if unresolved:
        return 1
    return 0


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("queues", nargs="+", help="送信キュー CSV のパス")
    parser.add_argument(
        "--apply",
        action="store_true",
        help="実際に書き込む（既定はドライラン）",
    )
    args = parser.parse_args()

    print(f"資産ディレクトリ: {config.ASSET_DIR}")
    exit_code = 0
    for raw in args.queues:
        exit_code |= process(Path(raw).expanduser(), args.apply)
    if not args.apply:
        print("ドライラン。書き込むには --apply を付ける。")
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
