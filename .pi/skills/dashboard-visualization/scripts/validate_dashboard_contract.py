#!/usr/bin/env python3
"""Validate a QuantPilot final dashboard-data contract without mutating it."""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any, Iterable


DATA_KEYS = ("quote", "kline", "assets", "comparison", "holdings", "portfolio", "financials", "backtest", "announcements")
FORBIDDEN_MARKERS = re.compile(r"MOCK_DATA|SAMPLE_DATA|STATIC_QUOTES", re.IGNORECASE)
SECRET_KEYS = re.compile(r"token|api[_-]?key|cookie|authorization", re.IGNORECASE)


def read_json(source: str) -> Any:
    try:
        raw = sys.stdin.read() if source == "-" else Path(source).read_text(encoding="utf-8")
        return json.loads(raw)
    except (OSError, json.JSONDecodeError) as exc:
        raise ValueError(f"cannot read valid JSON: {exc}") from exc


def records(value: Any) -> Iterable[dict[str, Any]]:
    if isinstance(value, list):
        yield from (item for item in value if isinstance(item, dict))


def normalized_symbol(value: Any) -> str | None:
    return value.strip().upper() if isinstance(value, str) and value.strip() else None


def collect_symbols(payload: dict[str, Any]) -> set[str]:
    symbols: set[str] = set()
    candidates = [payload, payload.get("quote"), payload.get("kline")]
    candidates.extend(records(payload.get("assets")))
    candidates.extend(records(payload.get("holdings")))
    comparison = payload.get("comparison")
    if isinstance(comparison, dict):
        candidates.extend(records(comparison.get("rows")))
    for candidate in candidates:
        if not isinstance(candidate, dict):
            continue
        symbol = normalized_symbol(candidate.get("symbol") or candidate.get("code"))
        if symbol:
            symbols.add(symbol)
    return symbols


def scan_forbidden(value: Any, path: str = "$") -> list[str]:
    errors: list[str] = []
    if isinstance(value, dict):
        for key, child in value.items():
            child_path = f"{path}.{key}"
            if SECRET_KEYS.search(str(key)) and isinstance(child, str) and child.strip():
                errors.append(f"secret-like value at {child_path}")
            errors.extend(scan_forbidden(child, child_path))
    elif isinstance(value, list):
        for index, child in enumerate(value):
            errors.extend(scan_forbidden(child, f"{path}[{index}]") )
    elif isinstance(value, str) and FORBIDDEN_MARKERS.search(value):
        errors.append(f"mock/static marker at {path}")
    return errors


def validate(payload: Any, expected_template: str | None, expected_symbols: list[str]) -> dict[str, Any]:
    errors: list[str] = []
    if not isinstance(payload, dict):
        return {"ok": False, "errors": ["root must be an object"]}

    if not any(key in payload and payload[key] not in (None, [], {}) for key in DATA_KEYS):
        errors.append("no supported real-data section is present")

    visualization = payload.get("visualization")
    if not isinstance(visualization, dict):
        errors.append("visualization must be an object")
        visualization = {}
    template = visualization.get("template_id") or visualization.get("templateId")
    if not isinstance(template, str) or not template.strip():
        errors.append("visualization.template_id is required")
    elif expected_template and template != expected_template:
        errors.append(f"template mismatch: expected {expected_template}, got {template}")

    required = visualization.get("required_components")
    rendered = visualization.get("rendered_components")
    missing = visualization.get("missing_components")
    if isinstance(required, list) and isinstance(rendered, list):
        required_set = {item for item in required if isinstance(item, str)}
        accounted = {item for item in rendered if isinstance(item, str)}
        if isinstance(missing, list):
            accounted.update(item for item in missing if isinstance(item, str))
        unaccounted = sorted(required_set - accounted)
        if unaccounted:
            errors.append(f"required components are unaccounted for: {unaccounted}")

    actual_symbols = collect_symbols(payload)
    expected = {symbol for value in expected_symbols if (symbol := normalized_symbol(value))}
    absent = sorted(expected - actual_symbols)
    if absent:
        errors.append(f"expected symbols are missing: {absent}")
    errors.extend(scan_forbidden(payload))

    return {
        "ok": not errors,
        "template_id": template,
        "symbols": sorted(actual_symbols),
        "errors": errors,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", default="-", help="dashboard-data JSON path, or - for stdin")
    parser.add_argument("--expected-template")
    parser.add_argument("--expected-symbol", action="append", default=[])
    parser.add_argument("--pretty", action="store_true")
    args = parser.parse_args()
    try:
        result = validate(read_json(args.input), args.expected_template, args.expected_symbol)
    except ValueError as exc:
        result = {"ok": False, "errors": [str(exc)]}
    json.dump(result, sys.stdout, ensure_ascii=False, indent=2 if args.pretty else None)
    sys.stdout.write("\n")
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
