#!/usr/bin/env python3
"""Rank QuantPilot symbol-resolution candidates without guessing through ambiguity."""

from __future__ import annotations

import argparse
import json
import re
import sys
import unicodedata
from pathlib import Path
from typing import Any


CODE_PATTERN = re.compile(r"^\d{5,6}$")
ASSET_ORDER = {"stock": 0, "index": 1, "etf": 2, "fund": 3}
MARKET_ORDER = {"SH": 0, "SZ": 0, "BJ": 0, "HK": 1, "US": 2, "UNKNOWN": 3}


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


def normalized_text(value: str) -> str:
    return re.sub(r"[\s\-_.·]", "", unicodedata.normalize("NFKC", value)).casefold()


def clean_candidate(value: Any, index: int) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ValueError(f"candidate {index} must be an object")
    symbol = value.get("symbol", value.get("code"))
    if not isinstance(symbol, str) or not CODE_PATTERN.fullmatch(symbol.strip()):
        raise ValueError(f"candidate {index}.symbol must be a five- or six-digit string")
    name = value.get("name")
    if name is not None and not isinstance(name, str):
        raise ValueError(f"candidate {index}.name must be a string or null")
    asset_type = value.get("asset_type", "stock")
    if not isinstance(asset_type, str):
        raise ValueError(f"candidate {index}.asset_type must be a string")
    market = value.get("market", "UNKNOWN")
    if not isinstance(market, str):
        raise ValueError(f"candidate {index}.market must be a string")
    secid = value.get("secid")
    if secid is not None and not isinstance(secid, str):
        raise ValueError(f"candidate {index}.secid must be a string or null")
    source = value.get("source")
    if source is not None and not isinstance(source, str):
        raise ValueError(f"candidate {index}.source must be a string or null")
    return {
        "symbol": symbol.strip(),
        "name": name.strip() if isinstance(name, str) and name.strip() else None,
        "asset_type": asset_type.strip().lower() or "unknown",
        "market": market.strip().upper() or "UNKNOWN",
        "secid": secid.strip() if isinstance(secid, str) and secid.strip() else None,
        "source": source.strip() if isinstance(source, str) and source.strip() else None,
    }


def match_rank(query: str, candidate: dict[str, Any]) -> int:
    query_key = normalized_text(query)
    symbol_key = normalized_text(candidate["symbol"])
    name_key = normalized_text(candidate["name"] or "")
    if query_key == symbol_key:
        return 0
    if name_key and query_key == name_key:
        return 0
    if name_key and (name_key.startswith(query_key) or query_key.startswith(name_key)):
        return 1
    if name_key and query_key in name_key:
        return 2
    return 3


def rank_candidates(payload: dict[str, Any]) -> dict[str, Any]:
    query = payload.get("query")
    if not isinstance(query, str) or not query.strip():
        raise ValueError("query must be a non-empty string")
    if not normalized_text(query):
        raise ValueError("query must contain a code, letter, or security-name character")
    raw_candidates = payload.get("candidates", payload.get("results"))
    if not isinstance(raw_candidates, list):
        raise ValueError("candidates (or API response results) must be an array")

    unique: dict[tuple[str, str], dict[str, Any]] = {}
    for index, item in enumerate(raw_candidates):
        candidate = clean_candidate(item, index)
        unique.setdefault((candidate["symbol"], candidate["market"]), candidate)

    def score(candidate: dict[str, Any]) -> tuple[int, int, int, str, str]:
        return (
            match_rank(query, candidate),
            ASSET_ORDER.get(candidate["asset_type"], 4),
            MARKET_ORDER.get(candidate["market"], 3),
            candidate["symbol"],
            candidate["name"] or "",
        )

    ranked = sorted(unique.values(), key=score)
    exposed = [
        {
            **candidate,
            "match_rank": score(candidate)[0],
            "asset_rank": score(candidate)[1],
            "market_rank": score(candidate)[2],
        }
        for candidate in ranked
    ]
    if not exposed:
        return {
            "schemaVersion": 1,
            "query": query.strip(),
            "status": "no_match",
            "selected": None,
            "candidates": [],
            "requires_clarification": True,
        }

    top = exposed[0]
    top_key = (top["match_rank"], top["asset_rank"], top["market_rank"])
    tied = [
        item for item in exposed
        if (item["match_rank"], item["asset_rank"], item["market_rank"]) == top_key
    ]
    ambiguous = len(tied) > 1
    return {
        "schemaVersion": 1,
        "query": query.strip(),
        "status": "ambiguous" if ambiguous else "resolved",
        "selected": None if ambiguous else {key: top[key] for key in ("symbol", "name", "asset_type", "market", "secid", "source")},
        "candidates": exposed,
        "requires_clarification": ambiguous,
        "clarification_candidates": tied if ambiguous else [],
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Rank symbol resolver candidates with deterministic A-share priority.")
    parser.add_argument("--input", required=True, help="JSON object literal, JSON file path, or '-' for stdin.")
    args = parser.parse_args()
    try:
        result = rank_candidates(read_input(args.input))
    except (OSError, json.JSONDecodeError, ValueError) as error:
        print(json.dumps({"ok": False, "error": str(error)}, ensure_ascii=False), file=sys.stderr)
        return 2
    print(json.dumps(result, ensure_ascii=False, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
