#!/usr/bin/env python3
"""Validate a reproducible long-only QuantPilot backtest result."""

from __future__ import annotations

import argparse
import json
import math
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


TIME_KEYS = ("ts", "date", "datetime", "timestamp")
EPSILON = 2e-6


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


def integer(value: Any) -> int | None:
    result = number(value)
    if result is None or not result.is_integer():
        return None
    return int(result)


def parse_iso(value: Any) -> datetime | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        result = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return result.astimezone(timezone.utc) if result.tzinfo else result


def row_time(row: dict[str, Any]) -> tuple[str | None, datetime | None]:
    raw = next((row[key] for key in TIME_KEYS if row.get(key) not in (None, "")), None)
    return (raw, parse_iso(raw)) if isinstance(raw, str) else (None, None)


def normalize_api_response(payload: dict[str, Any]) -> tuple[dict[str, Any], bool]:
    """Map current BacktestResponse percentage units without mutating source evidence."""
    summary = payload.get("summary")
    canonical = isinstance(summary, dict) and ("start_date" in summary or "total_return_pct" in summary)
    if not canonical:
        return payload, False
    def ratio(value):
        parsed = number(value)
        return parsed / 100 if parsed is not None else None
    parameters = payload.get("parameters")
    parameters = dict(parameters) if isinstance(parameters, dict) else {}
    for key in ("fast_window", "slow_window", "fee_bps", "period", "adjustment"):
        if key in payload:
            numeric_key = key in {"fast_window", "slow_window", "fee_bps"}
            same_value = number(parameters.get(key)) == number(payload[key]) if numeric_key else parameters.get(key) == payload[key]
            if key in parameters and not same_value:
                raise ValueError(f"parameters.{key} conflicts with the response")
            parameters[key] = payload[key]
    curve = payload.get("equity_curve")
    trades = payload.get("trades")
    normalized = {**payload, "parameters": parameters,
        "summary": {**summary, "start": summary.get("start_date"), "end": summary.get("end_date"),
            "initial_equity": summary.get("initial_cash"),
            "strategy_return": ratio(summary.get("total_return_pct")),
            "max_drawdown": ratio(summary.get("max_drawdown_pct"))},
        "equity_curve": [{**row, "drawdown": ratio(row.get("drawdown_pct"))} if isinstance(row, dict) else row for row in curve] if isinstance(curve, list) else curve,
        "trades": [{**row, "entry_ts": row.get("entry_date"), "exit_ts": row.get("exit_date")} if isinstance(row, dict) else row for row in trades] if isinstance(trades, list) else trades}
    return normalized, True


