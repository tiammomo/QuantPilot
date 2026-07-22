#!/usr/bin/env python3
"""Normalize screenshot extraction fields and expose every unresolved value."""

from __future__ import annotations

import argparse
import json
import math
import re
import sys
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any


ACCOUNT_FIELDS = (
    "account_total_asset",
    "cash_available",
    "market_value",
    "daily_pnl",
    "total_pnl",
    "position_ratio",
)
HOLDING_FIELDS = (
    "name",
    "symbol_if_visible_or_resolved",
    "quantity",
    "cost_price",
    "current_price",
    "market_value",
    "pnl",
    "pnl_percent",
)
NUMERIC_HOLDING_FIELDS = set(HOLDING_FIELDS) - {"name", "symbol_if_visible_or_resolved"}
NULL_MARKERS = {"", "-", "--", "—", "暂无", "未知", "null", "none", "n/a"}
HASH_PATTERN = re.compile(r"^[a-fA-F0-9]{64}$")
SYMBOL_PATTERN = re.compile(r"^(?:\d{6})(?:\.(?:SH|SZ|BJ))?$", re.IGNORECASE)


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


def normalized_number(value: Any) -> int | float | None:
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return value if not isinstance(value, float) or math.isfinite(value) else None
    if not isinstance(value, str):
        return None
    text = value.strip().lower()
    if text in NULL_MARKERS:
        return None
    negative = text.startswith("(") and text.endswith(")")
    text = text.strip("()").replace(",", "").replace("，", "")
    text = re.sub(r"^(?:cny|rmb|¥|￥)", "", text, flags=re.IGNORECASE).strip()
    text = text.removesuffix("%").strip()
    multiplier = Decimal(1)
    for suffix, factor in (("万", Decimal(10000)), ("亿", Decimal(100000000))):
        if text.endswith(suffix):
            text = text[: -len(suffix)].strip()
            multiplier = factor
            break
    try:
        number = Decimal(text) * multiplier
    except InvalidOperation:
        return None
    if not number.is_finite():
        return None
    if negative:
        number = -number
    return int(number) if number == number.to_integral_value() else float(number)


def normalize_images(value: Any) -> list[dict[str, Any]]:
    if not isinstance(value, list) or not value:
        raise ValueError("images must be a non-empty array")
    result: list[dict[str, Any]] = []
    for index, item in enumerate(value):
        if not isinstance(item, dict):
            raise ValueError(f"images[{index}] must be an object")
        path = item.get("path")
        sha256 = item.get("sha256")
        if not isinstance(path, str) or not path.strip():
            raise ValueError(f"images[{index}].path must be a non-empty string")
        if not isinstance(sha256, str) or not HASH_PATTERN.fullmatch(sha256):
            raise ValueError(f"images[{index}].sha256 must be a 64-character hex digest")
        result.append({
            "path": path.strip(),
            "sha256": sha256.lower(),
            "name": item.get("name") if isinstance(item.get("name"), str) else None,
            "mimeType": item.get("mimeType") if isinstance(item.get("mimeType"), str) else None,
            "width": item.get("width") if isinstance(item.get("width"), int) else None,
            "height": item.get("height") if isinstance(item.get("height"), int) else None,
        })
    return result


def normalize(payload: dict[str, Any]) -> dict[str, Any]:
    run_id = payload.get("runId")
    if run_id is not None and not isinstance(run_id, str):
        raise ValueError("runId must be a string or null")
    images = normalize_images(payload.get("images"))
    extraction = payload.get("imageExtraction", {})
    if not isinstance(extraction, dict):
        raise ValueError("imageExtraction must be an object")
    raw_fields = payload.get("extractedFields", extraction.get("extractedFields", {}))
    if not isinstance(raw_fields, dict):
        raise ValueError("extractedFields must be an object")

    warnings: list[str] = []
    manual: list[str] = []
    fields: dict[str, Any] = {}
    for field in ACCOUNT_FIELDS:
        normalized = normalized_number(raw_fields.get(field))
        fields[field] = normalized
        if normalized is None:
            manual.append(field)
            if raw_fields.get(field) not in (None, "", "-", "--", "—"):
                warnings.append(f"{field} 无法可靠转换为数值，已置为 null。")

    raw_holdings = raw_fields.get("holdings", [])
    if not isinstance(raw_holdings, list):
        raise ValueError("extractedFields.holdings must be an array")
    holdings: list[dict[str, Any]] = []
    for index, raw_holding in enumerate(raw_holdings):
        if not isinstance(raw_holding, dict):
            raise ValueError(f"holdings[{index}] must be an object")
        holding: dict[str, Any] = {}
        for field in HOLDING_FIELDS:
            raw = raw_holding.get(field, raw_holding.get("symbol") if field == "symbol_if_visible_or_resolved" else None)
            path = f"holdings[{index}].{field}"
            if field in NUMERIC_HOLDING_FIELDS:
                value = normalized_number(raw)
            elif field == "symbol_if_visible_or_resolved":
                value = raw.strip().upper() if isinstance(raw, str) and SYMBOL_PATTERN.fullmatch(raw.strip()) else None
            else:
                value = raw.strip() if isinstance(raw, str) and raw.strip() else None
            holding[field] = value
            if value is None:
                manual.append(path)
                if raw not in (None, "", "-", "--", "—"):
                    warnings.append(f"{path} 无法可靠标准化，已置为 null。")
        holdings.append(holding)
    fields["holdings"] = holdings
    if not holdings:
        manual.append("holdings")

    supplied_manual = payload.get("manual_confirmation_fields", extraction.get("manual_confirmation_fields", []))
    if supplied_manual is not None:
        if not isinstance(supplied_manual, list) or any(not isinstance(item, str) for item in supplied_manual):
            raise ValueError("manual_confirmation_fields must be an array of strings")
        manual.extend(item.strip() for item in supplied_manual if item.strip())
    manual = list(dict.fromkeys(manual))
    extracted_at = payload.get("extracted_at", extraction.get("extracted_at"))
    if extracted_at is not None and not isinstance(extracted_at, str):
        raise ValueError("extracted_at must be a string or null")

    return {
        "schemaVersion": 1,
        "runId": run_id,
        "status": "needs_manual_confirmation" if manual else "ready",
        "images": images,
        "imageExtraction": {
            "source": "uploaded_image",
            "extracted_at": extracted_at,
            "extractedFields": fields,
            "needs_manual_confirmation": bool(manual),
            "manual_confirmation_fields": manual,
        },
        "warnings": list(dict.fromkeys(warnings)),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Normalize image-extraction fields without guessing missing values.")
    parser.add_argument("--input", required=True, help="JSON object literal, JSON file path, or '-' for stdin.")
    args = parser.parse_args()
    try:
        result = normalize(read_input(args.input))
    except (OSError, json.JSONDecodeError, ValueError) as error:
        print(json.dumps({"ok": False, "error": str(error)}, ensure_ascii=False), file=sys.stderr)
        return 2
    print(json.dumps(result, ensure_ascii=False, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
