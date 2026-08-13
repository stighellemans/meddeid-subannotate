#!/usr/bin/env python3
"""Refresh the committed taxonomy contract from an meddeid-core checkout."""

from __future__ import annotations

import argparse
from pathlib import Path
import shutil


ROOT = Path(__file__).resolve().parents[1]


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--source",
        type=Path,
        default=ROOT.parent / "meddeid-core" / "contracts" / "taxonomy.json",
    )
    args = parser.parse_args()
    target = ROOT / "contracts" / "taxonomy.json"
    if not args.source.is_file():
        raise SystemExit(f"Missing generated core contract: {args.source}")
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(args.source, target)
    print(target)


if __name__ == "__main__":
    main()
