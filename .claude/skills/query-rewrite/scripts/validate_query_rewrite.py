#!/usr/bin/env python3
"""Validate a QuantPilot query rewrite artifact without network or file writes."""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any


SYMBOL_PATTERN = re.compile(r"^(?:6|0|3|5)\d{5}$")
VALID_STATUSES = {"ready", "partial", "needs_clarification", "refused"}
VALID_OUTPUT_INTENTS = {"dashboard", "answer"}
VALID_STRATEGIES = {"llm_primary", "llm_unavailable", "safety_refusal"}
VALID_LLM_STATUSES = {
    "not_applicable",
    "applied",
    "skipped_unconfigured",
    "invalid_output",
    "timed_out",
    "failed",
}


def parse_input(value: str) -> Any:
    if value == "-":
        source = sys.stdin.read()
    else:
        candidate = Path(value)
        source = candidate.read_text(encoding="utf-8") if candidate.is_file() else value
    return json.loads(source)


def validate(payload: Any) -> dict[str, Any]:
    errors: list[str] = []
    warnings: list[str] = []
    if not isinstance(payload, dict):
        return {"valid": False, "errors": ["root must be an object"], "warnings": []}

    if payload.get("schemaVersion") != 4:
        errors.append("schemaVersion must equal 4")
    for field in ("originalQuery", "normalizedQuery", "rewrittenQuery", "capabilityHint"):
        if not isinstance(payload.get(field), str) or not payload[field].strip():
            errors.append(f"{field} must be a non-empty string")

    status = payload.get("status")
    if status not in VALID_STATUSES:
        errors.append("status must be ready, partial, needs_clarification, or refused")
    confidence = payload.get("confidence")
    if not isinstance(confidence, (int, float)) or isinstance(confidence, bool) or not 0 <= confidence <= 1:
        errors.append("confidence must be a number between 0 and 1")
    if payload.get("outputIntent") not in VALID_OUTPUT_INTENTS:
        errors.append("outputIntent must be dashboard or answer")

    safety = payload.get("safety")
    safety_decision = None
    if not isinstance(safety, dict):
        errors.append("safety must be an object")
    else:
        safety_decision = safety.get("decision")
        if safety_decision not in {"allow", "refuse"}:
            errors.append("safety.decision must be allow or refuse")
        if safety_decision == "allow" and (safety.get("code") is not None or safety.get("message") is not None):
            errors.append("allowed safety decision requires null code and message")
        if safety_decision == "refuse":
            if not isinstance(safety.get("code"), str) or not safety["code"].strip():
                errors.append("refused safety decision requires a code")
            if not isinstance(safety.get("message"), str) or not safety["message"].strip():
                errors.append("refused safety decision requires a message")

    execution = payload.get("execution")
    strategy = None
    llm_status = None
    if not isinstance(execution, dict):
        errors.append("execution must be an object")
    else:
        strategy = execution.get("strategy")
        if strategy not in VALID_STRATEGIES:
            errors.append("execution.strategy is invalid")
        llm = execution.get("llm")
        if not isinstance(llm, dict):
            errors.append("execution.llm must be an object")
        else:
            llm_status = llm.get("status")
            attempted = llm.get("attempted")
            applied = llm.get("applied")
            if not isinstance(attempted, bool) or not isinstance(applied, bool):
                errors.append("execution.llm attempted/applied must be booleans")
            if llm_status not in VALID_LLM_STATUSES:
                errors.append("execution.llm.status is invalid")
            if applied and not attempted:
                errors.append("execution.llm.applied=true requires attempted=true")
            if applied and llm_status != "applied":
                errors.append("applied LLM result requires status=applied")
            if llm_status == "applied" and not applied:
                errors.append("status=applied requires execution.llm.applied=true")
            if applied:
                if not isinstance(llm.get("provider"), str) or not llm["provider"].strip():
                    errors.append("applied LLM result requires provider")
                if not isinstance(llm.get("model"), str) or not llm["model"].strip():
                    errors.append("applied LLM result requires model")
                semantic_confidence = llm.get("semanticConfidence")
                if (
                    not isinstance(semantic_confidence, (int, float))
                    or isinstance(semantic_confidence, bool)
                    or not 0 <= semantic_confidence <= 1
                ):
                    errors.append("applied LLM result requires semanticConfidence between 0 and 1")

        if strategy == "llm_primary" and not (
            isinstance(llm, dict)
            and llm.get("attempted") is True
            and llm.get("applied") is True
            and llm.get("status") == "applied"
        ):
            errors.append("llm_primary requires an attempted, applied LLM result")
        if strategy == "llm_unavailable" and not (
            isinstance(llm, dict)
            and llm.get("attempted") is True
            and llm.get("applied") is False
            and llm.get("status") in {
                "skipped_unconfigured", "invalid_output", "timed_out", "failed"
            }
        ):
            errors.append("llm_unavailable requires an attempted, unapplied failed LLM result")
        if strategy == "safety_refusal" and not (
            isinstance(llm, dict)
            and llm.get("attempted") is False
            and llm.get("applied") is False
            and llm.get("status") == "not_applicable"
        ):
            errors.append("safety_refusal requires a non-attempted not_applicable LLM result")

    list_fields = (
        "targetCandidates",
        "resolvedSymbols",
        "unresolvedTargets",
        "ambiguousTargets",
        "issues",
    )
    for field in list_fields:
        if not isinstance(payload.get(field), list):
            errors.append(f"{field} must be an array")

    resolved = payload.get("resolvedSymbols") if isinstance(payload.get("resolvedSymbols"), list) else []
    symbols: list[str] = []
    for index, item in enumerate(resolved):
        if not isinstance(item, dict):
            errors.append(f"resolvedSymbols[{index}] must be an object")
            continue
        symbol = item.get("symbol")
        if not isinstance(symbol, str) or not SYMBOL_PATTERN.fullmatch(symbol):
            errors.append(f"resolvedSymbols[{index}].symbol must be a supported six-digit code")
        else:
            symbols.append(symbol)
        if not isinstance(item.get("query"), str) or not item["query"].strip():
            errors.append(f"resolvedSymbols[{index}].query must be a non-empty string")
        if not isinstance(item.get("name"), str) or not item["name"].strip():
            errors.append(f"resolvedSymbols[{index}].name must be a non-empty string")

    if len(symbols) != len(set(symbols)):
        errors.append("resolvedSymbols must not contain duplicate symbols")

    unresolved = payload.get("unresolvedTargets") if isinstance(payload.get("unresolvedTargets"), list) else []
    ambiguous = payload.get("ambiguousTargets") if isinstance(payload.get("ambiguousTargets"), list) else []
    broad_universe = payload.get("broadUniverse") is True
    if status == "ready" and (unresolved or ambiguous):
        errors.append("ready status cannot contain unresolved or ambiguous targets")
    if status == "ready" and not resolved and not broad_universe:
        errors.append("ready status requires resolvedSymbols or broadUniverse=true")
    if status == "partial" and (not resolved or not unresolved):
        errors.append("partial status requires both resolvedSymbols and unresolvedTargets")
    if status == "needs_clarification" and resolved and not unresolved and not ambiguous:
        warnings.append("needs_clarification contains resolved symbols but no unresolved or ambiguous target")
    if status == "refused":
        if safety_decision != "refuse":
            errors.append("refused status requires safety.decision=refuse")
        if resolved or unresolved or ambiguous:
            errors.append("refused status cannot contain resolution results")
        if strategy != "safety_refusal":
            errors.append("refused status requires safety_refusal strategy")
    elif safety_decision == "refuse":
        errors.append("safety.decision=refuse requires refused status")

    return {
        "valid": not errors,
        "errors": errors,
        "warnings": warnings,
        "summary": {
            "status": status,
            "resolvedSymbolCount": len(resolved),
            "unresolvedTargetCount": len(unresolved),
            "ambiguousTargetCount": len(ambiguous),
            "strategy": strategy,
            "llmStatus": llm_status,
            "safetyDecision": safety_decision,
        },
    }


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Validate a QuantPilot query_rewrite.json contract.",
    )
    parser.add_argument(
        "--input",
        required=True,
        help="JSON object, JSON file path, or - for stdin.",
    )
    args = parser.parse_args()
    try:
        payload = parse_input(args.input)
        result = validate(payload)
    except (OSError, json.JSONDecodeError) as error:
        result = {"valid": False, "errors": [str(error)], "warnings": []}

    stream = sys.stdout if result.get("valid") else sys.stderr
    print(json.dumps(result, ensure_ascii=False, separators=(",", ":")), file=stream)
    return 0 if result.get("valid") else 1


if __name__ == "__main__":
    raise SystemExit(main())
