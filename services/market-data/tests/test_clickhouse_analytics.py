from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

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
