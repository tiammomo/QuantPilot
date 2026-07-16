#!/usr/bin/env python3
"""Build deterministic QuantPilot source and data-quality evidence from dataset facts."""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any


SENSITIVE_KEY = re.compile(r"(?:^|[_-])(token|secret|password|cookie|authorization|api[_-]?key)(?:$|[_-])", re.IGNORECASE)
SENSITIVE_VALUE = re.compile(r"(?:bearer\s+[A-Za-z0-9._~-]+|(?:api[_-]?key|token|authorization|cookie)=)", re.IGNORECASE)
INPUT_STATUSES = {"success", "ok", "warning", "error", "failed", "skipped"}


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


def reject_sensitive(value: Any, path: str = "input") -> None:
    if isinstance(value, dict):
        for key, item in value.items():
            if SENSITIVE_KEY.search(str(key)):
                raise ValueError(f"sensitive field is not allowed in evidence input: {path}.{key}")
            reject_sensitive(item, f"{path}.{key}")
    elif isinstance(value, list):
        for index, item in enumerate(value):
            reject_sensitive(item, f"{path}[{index}]")
    elif isinstance(value, str) and SENSITIVE_VALUE.search(value):
        raise ValueError(f"possible credential value is not allowed in evidence input: {path}")


def strings(value: Any, field: str) -> list[str]:
    if value is None:
        return []
    if not isinstance(value, list) or any(not isinstance(item, str) for item in value):
        raise ValueError(f"{field} must be an array of strings")
    return list(dict.fromkeys(item.strip() for item in value if item.strip()))


def optional_string(record: dict[str, Any], field: str) -> str | None:
    value = record.get(field)
    if value is None:
        return None
    if not isinstance(value, str):
        raise ValueError(f"{field} must be a string or null")
    return value.strip() or None


def assess_dataset(item: Any, index: int) -> tuple[dict[str, Any], dict[str, Any], dict[str, Any]]:
    if not isinstance(item, dict):
        raise ValueError(f"datasets[{index}] must be an object")
    dataset = item.get("dataset", item.get("id"))
    if not isinstance(dataset, str) or not dataset.strip():
        raise ValueError(f"datasets[{index}].dataset must be a non-empty string")
    dataset = dataset.strip()
    required = item.get("required", True)
    if not isinstance(required, bool):
        raise ValueError(f"datasets[{index}].required must be a boolean")
    row_count = item.get("row_count")
    if row_count is not None and (isinstance(row_count, bool) or not isinstance(row_count, int) or row_count < 0):
        raise ValueError(f"datasets[{index}].row_count must be a non-negative integer or null")
    input_status = item.get("status", "success")
    if not isinstance(input_status, str) or input_status not in INPUT_STATUSES:
        raise ValueError(f"datasets[{index}].status must be one of: {', '.join(sorted(INPUT_STATUSES))}")

    required_fields = strings(item.get("required_fields"), f"datasets[{index}].required_fields")
    critical_fields = strings(item.get("critical_fields"), f"datasets[{index}].critical_fields")
    available_fields = strings(item.get("available_fields"), f"datasets[{index}].available_fields")
    missing_fields = strings(item.get("missing_fields"), f"datasets[{index}].missing_fields")
    missing_fields = list(dict.fromkeys([*missing_fields, *(field for field in required_fields if field not in available_fields)]))
    warnings = strings(item.get("warnings"), f"datasets[{index}].warnings")

    source = optional_string(item, "source")
    endpoint = optional_string(item, "endpoint")
    artifact_path = optional_string(item, "artifact_path")
    fetched_at = optional_string(item, "fetched_at")
    as_of = optional_string(item, "as_of") or optional_string(item, "quote_time")
    if source is None:
        missing_fields.append("source")
        warnings.append("缺少可验证的数据来源。")
    if fetched_at is None:
        missing_fields.append("fetched_at")
        warnings.append("缺少真实获取时间，未自动生成时间戳。")
    if artifact_path is None:
        missing_fields.append("artifact_path")
        warnings.append("缺少本地原始数据产物路径。")
    if row_count is None:
        missing_fields.append("row_count")
        warnings.append("缺少样本数。")

    critical_missing = sorted(set(critical_fields).intersection(missing_fields))
    failed = input_status in {"error", "failed"} or (required and row_count == 0) or bool(critical_missing)
    warned = bool(missing_fields or warnings) or input_status in {"warning", "skipped"}
    status = "error" if failed else "warning" if warned else "ok"
    missing_fields = list(dict.fromkeys(missing_fields))
    warnings = list(dict.fromkeys(warnings))

    source_row = {
        "dataset": dataset,
        "symbol": optional_string(item, "symbol"),
        "name": optional_string(item, "name"),
        "source": source,
        "endpoint": endpoint,
        "artifact_path": artifact_path,
        "as_of": as_of,
        "fetched_at": fetched_at,
        "status": "failed" if status == "error" else "warning" if status == "warning" else "success",
    }
    quality_row = {
        "dataset": dataset,
        "symbol": optional_string(item, "symbol"),
        "row_count": row_count,
        "source": source,
        "fetched_at": fetched_at,
        "as_of": as_of,
        "missing_fields": missing_fields,
        "warnings": warnings,
        "status": status,
        "required": required,
    }
    summary = (
        f"{dataset} 核心数据不可用。" if status == "error"
        else f"{dataset} 可用但存在 {len(missing_fields) + len(warnings)} 项质量提示。" if status == "warning"
        else f"{dataset} 数据质量检查通过。"
    )
    check = {
        "id": f"dataset_{index + 1}_quality",
        "dataset": dataset,
        "status": status,
        "row_count": row_count,
        "missing_fields": missing_fields,
        "summary": summary,
    }
    return source_row, quality_row, check


