from __future__ import annotations

import asyncio
from typing import Any

import pytest

from quantpilot_market_data.repositories import ingestion as ingestion_repository
from quantpilot_market_data.services.ingestion_support import missing_preflight_fields


class FakeCursor:
    def __init__(self, rows: list[dict[str, Any]]) -> None:
        self.rows = rows
        self.query = ""
        self.params: tuple[Any, ...] = ()

    async def __aenter__(self) -> FakeCursor:
        return self

    async def __aexit__(self, *args: object) -> None:
        return None

    async def execute(self, query: str, params: tuple[Any, ...]) -> None:
        self.query = query
        self.params = params

    async def fetchall(self) -> list[dict[str, Any]]:
        return self.rows


class FakeConnection:
    def __init__(self, cursor: FakeCursor) -> None:
        self.fake_cursor = cursor

    async def __aenter__(self) -> FakeConnection:
        return self

    async def __aexit__(self, *args: object) -> None:
        return None

    def cursor(self, **kwargs: object) -> FakeCursor:
        return self.fake_cursor


def coverage_row(
    symbol: str,
    *,
    amount_count: int,
    turnover_count: int,
    complete_rows: int,
) -> dict[str, Any]:
    return {
        "symbol": symbol,
        "first_ts": None,
        "last_ts": None,
        "benchmark_last_ts": None,
        "row_count": 1,
        "rows_since_cutoff": 1,
        "expected_rows_since_cutoff": 1,
        "complete_rows_since_cutoff": complete_rows,
        "amount_count": amount_count,
        "turnover_count": turnover_count,
        "trade_status_count": 1,
        "is_st_count": 1,
        "limit_up_count": 1,
        "limit_down_count": 1,
        "pe_ttm_count": 0,
        "pb_mrq_count": 0,
        "ps_ttm_count": 0,
        "pcf_ncf_ttm_count": 0,
    }


def run_preflight(
    monkeypatch: pytest.MonkeyPatch,
    row: dict[str, Any],
) -> tuple[Any, FakeCursor]:
    cursor = FakeCursor([row])

    async def fake_connect() -> FakeConnection:
        return FakeConnection(cursor)

    monkeypatch.setattr(ingestion_repository, "connect", fake_connect)
    result = asyncio.run(
        ingestion_repository.get_history_ingestion_preflight(
            targets=[{"symbol": str(row["symbol"])}],
            timeframe="daily",
            adjustment="qfq",
            lookback_years=5,
            require_fields=["amount", "turnover"],
        )
    )
    return result[str(row["symbol"])], cursor


def test_suspended_bar_null_amount_and_turnover_are_complete(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    coverage, cursor = run_preflight(
        monkeypatch,
        coverage_row(
            "600000.SH",
            amount_count=1,
            turnover_count=1,
            complete_rows=1,
        ),
    )

    assert "BTRIM(COALESCE(bars.trade_status, '')) = '0' AS is_suspended" in cursor.query
    assert cursor.query.count("OR bars.is_suspended") == 4
    assert coverage.complete_rows_since_cutoff == 1
    assert missing_preflight_fields(
        coverage,
        require_fields=["amount", "turnover"],
    ) == []


def test_active_bar_null_amount_and_turnover_remain_incomplete(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    coverage, cursor = run_preflight(
        monkeypatch,
        coverage_row(
            "600001.SH",
            amount_count=0,
            turnover_count=0,
            complete_rows=0,
        ),
    )

    assert "bars.amount IS NOT NULL OR bars.is_suspended" in cursor.query
    assert "bars.turnover IS NOT NULL OR bars.is_suspended" in cursor.query
    assert coverage.complete_rows_since_cutoff == 0
    assert missing_preflight_fields(
        coverage,
        require_fields=["amount", "turnover"],
    ) == ["amount", "turnover"]
