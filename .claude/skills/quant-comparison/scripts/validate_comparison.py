#!/usr/bin/env python3
"""Validate multi-asset comparison coverage and comparability."""

from __future__ import annotations

import argparse
import json
import math
import sys
from datetime import datetime
from pathlib import Path
from typing import Any


def emit(payload: dict[str, Any], code: int) -> int:
    print(json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")))
    return code


def load_json(source: str) -> Any:
    text = sys.stdin.read() if source == "-" else Path(source).read_text(encoding="utf-8")
    return json.loads(text)


def symbol(value: Any) -> str | None:
    return value.strip().upper() if isinstance(value, str) and value.strip() else None


def finite(value: Any) -> float | None:
    if isinstance(value, bool):
        return None
    try:
        result = float(value)
    except (TypeError, ValueError):
        return None
    return result if math.isfinite(result) else None


def iso_date(value: Any) -> bool:
    if not isinstance(value, str):
        return False
    try:
        datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return False
    return True


def parse_iso(value: Any) -> datetime | None:
    if not isinstance(value, str):
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


def duplicates(values: list[str]) -> list[str]:
    seen: set[str] = set()
    repeated: set[str] = set()
    for value in values:
        (repeated if value in seen else seen).add(value)
    return sorted(repeated)


def validate(payload: Any) -> tuple[list[str], list[str], dict[str, Any]]:
    errors: list[str] = []
    warnings: list[str] = []
    stats: dict[str, Any] = {}
    if not isinstance(payload, dict):
        return ["root must be a JSON object"], warnings, stats

    requested_raw = payload.get("requestedSymbols")
    if not isinstance(requested_raw, list):
        return ["requestedSymbols must be an array"], warnings, stats
    requested = [symbol(item) for item in requested_raw]
    if any(item is None for item in requested):
        errors.append("requestedSymbols must contain only non-empty strings")
    requested_clean = [item for item in requested if item is not None]
    if len(requested_clean) < 2:
        errors.append("at least two requestedSymbols are required")
    repeated = duplicates(requested_clean)
    if repeated:
        errors.append(f"requestedSymbols contains duplicates: {repeated}")

    assets = payload.get("assets")
    asset_symbols: list[str] = []
    if not isinstance(assets, list):
        errors.append("assets must be an array")
    else:
        for index, asset in enumerate(assets):
            if not isinstance(asset, dict):
                errors.append(f"assets[{index}] must be an object")
                continue
            code = symbol(asset.get("symbol"))
            if code is None:
                errors.append(f"assets[{index}].symbol is required")
            else:
                asset_symbols.append(code)
            if not asset.get("source") and not asset.get("provider"):
                errors.append(f"assets[{index}] requires source/provider")
        repeated_assets = duplicates(asset_symbols)
        if repeated_assets:
            errors.append(f"assets contains duplicate symbols: {repeated_assets}")

    comparison = payload.get("comparison")
    if not isinstance(comparison, dict):
        return errors + ["comparison must be an object"], warnings, stats
    window = comparison.get("window")
    start = window.get("start") if isinstance(window, dict) else None
    end = window.get("end") if isinstance(window, dict) else None
    start_time, end_time = parse_iso(start), parse_iso(end)
    if start_time is None or end_time is None:
        errors.append("comparison.window requires ISO start and end")
    elif (start_time.tzinfo is None) != (end_time.tzinfo is None):
        errors.append("comparison.window must not mix timezone-aware and naive values")
    elif start_time > end_time:
        errors.append("comparison.window.start must not be after end")

    rows = comparison.get("rows")
    row_symbols: list[str] = []
    if not isinstance(rows, list) or not rows:
        errors.append("comparison.rows must be a non-empty array")
    else:
        for index, row in enumerate(rows):
            prefix = f"comparison.rows[{index}]"
            if not isinstance(row, dict):
                errors.append(f"{prefix} must be an object")
                continue
            code = symbol(row.get("symbol"))
            if code is None:
                errors.append(f"{prefix}.symbol is required")
            else:
                row_symbols.append(code)
            if not row.get("source") and not row.get("provider"):
                errors.append(f"{prefix} requires source/provider")
            if not iso_date(row.get("as_of")):
                errors.append(f"{prefix}.as_of must be ISO-8601")
            for field in ("period_return", "max_drawdown"):
                value = finite(row.get(field))
                if value is None:
                    errors.append(f"{prefix}.{field} must be finite")
                elif field == "max_drawdown" and not -1 <= value <= 0:
                    errors.append(f"{prefix}.max_drawdown must be between -1 and 0")
            volatility = row.get("volatility", row.get("volatility20d"))
            volatility_value = finite(volatility)
            if volatility_value is None or volatility_value < 0:
                errors.append(f"{prefix} requires a finite non-negative volatility metric")
            if "window_start" in row and row["window_start"] != start:
                errors.append(f"{prefix}.window_start differs from the common window")
            if "window_end" in row and row["window_end"] != end:
                errors.append(f"{prefix}.window_end differs from the common window")
        repeated_rows = duplicates(row_symbols)
        if repeated_rows:
            errors.append(f"comparison.rows contains duplicate symbols: {repeated_rows}")

    requested_set = set(requested_clean)
    missing_assets = sorted(requested_set - set(asset_symbols))
    missing_rows = sorted(requested_set - set(row_symbols))
    if missing_assets:
        errors.append(f"requested symbols missing from assets: {missing_assets}")
    if missing_rows:
        errors.append(f"requested symbols missing from comparison.rows: {missing_rows}")
    extra_rows = sorted(set(row_symbols) - requested_set)
    if extra_rows:
        warnings.append(f"comparison.rows contains non-requested symbols: {extra_rows}")
    stats.update({"requested_count": len(requested_clean), "asset_count": len(asset_symbols), "row_count": len(row_symbols), "window": {"start": start, "end": end}})
    return errors, warnings, stats


def main() -> int:
    parser = argparse.ArgumentParser(description="Validate a QuantPilot multi-symbol comparison JSON contract.")
    parser.add_argument("--input", default="-", help="JSON file path, or '-' for stdin (default).")
    args = parser.parse_args()
    try:
        payload = load_json(args.input)
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        return emit({"ok": False, "contract": "quant-comparison/v1", "errors": [str(exc)], "warnings": []}, 2)
    errors, warnings, stats = validate(payload)
    return emit({"ok": not errors, "contract": "quant-comparison/v1", "errors": errors, "warnings": warnings, "stats": stats}, 1 if errors else 0)


if __name__ == "__main__":
    raise SystemExit(main())
