#!/usr/bin/env python3
"""Validate chronological daily bars before deterministic indicator computation."""
import argparse
from datetime import datetime
import json
import math
from pathlib import Path
import sys


def validate_bars(bars):
    if not isinstance(bars, list):
        raise ValueError("bars must be an array")
    previous = None
    for index, bar in enumerate(bars):
        if not isinstance(bar, dict):
            raise ValueError(f"bars[{index}] must be an object")
        raw = bar.get("date") or bar.get("time") or bar.get("timestamp") or bar.get("ts")
        if not isinstance(raw, str):
            raise ValueError(f"bars[{index}] requires an ISO date/time")
        current = datetime.fromisoformat(raw.replace("Z", "+00:00"))
        if previous is not None:
            if (current.tzinfo is None) != (previous.tzinfo is None) or current <= previous:
                raise ValueError("bars must have consistent timezones and strictly increasing timestamps")
        previous = current
        for field in ("close", "volume", "amount"):
            value = bar.get(field)
            if field != "close" and value is None:
                continue
            if isinstance(value, bool) or not isinstance(value, (int, float, str)):
                raise ValueError(f"bars[{index}].{field} must be numeric")
            number = float(value)
            if not math.isfinite(number) or number < 0 or (field == "close" and number == 0):
                raise ValueError(f"bars[{index}].{field} is outside its finite range")
    return bars


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", default="-", help="JSON bars array path, or - for stdin")
    args = parser.parse_args()
    try:
        raw = sys.stdin.read() if args.input == "-" else Path(args.input).read_text(encoding="utf-8")
        bars = validate_bars(json.loads(raw))
        print(json.dumps({"ok": True, "row_count": len(bars)}))
        return 0
    except (OSError, ValueError) as error:
        print(json.dumps({"ok": False, "error": str(error)}), file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
