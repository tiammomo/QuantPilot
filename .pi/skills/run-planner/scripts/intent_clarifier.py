#!/usr/bin/env python3
"""Validate platform plan/rewrite consistency; never infer intent from keywords."""
from __future__ import annotations
import argparse
import json
import sys
from pathlib import Path
from typing import Any


def validate(payload: Any) -> dict[str, Any]:
    errors: list[str] = []
    if not isinstance(payload, dict):
        return {"valid": False, "executable": False, "errors": ["root must be an object"]}
    plan, rewrite = payload.get("runPlan"), payload.get("queryRewrite")
    if not isinstance(plan, dict) or not isinstance(rewrite, dict):
        return {"valid": False, "executable": False, "errors": ["runPlan and queryRewrite must be objects"]}
    if plan.get("schemaVersion") != 1 or rewrite.get("schemaVersion") != 4:
        errors.append("expected runPlan schemaVersion=1 and queryRewrite schemaVersion=4")
    for field in ("runId", "capabilityId", "question"):
        if not isinstance(plan.get(field), str) or not plan[field].strip():
            errors.append(f"runPlan.{field} must be a non-empty string")
    status = plan.get("status")
    if status not in {"pending", "planned", "needs_clarification", "refused"}:
        errors.append("invalid runPlan.status")
    for field in ("symbols", "dataRequirements", "analysisSteps", "expectedArtifacts", "validationRules"):
        value = plan.get(field)
        if not isinstance(value, list) or any(not isinstance(item, str) or not item.strip() for item in value):
            errors.append(f"runPlan.{field} must be a string array")
    symbols = plan.get("symbols") if isinstance(plan.get("symbols"), list) else []
    resolved = rewrite.get("resolvedSymbols")
    if not isinstance(resolved, list) or any(not isinstance(item, dict) or not isinstance(item.get("symbol"), str) for item in resolved):
        errors.append("queryRewrite.resolvedSymbols must contain symbol objects")
        resolved = []
    if all(isinstance(item, str) for item in symbols):
        if len(set(symbols)) != len(symbols):
            errors.append("duplicate runPlan symbols")
        if set(symbols) != {item["symbol"] for item in resolved}:
            errors.append("runPlan symbols differ from queryRewrite")
    if rewrite.get("status") not in {"ready", "partial", "needs_clarification", "refused"}:
        errors.append("invalid queryRewrite.status")
    if status == "planned":
        if rewrite.get("status") not in {"ready", "partial"}:
            errors.append("planned run requires an executable rewrite")
        if not symbols and rewrite.get("broadUniverse") is not True:
            errors.append("planned run requires resolved symbols or an explicit broad universe")
        llm = (rewrite.get("execution") or {}).get("llm", {}) if isinstance(rewrite.get("execution"), dict) else {}
        if not isinstance(llm, dict) or llm.get("applied") is not True:
            errors.append("planned run requires the platform-applied LLM rewrite")
        clarification = plan.get("clarification")
        if isinstance(clarification, dict) and clarification.get("required") is True:
            errors.append("planned run cannot require clarification")
    questions: list[str] = []
    if status == "needs_clarification":
        clarification = plan.get("clarification")
        if not isinstance(clarification, dict) or clarification.get("required") is not True:
            errors.append("clarification must declare required=true")
        else:
            questions = clarification.get("questions", [])
            if not isinstance(questions, list) or not 1 <= len(questions) <= 3 or any(not isinstance(q, str) or not q.strip() for q in questions):
                errors.append("clarification requires one to three non-empty questions")
                questions = []
    if rewrite.get("status") == "refused" and status != "refused":
        errors.append("a refused rewrite cannot resume execution")
    visualization = plan.get("visualization")
    if not isinstance(visualization, dict) or not isinstance(visualization.get("required"), bool) or not isinstance(visualization.get("panels"), list):
        errors.append("runPlan.visualization requires required and panels")
    return {"valid": not errors, "executable": not errors and status == "planned", "status": status,
            "questions": questions, "errors": errors, "authority": "platform_plan"}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", required=True, help="JSON file containing runPlan/queryRewrite, or - for stdin")
    args = parser.parse_args()
    try:
        raw = sys.stdin.read() if args.input == "-" else Path(args.input).read_text(encoding="utf-8")
        result = validate(json.loads(raw))
    except (OSError, ValueError) as error:
        result = {"valid": False, "executable": False, "errors": [str(error)]}
    print(json.dumps(result, ensure_ascii=False), file=sys.stdout if result["valid"] else sys.stderr)
    return 0 if result["valid"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
