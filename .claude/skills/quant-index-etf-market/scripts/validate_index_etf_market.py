#!/usr/bin/env python3
"""Validate normalized index or ETF market evidence."""

from __future__ import annotations

import argparse
import json
import math
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


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


def parse_iso(value: Any) -> datetime | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed.astimezone(timezone.utc) if parsed.tzinfo else parsed


def bar_time(bar: dict[str, Any]) -> tuple[str | None, datetime | None]:
    raw = next((bar[key] for key in TIME_KEYS if bar.get(key) not in (None, "")), None)
    return (raw, parse_iso(raw)) if isinstance(raw, str) else (None, None)


def validate(payload: Any) -> tuple[list[str], list[str], dict[str, Any]]:
    errors: list[str] = []
    warnings: list[str] = []
    stats: dict[str, Any] = {}
    if not isinstance(payload, dict):
        return ["root must be a JSON object"], warnings, stats

    if not isinstance(payload.get("symbol"), str) or not payload["symbol"].strip():
        errors.append("symbol must be a non-empty string")
    asset_type = payload.get("asset_type")
    if asset_type not in {"index", "etf"}:
        errors.append("asset_type must be 'index' or 'etf'")
    if not payload.get("source") and not payload.get("provider"):
        errors.append("source/provider is required")

    quote = payload.get("quote")
    bars = payload.get("bars")
    valid_quote = False
    if quote is not None:
        if not isinstance(quote, dict):
            errors.append("quote must be an object")
        else:
            price = number(quote.get("price", quote.get("close")))
            if price is None or price < 0:
                errors.append("quote.price must be a finite non-negative number")
            else:
                valid_quote = True
            if "change_percent" in quote and number(quote["change_percent"]) is None:
                errors.append("quote.change_percent must be finite when present")
            fact_time = payload.get("as_of", payload.get("quote_time", quote.get("quote_time")))
            if parse_iso(fact_time) is None:
                errors.append("a quote requires an ISO as_of/quote_time")
            if payload.get("fetched_at") is None:
                warnings.append("fetched_at is missing for realtime evidence")
            elif parse_iso(payload["fetched_at"]) is None:
                errors.append("fetched_at must be ISO-8601")

    valid_bars = False
    if bars is not None:
        if not isinstance(bars, list) or not bars:
            errors.append("bars must be a non-empty array when present")
        else:
            valid_bars = True
            previous: datetime | None = None
            previous_aware: bool | None = None
            raw_times: list[str] = []
            for index, bar in enumerate(bars):
                prefix = f"bars[{index}]"
                if not isinstance(bar, dict):
                    errors.append(f"{prefix} must be an object")
                    continue
                raw, parsed = bar_time(bar)
                if raw is None or parsed is None:
                    errors.append(f"{prefix} requires an ISO timestamp")
                else:
                    aware = parsed.tzinfo is not None
                    if previous_aware is not None and aware != previous_aware:
                        errors.append(f"{prefix} mixes timezone-aware and naive timestamps")
                    elif previous is not None and parsed <= previous:
                        errors.append(f"{prefix} timestamp must be strictly increasing")
                    previous, previous_aware = parsed, aware
                    raw_times.append(raw)
                values: dict[str, float] = {}
                for field in ("open", "high", "low", "close"):
                    value = number(bar.get(field))
                    if value is None or value < 0:
                        errors.append(f"{prefix}.{field} must be a finite non-negative number")
                    else:
                        values[field] = value
                if len(values) == 4 and (values["high"] < max(values.values()) or values["low"] > min(values.values())):
                    errors.append(f"{prefix} violates the OHLC envelope")
            stats["row_count"] = len(bars)
            if raw_times:
                stats.update({"first_ts": raw_times[0], "last_ts": raw_times[-1]})
    if not valid_quote and not valid_bars:
        errors.append("at least one valid quote or bars series is required")
    stats["evidence"] = [kind for kind, present in (("quote", valid_quote), ("bars", valid_bars)) if present]
    return errors, warnings, stats


def main() -> int:
    parser = argparse.ArgumentParser(description="Validate normalized index/ETF quote or bars JSON.")
    parser.add_argument("--input", default="-", help="JSON file path, or '-' for stdin (default).")
    args = parser.parse_args()
    try:
        payload = load_json(args.input)
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        return emit({"ok": False, "contract": "quant-index-etf-market/v1", "errors": [str(exc)], "warnings": []}, 2)
    errors, warnings, stats = validate(payload)
    return emit({"ok": not errors, "contract": "quant-index-etf-market/v1", "errors": errors, "warnings": warnings, "stats": stats}, 1 if errors else 0)


if __name__ == "__main__":
    raise SystemExit(main())
