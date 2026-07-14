from __future__ import annotations

import re
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[3]
REPOSITORIES_ROOT = (
    PROJECT_ROOT / "services" / "market-data" / "src" / "quantpilot_market_data" / "repositories"
)


def test_repository_reads_use_canonical_stock_bars_view() -> None:
    forbidden = re.compile(r"\b(?:FROM|JOIN)\s+quant\.stock_bars\b", re.IGNORECASE)
    violations: list[str] = []
    for path in sorted(REPOSITORIES_ROOT.glob("*.py")):
        if forbidden.search(path.read_text(encoding="utf-8")):
            violations.append(path.name)
    assert violations == []


def test_snapshot_repair_is_audited_and_repeatable() -> None:
    migration = (
        PROJECT_ROOT / "sqls" / "009-canonical-stock-bars-repair.sql"
    ).read_text(encoding="utf-8")
    assert "quant.legacy_realtime_stock_bars" in migration
    assert "ON CONFLICT (symbol, timeframe, adjustment, ts) DO UPDATE" in migration
    assert "quant.realtime_quote_snapshots" in migration
    assert "CREATE OR REPLACE VIEW quant.canonical_stock_bars" in migration
    assert "FROM quant.canonical_stock_bars bars" in migration
