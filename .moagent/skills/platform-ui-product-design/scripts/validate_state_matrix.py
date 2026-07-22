#!/usr/bin/env python3
"""Validate the deterministic delivery matrix for a QuantPilot platform page."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any


REQUIRED_STATES = ("loading", "empty", "error", "disabled", "pending", "long_text")
REQUIRED_ACCESSIBILITY = (
    "keyboard_focus",
    "icon_labels",
    "semantic_headings",
    "color_independent_status",
)
REQUIRED_VIEWPORTS = {375, 768, 1440}


def read_json(source: str) -> Any:
    try:
        raw = sys.stdin.read() if source == "-" else Path(source).read_text(encoding="utf-8")
        return json.loads(raw)
    except (OSError, json.JSONDecodeError) as exc:
        raise ValueError(f"cannot read valid JSON: {exc}") from exc


def validate(payload: Any) -> dict[str, Any]:
    errors: list[str] = []
    if not isinstance(payload, dict):
        return {"ok": False, "errors": ["root must be an object"]}

    if not isinstance(payload.get("page"), str) or not payload["page"].strip():
        errors.append("page must be a non-empty string")
    if not isinstance(payload.get("primary_action"), str) or not payload["primary_action"].strip():
        errors.append("primary_action must be a non-empty string")

    viewports = payload.get("viewports")
    viewport_set = {value for value in viewports if isinstance(value, int)} if isinstance(viewports, list) else set()
    missing_viewports = sorted(REQUIRED_VIEWPORTS - viewport_set)
    if missing_viewports:
        errors.append(f"missing required viewports: {missing_viewports}")

    states = payload.get("states")
    if not isinstance(states, dict):
        errors.append("states must be an object")
    else:
        missing = [name for name in REQUIRED_STATES if states.get(name) is not True]
        if missing:
            errors.append(f"states not evidenced: {missing}")

    accessibility = payload.get("accessibility")
    if not isinstance(accessibility, dict):
        errors.append("accessibility must be an object")
    else:
        missing = [name for name in REQUIRED_ACCESSIBILITY if accessibility.get(name) is not True]
        if missing:
            errors.append(f"accessibility checks not evidenced: {missing}")

    evidence = payload.get("evidence")
    if not isinstance(evidence, list) or not evidence or any(
        not isinstance(item, str) or not item.strip() for item in evidence
    ):
        errors.append("evidence must be a non-empty string array")

    return {
        "ok": not errors,
        "page": payload.get("page"),
        "required_viewports": sorted(REQUIRED_VIEWPORTS),
        "errors": errors,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", default="-", help="JSON file path, or - for stdin")
    parser.add_argument("--pretty", action="store_true", help="pretty-print the JSON result")
    args = parser.parse_args()
    try:
        result = validate(read_json(args.input))
    except ValueError as exc:
        result = {"ok": False, "errors": [str(exc)]}
    json.dump(result, sys.stdout, ensure_ascii=False, indent=2 if args.pretty else None)
    sys.stdout.write("\n")
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