def validate(payload: Any) -> tuple[list[str], list[str], dict[str, Any]]:
    errors: list[str] = []
    warnings: list[str] = []
    stats: dict[str, Any] = {}
    if not isinstance(payload, dict):
        return ["root must be a JSON object"], warnings, stats

    try:
        payload, canonical = normalize_api_response(payload)
    except ValueError as error:
        return [str(error)], warnings, stats
    parameters = payload.get("parameters")
    if not isinstance(parameters, dict):
        errors.append("parameters must be an object")
    else:
        fast = integer(parameters.get("fast_window"))
        slow = integer(parameters.get("slow_window"))
        fee = number(parameters.get("fee_bps"))
        if fast is None or fast <= 0:
            errors.append("parameters.fast_window must be a positive integer")
        if slow is None or slow <= 0:
            errors.append("parameters.slow_window must be a positive integer")
        if fast is not None and slow is not None and fast >= slow:
            errors.append("parameters.fast_window must be less than slow_window")
        if fee is None or fee < 0:
            errors.append("parameters.fee_bps must be finite and non-negative")
        if parameters.get("adjustment") not in {"none", "qfq", "hfq"}:
            errors.append("parameters.adjustment must be none, qfq, or hfq")
        if not isinstance(parameters.get("period", parameters.get("timeframe")), str):
            errors.append("parameters.period/timeframe is required")

    summary = payload.get("summary")
    if not isinstance(summary, dict):
        errors.append("summary must be an object")
        summary = {}
    start = summary.get("start", summary.get("first_ts"))
    end = summary.get("end", summary.get("last_ts"))
    start_time, end_time = parse_iso(start), parse_iso(end)
    if start_time is None or end_time is None:
        errors.append("summary requires ISO start and end")
    elif (start_time.tzinfo is None) != (end_time.tzinfo is None):
        errors.append("summary must not mix timezone-aware and naive times")
    elif start_time > end_time:
        errors.append("summary.start must not be after summary.end")
    final_equity = number(summary.get("final_equity"))
    if final_equity is None or final_equity <= 0:
        errors.append("summary.final_equity must be finite and positive")
    strategy_return = number(summary.get("strategy_return"))
    if strategy_return is None:
        errors.append("summary.strategy_return must be finite")
    max_drawdown = number(summary.get("max_drawdown"))
    if max_drawdown is None or not -1 <= max_drawdown <= 0:
        errors.append("summary.max_drawdown must be between -1 and 0")
    trade_count = integer(summary.get("trade_count"))
    if trade_count is None or trade_count < 0:
        errors.append("summary.trade_count must be a non-negative integer")

    initial_equity = number(summary.get("initial_equity"))
    if "initial_equity" in summary and (initial_equity is None or initial_equity <= 0):
        errors.append("summary.initial_cash must be finite and positive")
    curve = payload.get("equity_curve")
    curve_equities: list[float] = []
    curve_drawdowns: list[float] = []
    curve_times: list[str] = []
    if not isinstance(curve, list) or not curve:
        errors.append("equity_curve must be a non-empty array")
    else:
        peak_equity = initial_equity or 0.0
        previous: datetime | None = None
        previous_aware: bool | None = None
        for index, row in enumerate(curve):
            prefix = f"equity_curve[{index}]"
            if not isinstance(row, dict):
                errors.append(f"{prefix} must be an object")
                continue
            raw, parsed = row_time(row)
            if raw is None or parsed is None:
                errors.append(f"{prefix} requires an ISO timestamp")
            else:
                aware = parsed.tzinfo is not None
                if previous_aware is not None and aware != previous_aware:
                    errors.append(f"{prefix} mixes timezone-aware and naive timestamps")
                elif previous is not None and parsed <= previous:
                    errors.append(f"{prefix} timestamp must be strictly increasing")
                previous, previous_aware = parsed, aware
                curve_times.append(raw)
            equity = number(row.get("equity"))
            if equity is None or equity <= 0:
                errors.append(f"{prefix}.equity must be finite and positive")
            else:
                curve_equities.append(equity)
            drawdown = number(row.get("drawdown"))
            if drawdown is None or not -1 <= drawdown <= 0:
                errors.append(f"{prefix}.drawdown must be between -1 and 0")
            else:
                curve_drawdowns.append(drawdown)
                if equity is not None and equity > 0:
                    peak_equity = max(peak_equity, equity)
                    expected_drawdown = equity / peak_equity - 1
                    if not math.isclose(drawdown, expected_drawdown, rel_tol=EPSILON, abs_tol=EPSILON):
                        errors.append(f"{prefix}.drawdown does not match running peak equity")
            position = number(row.get("position"))
            if position not in {0.0, 1.0}:
                errors.append(f"{prefix}.position must be 0 or 1")

    trades = payload.get("trades")
    if not isinstance(trades, list):
        errors.append("trades must be an array")
        trades = []
    else:
        for index, trade in enumerate(trades):
            prefix = f"trades[{index}]"
            if not isinstance(trade, dict):
                errors.append(f"{prefix} must be an object")
                continue
            entry_ts = parse_iso(trade.get("entry_ts", trade.get("buy_date")))
            entry_price = number(trade.get("entry_price", trade.get("buy_price")))
            if entry_ts is None:
                errors.append(f"{prefix} requires an ISO entry timestamp")
            if entry_price is None or entry_price < 0:
                errors.append(f"{prefix} entry price must be finite and non-negative")
            status = trade.get("status", "closed" if trade.get("exit_ts", trade.get("sell_date")) else "open")
            if status not in {"open", "closed"}:
                errors.append(f"{prefix}.status must be open or closed")
            if status == "closed":
                exit_ts = parse_iso(trade.get("exit_ts", trade.get("sell_date")))
                exit_price = number(trade.get("exit_price", trade.get("sell_price")))
                if exit_ts is None:
                    errors.append(f"{prefix} closed trade requires an ISO exit timestamp")
                elif entry_ts is not None:
                    if (exit_ts.tzinfo is None) != (entry_ts.tzinfo is None):
                        errors.append(f"{prefix} mixes timezone-aware and naive trade times")
                    elif exit_ts < entry_ts:
                        errors.append(f"{prefix} exits before entry")
                if exit_price is None or exit_price < 0:
                    errors.append(f"{prefix} exit price must be finite and non-negative")

    data_quality = payload.get("data_quality")
    if not isinstance(data_quality, dict):
        errors.append("data_quality must be an object")
    else:
        if not data_quality.get("source") and not data_quality.get("provider") and not payload.get("source"):
            errors.append("data_quality requires source/provider")
        limitations = data_quality.get("limitations")
        if not isinstance(limitations, list) or not limitations:
            warnings.append("data_quality.limitations is empty or missing")
        if not payload.get("localBarsCoverage") and not data_quality.get("localBarsCoverage"):
            warnings.append("localBarsCoverage is missing")

    expected_trades = sum(isinstance(trade, dict) and trade.get("status") == "closed" for trade in trades) if canonical else len(trades)
    if trade_count is not None and trade_count != expected_trades:
        errors.append("summary.trade_count does not match the contract trade count")
    if curve_equities and final_equity is not None and not math.isclose(curve_equities[-1], final_equity, rel_tol=EPSILON, abs_tol=EPSILON):
        errors.append("summary.final_equity does not match the last curve equity")
    if curve_drawdowns and max_drawdown is not None and not math.isclose(min(curve_drawdowns), max_drawdown, rel_tol=EPSILON, abs_tol=EPSILON):
        errors.append("summary.max_drawdown does not match the curve minimum")
    if curve_equities and strategy_return is not None:
        implied_return = curve_equities[-1] / (initial_equity or curve_equities[0]) - 1
        if not math.isclose(implied_return, strategy_return, rel_tol=EPSILON, abs_tol=EPSILON):
            errors.append("summary.strategy_return does not match first/last curve equity")
    if curve_times and start is not None and curve_times[0] != start:
        errors.append("summary.start does not match the first curve timestamp")
    if curve_times and end is not None and curve_times[-1] != end:
        errors.append("summary.end does not match the last curve timestamp")

    stats.update({"curve_points": len(curve) if isinstance(curve, list) else 0, "trade_count": expected_trades, "start": curve_times[0] if curve_times else None, "end": curve_times[-1] if curve_times else None})
    return errors, warnings, stats


def main() -> int:
    parser = argparse.ArgumentParser(description="Validate a QuantPilot long-only backtest result JSON.")
    parser.add_argument("--input", default="-", help="JSON file path, or '-' for stdin (default).")
    args = parser.parse_args()
    try:
        payload = load_json(args.input)
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        return emit({"ok": False, "contract": "quant-backtest/v1", "errors": [str(exc)], "warnings": []}, 2)
    errors, warnings, stats = validate(payload)
    return emit({"ok": not errors, "contract": "quant-backtest/v1", "errors": errors, "warnings": warnings, "stats": stats}, 1 if errors else 0)


if __name__ == "__main__":
    raise SystemExit(main())
