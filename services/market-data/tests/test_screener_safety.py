from __future__ import annotations

from datetime import date

from quantpilot_market_data.models import AShareScreenerResponse
from quantpilot_market_data.repositories.screener import (
    _is_known_tradable,
    _screener_coverage,
)


def test_screener_requires_explicit_safe_tri_state() -> None:
    safe = {
        "latest_trade_status": "1",
        "latest_is_st": False,
        "latest_limit_up": False,
        "latest_limit_down": False,
    }
    assert _is_known_tradable(safe)
    for field in (
        "latest_trade_status",
        "latest_is_st",
        "latest_limit_up",
        "latest_limit_down",
    ):
        candidate = dict(safe)
        candidate[field] = None
        assert not _is_known_tradable(candidate)


def test_screener_rejects_explicit_risk_flags() -> None:
    base = {
        "latest_trade_status": "normal",
        "latest_is_st": False,
        "latest_limit_up": False,
        "latest_limit_down": False,
    }
    for field in ("latest_is_st", "latest_limit_up", "latest_limit_down"):
        candidate = dict(base)
        candidate[field] = True
        assert not _is_known_tradable(candidate)
    assert not _is_known_tradable({**base, "latest_trade_status": "0"})


def test_screener_reports_full_pool_coverage_and_exclusions() -> None:
    target_date = date(2026, 6, 15)
    safe = {
        "symbol": "600519.SH",
        "code": "600519",
        "name": "贵州茅台",
        "exchange": "SH",
        "latest_trade_date": target_date,
        "sample_count": 60,
        "latest_close": 1500,
        "latest_trade_status": "1",
        "latest_is_st": False,
        "latest_limit_up": False,
        "latest_limit_down": False,
    }
    missing_safety = {
        **safe,
        "symbol": "000001.SZ",
        "code": "000001",
        "latest_trade_status": None,
        "latest_is_st": None,
        "latest_limit_up": None,
        "latest_limit_down": None,
    }
    explicit_risk = {
        **safe,
        "symbol": "600000.SH",
        "code": "600000",
        "latest_is_st": True,
    }

    eligible, reasons, complete, coverage_pct, warning = _screener_coverage(
        [safe, missing_safety, explicit_risk],
        total_symbols=3,
        target_trade_date=target_date,
    )

    assert [row["symbol"] for row in eligible] == ["600519.SH"]
    assert complete == 2
    assert coverage_pct == 66.67
    assert reasons["missing_trade_status"] == 1
    assert reasons["missing_is_st"] == 1
    assert reasons["missing_limit_up"] == 1
    assert reasons["missing_limit_down"] == 1
    assert reasons["is_st"] == 1
    assert warning is not None
    assert "2/3" in warning


def test_screener_response_scanned_symbols_is_total_pool() -> None:
    response = AShareScreenerResponse(
        universe_id="test",
        scanned_symbols=5,
        total_symbols=298,
        eligible_symbols=5,
        excluded_reasons={"missing_is_st": 293},
        safety_complete_symbols=5,
        safety_coverage_pct=1.68,
        coverage_warning="覆盖不足",
    )

    assert response.scanned_symbols == 298
    assert response.total_symbols == 298
    assert response.eligible_symbols == 5
    assert response.excluded_symbols == 293
    assert response.data_quality.status == "warning"
