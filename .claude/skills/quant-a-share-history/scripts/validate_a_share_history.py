#!/usr/bin/env python3
"""Validate a normalized A-share historical-bar payload."""

from __future__ import annotations

import argparse
import json
import math
import re
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


SYMBOL = re.compile(r"^\d{6}\.(SH|SZ)$", re.IGNORECASE)
TIMEFRAMES = {"daily", "weekly", "monthly", "minute1", "minute5", "minute15", "minute30", "minute60"}
ADJUSTMENTS = {"none", "qfq", "hfq"}
TIME_KEYS = ("ts", "trade_date", "date", "datetime", "timestamp")


def emit(payload: dict[str, Any], code: int) -> int:
    print(json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")))
    return code


def load_json(source: str) -> Any:
    text = sys.stdin.read() if source == "-" else Path(source).read_text(encoding="utf-8")
    return json.loads(text)


def number(value: Any) -> float | None:
    if isinstance(value, bool):
        return None
    try:
        result = float(value)
    except (TypeError, ValueError):
        return None
    return result if math.isfinite(result) else None


def parse_time(bar: dict[str, Any]) -> tuple[str | None, datetime | None]:
    raw = next((bar[key] for key in TIME_KEYS if bar.get(key) not in (None, "")), None)
    if not isinstance(raw, str):
        return None, None
    try:
        parsed = datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError:
        return raw, None
    return raw, parsed.astimezone(timezone.utc) if parsed.tzinfo else parsed


def validate(payload: Any) -> tuple[list[str], list[str], dict[str, Any]]:
    errors: list[str] = []
    warnings: list[str] = []
    stats: dict[str, Any] = {"row_count": 0}
    if not isinstance(payload, dict):
        return ["root must be a JSON object"], warnings, stats

    symbol = payload.get("symbol")
    if not isinstance(symbol, str) or not SYMBOL.fullmatch(symbol.strip()):
        errors.append("symbol must match six digits plus .SH or .SZ")
    timeframe = payload.get("timeframe", payload.get("period"))
    if timeframe not in TIMEFRAMES:
        errors.append(f"timeframe must be one of {sorted(TIMEFRAMES)}")
    adjustment = payload.get("adjustment")
    if adjustment not in ADJUSTMENTS:
        errors.append(f"adjustment must be one of {sorted(ADJUSTMENTS)}")
    if not payload.get("source") and not payload.get("provider"):
        warnings.append("source/provider is missing")

    bars = payload.get("bars")
    if not isinstance(bars, list) or not bars:
        return errors + ["bars must be a non-empty array"], warnings, stats
    stats["row_count"] = len(bars)
    previous: datetime | None = None
    previous_aware: bool | None = None
    raw_times: list[str] = []
    optional_seen = {"amount": False, "turnover": False}
    for index, bar in enumerate(bars):
        prefix = f"bars[{index}]"
        if not isinstance(bar, dict):
            errors.append(f"{prefix} must be an object")
            continue
        raw, parsed = parse_time(bar)
        if raw is None:
            errors.append(f"{prefix} is missing an ISO timestamp")
        elif parsed is None:
            errors.append(f"{prefix} timestamp is not ISO-8601")
        else:
            aware = parsed.tzinfo is not None
            if previous_aware is not None and aware != previous_aware:
                errors.append(f"{prefix} mixes timezone-aware and naive timestamps")
            elif previous is not None and parsed <= previous:
                errors.append(f"{prefix} timestamp must be strictly increasing")
            previous, previous_aware = parsed, aware
            raw_times.append(raw)

        ohlc: dict[str, float] = {}
        for field in ("open", "high", "low", "close"):
            value = number(bar.get(field))
            if value is None or value < 0:
                errors.append(f"{prefix}.{field} must be a finite non-negative number")
            else:
                ohlc[field] = value
        if len(ohlc) == 4:
            if ohlc["high"] < max(ohlc.values()):
                errors.append(f"{prefix}.high is below another OHLC value")
            if ohlc["low"] > min(ohlc.values()):
                errors.append(f"{prefix}.low is above another OHLC value")
        for field in ("volume", "amount", "turnover"):
            if field in bar:
                value = number(bar[field])
                if value is None or value < 0:
                    errors.append(f"{prefix}.{field} must be a finite non-negative number")
                if field in optional_seen:
                    optional_seen[field] = True

    if raw_times:
        stats.update({"first_ts": raw_times[0], "last_ts": raw_times[-1]})
    summary = payload.get("summary")
    if summary is None:
        warnings.append("summary is missing")
    elif not isinstance(summary, dict):
        errors.append("summary must be an object")
    else:
        if summary.get("row_count") != len(bars):
            errors.append("summary.row_count does not match bars length")
        if raw_times and summary.get("first_ts") != raw_times[0]:
            errors.append("summary.first_ts does not match the first bar")
        if raw_times and summary.get("last_ts") != raw_times[-1]:
            errors.append("summary.last_ts does not match the last bar")
    for field, seen in optional_seen.items():
        if not seen:
            warnings.append(f"no bar contains optional field {field}")
    return errors, warnings, stats


def main() -> int:
    parser = argparse.ArgumentParser(description="Validate an A-share historical-bar JSON contract.")
    parser.add_argument("--input", default="-", help="JSON file path, or '-' for stdin (default).")
    args = parser.parse_args()
    try:
        payload = load_json(args.input)
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        return emit({"ok": False, "contract": "quant-a-share-history/v1", "errors": [str(exc)], "warnings": []}, 2)
    errors, warnings, stats = validate(payload)
    return emit({"ok": not errors, "contract": "quant-a-share-history/v1", "errors": errors, "warnings": warnings, "stats": stats}, 1 if errors else 0)


if __name__ == "__main__":
    raise SystemExit(main())
