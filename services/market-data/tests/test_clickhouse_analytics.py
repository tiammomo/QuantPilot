from __future__ import annotations

from datetime import date

import pytest
from fastapi.testclient import TestClient

from quantpilot_market_data import clickhouse
from quantpilot_market_data.api import create_app
from quantpilot_market_data.clickhouse import get_clickhouse_health, is_clickhouse_enabled


@pytest.mark.anyio
async def test_clickhouse_health_is_disabled_by_default(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("QUANTPILOT_CLICKHOUSE_ENABLED", raising=False)

    health = await get_clickhouse_health()

    assert is_clickhouse_enabled() is False
    assert health.enabled is False
    assert health.status == "disabled"
    assert health.database == "quantpilot"


def test_clickhouse_health_endpoint_when_disabled(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("QUANTPILOT_CLICKHOUSE_ENABLED", "0")
    client = TestClient(create_app())

    response = client.get("/api/v1/analytics/clickhouse/health")

    assert response.status_code == 200
    payload = response.json()
    assert payload["enabled"] is False
    assert payload["status"] == "disabled"


def test_registry_exposes_clickhouse_analytics_provider() -> None:
    client = TestClient(create_app())

    response = client.get("/api/v1/registry")

    assert response.status_code == 200
    provider_ids = {provider["id"] for provider in response.json()["providers"]}
    assert "quantpilot-clickhouse-analytics" in provider_ids


def test_screener_feature_query_keeps_unsafe_rows_for_coverage(monkeypatch) -> None:
    captured_query = ""

    def fake_query(query: str, parameters):
        nonlocal captured_query
        captured_query = query
        return [
            {
                "symbol": "600519.SH",
                "security_metadata": "{}",
                "latest_limit_up_date": None,
            }
        ]

    monkeypatch.setattr(clickhouse, "_query_rows", fake_query)
    rows = clickhouse._query_screener_feature_rows_sync(
        universe_id="test",
        trade_date=date(2026, 6, 15),
        timeframe="daily",
        adjustment="qfq",
    )

    assert rows[0]["symbol"] == "600519.SH"
    assert "isNotNull(bars[1].16)" not in captured_query
    assert "exchange != 'BJ'" not in captured_query
    assert "length(bars) >= 20" not in captured_query
