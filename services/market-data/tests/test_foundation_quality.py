from __future__ import annotations

from datetime import date

from quantpilot_market_data.models import ClickHouseHealthResponse, IngestionPreflightCoverage
from quantpilot_market_data.repositories.foundation import (
    _clickhouse_foundation_projection,
    _coverage_missing_fields,
)
from quantpilot_market_data.services.ingestion_support import missing_preflight_fields


def test_quality_scan_reports_only_the_incomplete_field() -> None:
    coverage = IngestionPreflightCoverage(
        symbol="600519.SH",
        row_count=10,
        rows_since_cutoff=10,
        expected_rows_since_cutoff=10,
        complete_rows_since_cutoff=0,
        amount_count=10,
        turnover_count=9,
        trade_status_count=10,
        is_st_count=10,
        limit_up_count=10,
        limit_down_count=10,
    )
    passed, missing = _coverage_missing_fields(
        coverage,
        ["amount", "turnover", "trade_status", "is_st", "limit_up", "limit_down"],
    )
    assert not passed
    assert missing == ["turnover"]


def test_quality_scan_checks_requested_factor_fields() -> None:
    coverage = IngestionPreflightCoverage(
        symbol="600519.SH",
        row_count=10,
        rows_since_cutoff=10,
        expected_rows_since_cutoff=10,
        pe_ttm_count=10,
        pb_mrq_count=9,
    )
    passed, missing = _coverage_missing_fields(coverage, ["pe_ttm", "pb_mrq"])
    assert not passed
    assert missing == ["pb_mrq"]


def test_new_listing_complete_fields_only_reports_missing_kline_window() -> None:
    coverage = IngestionPreflightCoverage(
        symbol="001234.SZ",
        row_count=100,
        rows_since_cutoff=100,
        expected_rows_since_cutoff=1211,
        amount_count=100,
        turnover_count=100,
        trade_status_count=100,
        is_st_count=100,
        limit_up_count=100,
        limit_down_count=100,
    )

    passed, missing = _coverage_missing_fields(
        coverage,
        ["amount", "turnover", "trade_status", "is_st", "limit_up", "limit_down"],
    )

    assert not passed
    assert missing == ["kline"]


def test_ingestion_preflight_uses_observed_rows_for_field_completeness() -> None:
    coverage = IngestionPreflightCoverage(
        symbol="001234.SZ",
        row_count=100,
        rows_since_cutoff=100,
        expected_rows_since_cutoff=1211,
        amount_count=100,
        turnover_count=100,
        trade_status_count=100,
        is_st_count=100,
        limit_up_count=100,
        limit_down_count=100,
    )

    missing = missing_preflight_fields(
        coverage,
        require_fields=[
            "amount",
            "turnover",
            "trade_status",
            "is_st",
            "limit_up",
            "limit_down",
        ],
    )

    assert missing == ["kline"]


def test_clickhouse_foundation_is_partial_when_trade_date_is_stale() -> None:
    status, rows, detail = _clickhouse_foundation_projection(
        ClickHouseHealthResponse(
            enabled=True,
            status="ok",
            tables={"quant_bars_daily": 123_456},
            table_latest_trade_dates={"quant_bars_daily": date(2026, 7, 17)},
        ),
        date(2026, 7, 22),
    )

    assert status == "partial"
    assert rows == 123_456
    assert "落后当前应有交易日 2026-07-22" in detail


def test_clickhouse_foundation_is_ready_at_expected_trade_date() -> None:
    status, _, detail = _clickhouse_foundation_projection(
        ClickHouseHealthResponse(
            enabled=True,
            status="ok",
            tables={"quant_bars_daily": 123_456},
            table_latest_trade_dates={"quant_bars_daily": date(2026, 7, 22)},
        ),
        date(2026, 7, 22),
    )

    assert status == "ready"
    assert "最新交易日 2026-07-22" in detail
