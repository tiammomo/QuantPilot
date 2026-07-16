#!/usr/bin/env python3
"""Normalize QuantPilot financial-summary JSON without external dependencies."""

from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path
from typing import Any


JsonRecord = dict[str, Any]

FIELD_ALIASES: dict[str, tuple[str, ...]] = {
    "basic_eps": ("basic_eps", "eps", "eps_basic"),
    "revenue": ("revenue", "operating_revenue", "total_operating_revenue"),
    "parent_net_profit": (
        "parent_net_profit",
        "net_profit_parent",
        "net_profit_attributable_to_parent",
        "net_profit",
    ),
    "weighted_roe": ("weighted_roe", "roe", "roe_weighted"),
    "gross_margin": ("gross_margin", "gross_profit_margin"),
    "revenue_yoy": ("revenue_yoy", "revenue_growth_yoy", "or_yoy"),
    "net_profit_yoy": ("net_profit_yoy", "profit_yoy", "parent_net_profit_yoy"),
}


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


def first_present(record: JsonRecord, aliases: tuple[str, ...]) -> Any:
    for alias in aliases:
        if alias in record and record[alias] not in (None, ""):
            return record[alias]
    return None


def first_text(record: JsonRecord, aliases: tuple[str, ...]) -> str | None:
    value = first_present(record, aliases)
    return str(value).strip() if value not in (None, "") else None


def extract_reports(value: Any) -> tuple[list[JsonRecord], JsonRecord]:
    if isinstance(value, list):
        return [item for item in value if isinstance(item, dict)], {}
    root = as_record(value)
    if root is None:
        raise ValueError("输入 JSON 根必须是对象或报告数组。")
    financials = as_record(root.get("financials")) or {}
    for candidate in (
        root.get("reports"),
        financials.get("reports"),
        root.get("data"),
        root.get("points"),
    ):
        if isinstance(candidate, list):
            return [item for item in candidate if isinstance(item, dict)], root
    raise ValueError("输入中没有可识别的 reports/data/points 数组。")


def normalize_report(report: JsonRecord, index: int) -> tuple[JsonRecord, list[str]]:
    warnings: list[str] = []
    report_date = first_text(report, ("report_date", "period", "date", "end_date"))
    notice_date = first_text(report, ("notice_date", "announcement_date", "publish_date"))
    data_type = first_text(report, ("data_type", "report_type", "period_type"))
    if report_date is None:
        warnings.append(f"第 {index + 1} 条报告缺少 report_date。")
    if data_type is None:
        warnings.append(f"{report_date or f'第 {index + 1} 条'}缺少 data_type，不能判断累计/单季口径。")

    normalized: JsonRecord = {
        "report_date": report_date,
        "notice_date": notice_date,
        "data_type": data_type,
    }
    for field, aliases in FIELD_ALIASES.items():
        raw = first_present(report, aliases)
        value = numeric(raw)
        normalized[field] = value
        if raw not in (None, "") and value is None:
            warnings.append(f"{report_date or f'第 {index + 1} 条'}的 {field} 不是有限数。")
    return normalized, warnings


def build_normalized(value: Any) -> JsonRecord:
    reports, root = extract_reports(value)
    if not reports:
        raise ValueError("报告数组为空。")
    normalized: list[JsonRecord] = []
    warnings: list[str] = []
    for index, report in enumerate(reports):
        row, row_warnings = normalize_report(report, index)
        normalized.append(row)
        warnings.extend(row_warnings)

    normalized.sort(
        key=lambda row: (
            str(row.get("report_date") or ""),
            str(row.get("notice_date") or ""),
            json.dumps(row, sort_keys=True, ensure_ascii=False),
        ),
        reverse=True,
    )
    deduped: list[JsonRecord] = []
    seen_dates: set[str] = set()
    for index, row in enumerate(normalized):
        report_date = row.get("report_date")
        if isinstance(report_date, str):
            if report_date in seen_dates:
                warnings.append(f"报告期 {report_date} 重复；保留 notice_date/内容排序靠前的一条。")
                continue
            seen_dates.add(report_date)
        else:
            row = {**row, "unresolved_row": index + 1}
        deduped.append(row)

    latest = next((row for row in deduped if row.get("report_date")), deduped[0])
    return {
        "schema_version": 1,
        "symbol": root.get("symbol"),
        "reports": deduped,
        "summary": {
            "latest_report_date": latest.get("report_date"),
            "latest_revenue": latest.get("revenue"),
            "latest_parent_net_profit": latest.get("parent_net_profit"),
            "latest_basic_eps": latest.get("basic_eps"),
            "latest_weighted_roe": latest.get("weighted_roe"),
            "latest_gross_margin": latest.get("gross_margin"),
        },
        "source": root.get("source"),
        "fetched_at": root.get("fetched_at") or root.get("as_of"),
        "data_quality": {
            "status": "warning" if warnings else "ok",
            "input_rows": len(reports),
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
    parser = argparse.ArgumentParser(description="规范化 QuantPilot 财务摘要报告。")
    parser.add_argument("input", nargs="?", default="-", help="JSON 文件；传 - 或省略时读取 stdin。")
    parser.add_argument("-o", "--output", help="可选输出文件；默认输出到 stdout。")
    args = parser.parse_args()
    try:
        emit(build_normalized(read_json(args.input)), args.output)
    except (OSError, UnicodeError, json.JSONDecodeError, ValueError) as error:
        print(f"normalize_financials: {error}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