def build_evidence(payload: dict[str, Any]) -> dict[str, Any]:
    reject_sensitive(payload)
    run_id = payload.get("runId")
    if run_id is not None and not isinstance(run_id, str):
        raise ValueError("runId must be a string or null")
    created_at = payload.get("created_at")
    if created_at is not None and not isinstance(created_at, str):
        raise ValueError("created_at must be a string or null")
    datasets = payload.get("datasets")
    if not isinstance(datasets, list) or not datasets:
        raise ValueError("datasets must be a non-empty array")
    limitations = strings(payload.get("limitations"), "limitations")

    source_rows: list[dict[str, Any]] = []
    quality_rows: list[dict[str, Any]] = []
    checks: list[dict[str, Any]] = []
    for index, item in enumerate(datasets):
        source, quality, check = assess_dataset(item, index)
        source_rows.append(source)
        quality_rows.append(quality)
        checks.append(check)

    statuses = [row["status"] for row in quality_rows]
    overall = "error" if "error" in statuses else "warning" if "warning" in statuses else "ok"
    warnings = list(dict.fromkeys(
        warning for row in quality_rows for warning in row["warnings"]
    ))
    return {
        "schemaVersion": 1,
        "sources": {
            "schemaVersion": 1,
            "runId": run_id,
            "created_at": created_at,
            "sources": source_rows,
        },
        "data_quality": {
            "schemaVersion": 1,
            "runId": run_id,
            "status": overall,
            "created_at": created_at,
            "datasets": quality_rows,
            "checks": checks,
            "warnings": warnings,
            "limitations": limitations,
        },
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Build source and data-quality evidence from verified dataset metadata.")
    parser.add_argument("--input", required=True, help="JSON object literal, JSON file path, or '-' for stdin.")
    args = parser.parse_args()
    try:
        result = build_evidence(read_input(args.input))
    except (OSError, json.JSONDecodeError, ValueError) as error:
        print(json.dumps({"ok": False, "error": str(error)}, ensure_ascii=False), file=sys.stderr)
        return 2
    print(json.dumps(result, ensure_ascii=False, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
