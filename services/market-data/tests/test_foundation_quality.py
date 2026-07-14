from __future__ import annotations

from quantpilot_market_data.models import IngestionPreflightCoverage
from quantpilot_market_data.repositories.foundation import _coverage_missing_fields
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
