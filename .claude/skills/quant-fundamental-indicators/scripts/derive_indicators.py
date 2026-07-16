#!/usr/bin/env python3
"""Derive conservative fundamental indicators from normalized report JSON."""

from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path
from typing import Any


JsonRecord = dict[str, Any]


def as_record(value: Any) -> JsonRecord | None:
    return value if isinstance(value, dict) else None


def numeric(value: Any) -> float | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value) if math.isfinite(value) else None
    if isinstance(value, str) and value.strip():
        cleaned = value.strip().replace(",", "").removesuffix("%").strip()
        try:
            parsed = float(cleaned)
        except ValueError:
            return None
        return parsed if math.isfinite(parsed) else None
    return None


def first_value(record: JsonRecord, *keys: str) -> Any:
    for key in keys:
        if key in record and record[key] not in (None, ""):
            return record[key]
    return None


def first_number(record: JsonRecord, *keys: str) -> float | None:
    return numeric(first_value(record, *keys))


def extract_rows(value: Any) -> tuple[list[JsonRecord], JsonRecord]:
    if isinstance(value, list):
        return [row for row in value if isinstance(row, dict)], {}
    root = as_record(value)
    if root is None:
        raise ValueError("输入 JSON 根必须是对象或报告数组。")
    financials = as_record(root.get("financials")) or {}
    indicators = as_record(root.get("fundamentalIndicators")) or {}
    for candidate in (
        root.get("points"),
        indicators.get("points"),
        root.get("reports"),
        financials.get("reports"),
        root.get("data"),
    ):
        if isinstance(candidate, list):
            return [row for row in candidate if isinstance(row, dict)], root
    raise ValueError("输入中没有可识别的 points/reports/data 数组。")


def normalize_point(row: JsonRecord, index: int) -> tuple[JsonRecord, list[str]]:
    report_date_value = first_value(row, "report_date", "period", "date", "end_date")
    report_date = str(report_date_value).strip() if report_date_value not in (None, "") else None
    revenue = first_number(row, "revenue", "operating_revenue", "total_operating_revenue")
    profit = first_number(
        row,
        "parent_net_profit",
        "net_profit_parent",
        "net_profit_attributable_to_parent",
        "net_profit",
    )
    net_margin = first_number(row, "net_margin", "net_profit_margin")
    warnings: list[str] = []
    if report_date is None:
        warnings.append(f"第 {index + 1} 条记录缺少 report_date。")
    if net_margin is None and revenue is not None and profit is not None:
        if revenue == 0:
            warnings.append(f"{report_date or f'第 {index + 1} 条'}收入为零，净利率不可计算。")
        else:
            net_margin = profit / revenue * 100

    point: JsonRecord = {
        "report_date": report_date,
        "revenue": revenue,
        "parent_net_profit": profit,
        "revenue_yoy": first_number(row, "revenue_yoy", "revenue_growth_yoy", "or_yoy"),
        "net_profit_yoy": first_number(row, "net_profit_yoy", "profit_yoy", "parent_net_profit_yoy"),
        "gross_margin": first_number(row, "gross_margin", "gross_profit_margin"),
        "weighted_roe": first_number(row, "weighted_roe", "roe", "roe_weighted"),
        "net_margin": round(net_margin, 6) if net_margin is not None else None,
    }
    return point, warnings


def average(values: list[float]) -> float | None:
    return round(sum(values) / len(values), 6) if values else None


def build_indicators(value: Any) -> JsonRecord:
    rows, root = extract_rows(value)
    if not rows:
        raise ValueError("指标输入数组为空。")
    points: list[JsonRecord] = []
    warnings: list[str] = []
    for index, row in enumerate(rows):
        point, point_warnings = normalize_point(row, index)
        points.append(point)
        warnings.extend(point_warnings)

    points.sort(
        key=lambda point: (
            str(point.get("report_date") or ""),
            json.dumps(point, ensure_ascii=False, sort_keys=True),
        ),
        reverse=True,
    )
    deduped: list[JsonRecord] = []
    seen: set[str] = set()
    for point in points:
        report_date = point.get("report_date")
        if isinstance(report_date, str):
            if report_date in seen:
                warnings.append(f"报告期 {report_date} 重复；仅保留确定性排序靠前的一条。")
                continue
            seen.add(report_date)
        deduped.append(point)
    latest = next((point for point in deduped if point.get("report_date")), deduped[0])

    roe_values = [value for point in deduped if (value := numeric(point.get("weighted_roe"))) is not None]
    gross_values = [value for point in deduped if (value := numeric(point.get("gross_margin"))) is not None]
    net_values = [value for point in deduped if (value := numeric(point.get("net_margin"))) is not None]
    if len(deduped) < 2:
        warnings.append("有效期间少于 2，平均指标不代表稳定趋势。")
    for label, values in (("ROE", roe_values), ("毛利率", gross_values), ("净利率", net_values)):
        if len(values) < 2:
            warnings.append(f"{label}有效样本少于 2。")

    return {
        "schema_version": 1,
        "symbol": root.get("symbol"),
        "unit": "percentage_points",
        "points": deduped,
        "summary": {
            "latest_report_date": latest.get("report_date"),
            "latest_revenue": latest.get("revenue"),
            "latest_parent_net_profit": latest.get("parent_net_profit"),
            "latest_revenue_yoy": latest.get("revenue_yoy"),
            "latest_net_profit_yoy": latest.get("net_profit_yoy"),
            "latest_gross_margin": latest.get("gross_margin"),
            "latest_weighted_roe": latest.get("weighted_roe"),
            "latest_net_margin": latest.get("net_margin"),
            "avg_roe": average(roe_values),
            "avg_gross_margin": average(gross_values),
            "avg_net_margin": average(net_values),
            "sample_counts": {
                "roe": len(roe_values),
                "gross_margin": len(gross_values),
                "net_margin": len(net_values),
            },
        },
        "source": root.get("source"),
        "fetched_at": root.get("fetched_at") or root.get("as_of"),
        "data_quality": {
            "status": "warning" if warnings else "ok",
            "input_rows": len(rows),
            "output_rows": len(deduped),
            "warnings": warnings,
        },
    }


def read_json(source: str) -> Any:
    text = sys.stdin.read() if source == "-" else Path(source).read_text(encoding="utf-8")
    return json.loads(text)


def emit(value: JsonRecord, output_path: str | None) -> None:
    payload = json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + "\n"
    if output_path:
        output = Path(output_path)
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(payload, encoding="utf-8")
    else:
        sys.stdout.write(payload)


def main() -> int:
    parser = argparse.ArgumentParser(description="从 QuantPilot 财务报告推导保守财务指标。")
    parser.add_argument("input", nargs="?", default="-", help="JSON 文件；传 - 或省略时读取 stdin。")
    parser.add_argument("-o", "--output", help="可选输出文件；默认输出到 stdout。")
    args = parser.parse_args()
    try:
        emit(build_indicators(read_json(args.input)), args.output)
    except (OSError, UnicodeError, json.JSONDecodeError, ValueError) as error:
        print(f"derive_indicators: {error}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
