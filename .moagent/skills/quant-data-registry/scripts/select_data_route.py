#!/usr/bin/env python3
"""Choose a deterministic local-first QuantPilot data route from known coverage."""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any


SYMBOL_PATTERN = re.compile(r"^(?:\d{6})(?:\.(?:SH|SZ|BJ))?$", re.IGNORECASE)
UNIVERSE_PATTERN = re.compile(r"^[A-Za-z0-9._-]{1,128}$")
OPERATIONS = {
    "registry_discovery",
    "universe_summary",
    "universe_members",
    "coverage_audit",
    "historical_bars",
    "realtime_quote",
    "fundamentals",
    "announcements",
}


def read_input(value: str) -> dict[str, Any]:
    if value == "-":
        raw = sys.stdin.read()
    else:
        candidate = Path(value)
        try:
            is_file = candidate.is_file()
        except OSError:
            is_file = False
        raw = candidate.read_text(encoding="utf-8") if is_file else value
    parsed = json.loads(raw)
    if not isinstance(parsed, dict):
        raise ValueError("--input must resolve to a JSON object")
    return parsed


def string_list(value: Any, field: str) -> list[str]:
    if value is None:
        return []
    if not isinstance(value, list) or any(not isinstance(item, str) for item in value):
        raise ValueError(f"{field} must be an array of strings")
    return list(dict.fromkeys(item.strip() for item in value if item.strip()))


def bool_field(record: dict[str, Any], field: str, default: bool) -> bool:
    value = record.get(field, default)
    if not isinstance(value, bool):
        raise ValueError(f"{field} must be a boolean")
    return value


def normalize_symbol(value: Any) -> str:
    if not isinstance(value, str) or not SYMBOL_PATTERN.fullmatch(value.strip()):
        raise ValueError("symbol must be a six-digit code with an optional .SH/.SZ/.BJ suffix")
    return value.strip().upper()


def choose_route(payload: dict[str, Any]) -> dict[str, Any]:
    operation = payload.get("operation")
    if operation not in OPERATIONS:
        raise ValueError(f"operation must be one of: {', '.join(sorted(OPERATIONS))}")

    base = {
        "schemaVersion": 1,
        "operation": operation,
        "policy": "local_first",
        "registry_endpoint": "/api/v1/registry",
        "warnings": [],
    }
    if operation == "registry_discovery":
        return {**base, "decision": "registry", "endpoint": "/api/v1/registry", "next_skill": None}
    if operation == "universe_summary":
        return {
            **base,
            "decision": "local_universe_summary",
            "endpoint": "/api/v1/research/universes/summary",
            "next_skill": None,
        }

    universe_id = payload.get("universe_id")
    if operation in {"universe_members", "coverage_audit"}:
        if not isinstance(universe_id, str) or not UNIVERSE_PATTERN.fullmatch(universe_id):
            raise ValueError("universe_id must contain only letters, numbers, dot, underscore, or hyphen")
        if operation == "universe_members":
            return {
                **base,
                "decision": "local_universe_members",
                "endpoint": f"/api/v1/research/universes/{universe_id}/members",
                "next_skill": None,
            }
        return {
            **base,
            "decision": "full_coverage_audit",
            "endpoint": f"/api/v1/research/data-coverage?universe_id={universe_id}",
            "next_skill": "data-quality",
            "warnings": ["全池覆盖审计可能返回大量数据；不要把它作为普通对话的默认前置请求。"],
        }

    symbol = normalize_symbol(payload.get("symbol"))
    if operation == "realtime_quote":
        return {
            **base,
            "decision": "realtime_capability",
            "endpoint": f"/api/v1/quotes/realtime/{symbol}",
            "next_skill": "quant-market-data",
        }
    if operation == "fundamentals":
        return {
            **base,
            "decision": "registered_capability",
            "endpoint": None,
            "next_skill": "quant-fundamentals",
            "requires_registry_lookup": True,
        }
    if operation == "announcements":
        return {
            **base,
            "decision": "registered_capability",
            "endpoint": None,
            "next_skill": "quant-fundamentals",
            "requires_registry_lookup": True,
        }

    coverage = payload.get("local_coverage", {})
    if not isinstance(coverage, dict):
        raise ValueError("local_coverage must be an object")
    available = bool_field(coverage, "available", False)
    covers_range = bool_field(coverage, "covers_range", False)
    missing_fields = string_list(coverage.get("missing_fields"), "local_coverage.missing_fields")
    required_fields = string_list(payload.get("required_fields"), "required_fields")
    required_gaps = sorted(set(required_fields).intersection(missing_fields))
    if available and covers_range and not required_gaps:
        return {
            **base,
            "decision": "local_historical_bars",
            "endpoint": f"/api/v1/research/bars/{symbol}",
            "next_skill": None,
            "required_field_gaps": [],
        }

    providers = payload.get("provider_availability", {})
    if not isinstance(providers, dict):
        raise ValueError("provider_availability must be an object")
    for name, enabled in providers.items():
        if name not in {"eastmoney", "baostock", "akshare", "tencent"} or not isinstance(enabled, bool):
            raise ValueError("provider_availability accepts boolean eastmoney, baostock, akshare, and tencent fields")

    fallback = "unavailable"
    endpoint = None
    warnings: list[str] = []
    if providers.get("eastmoney"):
        fallback = "external_history_capability"
    elif providers.get("baostock"):
        fallback = "baostock_ingestion"
        endpoint = "/api/v1/ingestion/baostock/history"
    elif providers.get("akshare"):
        fallback = "akshare_ingestion"
        endpoint = "/api/v1/ingestion/akshare/history"
    elif providers.get("tencent"):
        fallback = "tencent_ohlcv_only"
        warnings.append("腾讯兜底通常不含成交额和换手率，不能覆盖已有增强字段。")
    else:
        warnings.append("本地覆盖不足且没有声明可用 provider；停止并报告真实数据缺口。")

    return {
        **base,
        "decision": fallback,
        "endpoint": endpoint,
        "next_skill": "quant-market-data" if fallback != "unavailable" else None,
        "requires_local_reread_after_ingestion": fallback not in {"unavailable", "tencent_ohlcv_only"},
        "required_field_gaps": required_gaps,
        "warnings": warnings,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Select a deterministic local-first QuantPilot data route.")
    parser.add_argument("--input", required=True, help="JSON object literal, JSON file path, or '-' for stdin.")
    args = parser.parse_args()
    try:
        result = choose_route(read_input(args.input))
    except (OSError, json.JSONDecodeError, ValueError) as error:
        print(json.dumps({"ok": False, "error": str(error)}, ensure_ascii=False), file=sys.stderr)
        return 2
    print(json.dumps(result, ensure_ascii=False, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
