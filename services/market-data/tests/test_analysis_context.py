from __future__ import annotations

from datetime import UTC, datetime, timedelta
from decimal import Decimal

import pytest
from fastapi.testclient import TestClient

from quantpilot_market_data.api import create_app
from quantpilot_market_data.models import (
    AnnouncementItem,
    AnnouncementResponse,
    FinancialReportItem,
    FinancialReportsResponse,
    KlineBar,
    KlineResponse,
    RealtimeQuote,
)


def _quote() -> RealtimeQuote:
    now = datetime.now(UTC)
    return RealtimeQuote(
        symbol="600111",
        secid="1.600111",
        name="北方稀土",
        market="SH",
        price=Decimal("42.15"),
        quote_time=now,
        fetched_at=now,
    )


def _history() -> KlineResponse:
    now = datetime.now(UTC)
    start = now.date() - timedelta(days=29)
    return KlineResponse(
        symbol="600111",
        secid="1.600111",
        name="北方稀土",
        market="SH",
        period="daily",
        adjustment="qfq",
        bars=[
            KlineBar(
                date=(start + timedelta(days=index)).isoformat(),
                open=Decimal(30 + index),
                high=Decimal(31 + index),
                low=Decimal(29 + index),
                close=Decimal("30.5") + index,
                volume=100_000 + index,
            )
            for index in range(30)
        ],
        fetched_at=now,
    )


def _financials() -> FinancialReportsResponse:
    now = datetime.now(UTC)
    return FinancialReportsResponse(
        symbol="600111",
        reports=[
            FinancialReportItem(
                symbol="600111",
                name="北方稀土",
                report_date=now - timedelta(days=90 * index),
                revenue=Decimal(1000 - index * 50),
                parent_net_profit=Decimal(100 - index * 5),
                weighted_roe=Decimal("12.5"),
                gross_margin=Decimal("22.0"),
            )
            for index in range(4)
        ],
        fetched_at=now,
    )


def _announcements() -> AnnouncementResponse:
    now = datetime.now(UTC)
    return AnnouncementResponse(
        symbol="600111",
        announcements=[
            AnnouncementItem(
                art_code="AN-600111-1",
                title="北方稀土公告",
                symbol="600111",
                name="北方稀土",
                notice_date=now,
            )
        ],
        fetched_at=now,
    )


def test_analysis_context_shares_dependencies_and_returns_ready_contract(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls = {"quote": 0, "history": 0, "financials": 0, "announcements": 0}

    async def fake_quote(*args, **kwargs):  # noqa: ANN002, ANN003, ANN202
        calls["quote"] += 1
        return _quote()

    async def fake_history(*args, **kwargs):  # noqa: ANN002, ANN003, ANN202
        calls["history"] += 1
        return _history()

    async def fake_financials(*args, **kwargs):  # noqa: ANN002, ANN003, ANN202
        calls["financials"] += 1
        return _financials()

    async def fake_announcements(*args, **kwargs):  # noqa: ANN002, ANN003, ANN202
        calls["announcements"] += 1
        return _announcements()

    monkeypatch.setattr("quantpilot_market_data.services.context.get_realtime_quote", fake_quote)
    monkeypatch.setattr("quantpilot_market_data.services.context.get_history_quote", fake_history)
    monkeypatch.setattr(
        "quantpilot_market_data.services.context.get_financial_reports",
        fake_financials,
    )
    monkeypatch.setattr(
        "quantpilot_market_data.services.context.get_announcements",
        fake_announcements,
    )

    with TestClient(create_app()) as client:
        response = client.get("/api/v1/analysis/context/600111")

    assert response.status_code == 200
    payload = response.json()
    assert payload["schema_version"] == 1
    assert payload["status"] == "ready"
    assert payload["data_quality"]["status"] == "ok"
    assert payload["sections"]["technical"]["data"]["summary"]["latest_close"] == "59.5"
    assert payload["sections"]["fundamental"]["data"]["summary"]["report_count"] == 4
    assert calls == {"quote": 1, "history": 1, "financials": 1, "announcements": 1}


def test_analysis_context_isolates_dependency_failure(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def fake_quote(*args, **kwargs):  # noqa: ANN002, ANN003, ANN202
        return _quote()

    async def failing_history(*args, **kwargs):  # noqa: ANN002, ANN003, ANN202
        raise RuntimeError("history provider timeout")

    monkeypatch.setattr("quantpilot_market_data.services.context.get_realtime_quote", fake_quote)
    monkeypatch.setattr(
        "quantpilot_market_data.services.context.get_history_quote",
        failing_history,
    )

    with TestClient(create_app()) as client:
        response = client.get(
            "/api/v1/analysis/context/600111?include=quote,history,technical"
        )

    assert response.status_code == 200
    payload = response.json()
    assert payload["status"] == "partial"
    assert payload["sections"]["quote"]["status"] == "ok"
    assert payload["sections"]["history"]["error"] == {
        "code": "UPSTREAM_UNAVAILABLE",
        "message": "history provider timeout",
        "retryable": True,
    }
    assert payload["sections"]["technical"]["error"]["code"] == "DEPENDENCY_UNAVAILABLE"
    assert payload["data_quality"]["missing_fields"] == ["history", "technical"]


def test_analysis_context_rejects_unknown_sections() -> None:
    with TestClient(create_app()) as client:
        response = client.get("/api/v1/analysis/context/600111?include=quote,magic")

    assert response.status_code == 400
    assert "未知 include 数据区块" in response.json()["detail"]


def test_registry_advertises_analysis_context_contract() -> None:
    with TestClient(create_app()) as client:
        response = client.get("/api/v1/registry")

    assert response.status_code == 200
    providers = {provider["id"]: provider for provider in response.json()["providers"]}
    assert providers["quantpilot-analysis-context"]["status"] == "available"
    assert providers["quantpilot-analysis-context"]["endpoints"] == [
        "/api/v1/analysis/context/{symbol}"
    ]
