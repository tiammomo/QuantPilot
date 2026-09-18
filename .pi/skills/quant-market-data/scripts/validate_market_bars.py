#!/usr/bin/env python3
"""Validate QuantPilot's normalized market-bars contract."""

from __future__ import annotations

import argparse
import json
import math
import sys
from datetime import datetime, timezone
from pathlib import Path
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError
from typing import Any


TIME_KEYS = ("ts", "trade_date", "date", "datetime", "timestamp")


def emit(payload: dict[str, Any], code: int) -> int:
    print(json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")))
    return code


def load_json(source: str) -> Any:
    text = sys.stdin.read() if source == "-" else Path(source).read_text(encoding="utf-8")
    return json.loads(text)


def finite_number(value: Any) -> float | None:
    if isinstance(value, bool):
        return None
    try:
        result = float(value)
    except (TypeError, ValueError):
        return None
    return result if math.isfinite(result) else None


def time_value(bar: dict[str, Any]) -> tuple[str | None, datetime | None]:
    raw = next((bar[key] for key in TIME_KEYS if bar.get(key) not in (None, "")), None)
    if not isinstance(raw, str):
        return None, None
    try:
        parsed = datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError:
        return raw, None
    if parsed.tzinfo is not None:
        parsed = parsed.astimezone(timezone.utc)
    return raw, parsed


def validate(payload: Any) -> tuple[list[str], list[str], dict[str, Any]]:
    errors: list[str] = []
    warnings: list[str] = []
    stats: dict[str, Any] = {"row_count": 0}
    if not isinstance(payload, dict):
        return ["root must be a JSON object"], warnings, stats

    symbol = payload.get("symbol")
    if not isinstance(symbol, str) or not symbol.strip():
        errors.append("symbol must be a non-empty string")
    if not isinstance(payload.get("timeframe", payload.get("period")), str):
        warnings.append("timeframe/period is missing")
    if "adjustment" not in payload:
        warnings.append("adjustment is missing")
    if not payload.get("source") and not payload.get("provider"):
        warnings.append("source/provider is missing")

    as_of = None
    if payload.get("as_of") is not None:
        raw_as_of = payload["as_of"]
        try:
            if not isinstance(raw_as_of, str):
                raise ValueError()
            as_of = datetime.fromisoformat(raw_as_of.replace("Z", "+00:00"))
        except ValueError:
            errors.append("as_of must be ISO-8601")
    quality = payload.get("data_quality")
    if quality is not None:
        if not isinstance(quality, dict) or quality.get("status") not in {"ok", "warning", "error", "success", "failed"}:
            errors.append("data_quality must declare a recognized status")
        elif quality["status"] in {"error", "failed"}:
            errors.append("data_quality declares failed market data")
        elif quality["status"] == "warning":
            warnings.append("upstream data_quality declares warnings")

    bars = payload.get("bars")
    if not isinstance(bars, list) or not bars:
        return errors + ["bars must be a non-empty array"], warnings, stats

    stats["row_count"] = len(bars)
    previous: datetime | None = None
    previous_aware: bool | None = None
    raw_times: list[str] = []
    for index, bar in enumerate(bars):
        prefix = f"bars[{index}]"
        if not isinstance(bar, dict):
            errors.append(f"{prefix} must be an object")
            continue
        raw_time, parsed_time = time_value(bar)
        if raw_time is None:
            errors.append(f"{prefix} must contain an ISO timestamp")
        elif parsed_time is None:
            errors.append(f"{prefix} timestamp is not ISO-8601: {raw_time!r}")
        else:
            if as_of is not None:
                if len(raw_time) == 10 and as_of.tzinfo is not None:
                    try:
                        zone = ZoneInfo(payload.get("timezone") or "")
                        if parsed_time.date() > as_of.astimezone(zone).date():
                            errors.append(f"{prefix} date exceeds as_of in market timezone")
                    except (ValueError, ZoneInfoNotFoundError):
                        errors.append("daily bars with timestamp as_of require a valid market timezone")
                elif (as_of.tzinfo is None) != (parsed_time.tzinfo is None):
                    errors.append(f"{prefix} timezone differs from as_of")
                elif parsed_time > as_of:
                    errors.append(f"{prefix} timestamp exceeds as_of")
            aware = parsed_time.tzinfo is not None
            if previous_aware is not None and aware != previous_aware:
                errors.append(f"{prefix} mixes timezone-aware and naive timestamps")
            elif previous is not None and parsed_time <= previous:
                errors.append(f"{prefix} timestamp must be strictly increasing")
            previous, previous_aware = parsed_time, aware
            raw_times.append(raw_time)

        values: dict[str, float] = {}
        for field in ("open", "high", "low", "close"):
            number = finite_number(bar.get(field))
            if number is None or number < 0:
                errors.append(f"{prefix}.{field} must be a finite non-negative number")
            else:
                values[field] = number
        if len(values) == 4:
            if values["high"] < max(values["open"], values["low"], values["close"]):
                errors.append(f"{prefix}.high is below another OHLC value")
            if values["low"] > min(values["open"], values["high"], values["close"]):
                errors.append(f"{prefix}.low is above another OHLC value")
        for field in ("volume", "amount", "turnover"):
            if field in bar and bar[field] is not None:
                number = finite_number(bar[field])
                if number is None or number < 0:
                    errors.append(f"{prefix}.{field} must be a finite non-negative number")

    for field in ("volume", "amount", "turnover"):
        if any(isinstance(bar, dict) and bar.get(field) is None for bar in bars):
            warnings.append(f"{field} is incomplete; missing observations are not zero")
    if raw_times:
        stats.update({"first_ts": raw_times[0], "last_ts": raw_times[-1]})
    summary = payload.get("summary")
    if summary is None:
        warnings.append("summary is missing")
    elif not isinstance(summary, dict):
        errors.append("summary must be an object")
    else:
        if isinstance(summary.get("row_count"), bool) or summary.get("row_count") != len(bars):
            errors.append("summary.row_count does not match bars length")
        if raw_times and summary.get("first_ts") != raw_times[0]:
            errors.append("summary.first_ts does not match the first bar")
        if raw_times and summary.get("last_ts") != raw_times[-1]:
            errors.append("summary.last_ts does not match the last bar")
    return errors, warnings, stats


def main() -> int:
    parser = argparse.ArgumentParser(description="Validate normalized QuantPilot market bars and emit JSON.")
    parser.add_argument("--input", default="-", help="JSON file path, or '-' for stdin (default).")
    args = parser.parse_args()
    try:
        payload = load_json(args.input)
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        return emit({"ok": False, "contract": "quant-market-bars/v1", "errors": [str(exc)], "warnings": []}, 2)
    errors, warnings, stats = validate(payload)
    return emit({"ok": not errors, "contract": "quant-market-bars/v1", "errors": errors, "warnings": warnings, "stats": stats}, 1 if errors else 0)


if __name__ == "__main__":
    raise SystemExit(main())
