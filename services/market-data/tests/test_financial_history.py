from __future__ import annotations

import asyncio
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from quantpilot_market_data import database_core
from quantpilot_market_data.cache import MarketDataCache
from quantpilot_market_data.contracts.fundamentals import (
    FinancialKnowledgeSnapshot,
    FinancialReportItem,
    FinancialReportsResponse,
)
from quantpilot_market_data.database_core import DatabaseError
from quantpilot_market_data.providers.eastmoney import parse_financial_reports_payload
from quantpilot_market_data.routers.fundamentals import create_fundamentals_router
from quantpilot_market_data.services import fundamentals


class Provider:
    id = "eastmoney"

    def __init__(self) -> None:
        self.calls = 0

    async def get_financial_reports(self, symbol: str, *, limit: int) -> list[FinancialReportItem]:
        self.calls += 1
        return [FinancialReportItem(symbol=symbol, revenue=999)]


def test_historical_reads_bypass_latest_cache_and_provider(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    async def scenario() -> None:
        provider = Provider()
        cache = MarketDataCache(root=tmp_path, enabled=True)
        await fundamentals.get_financial_reports(
            provider,
            cache,
            symbol="600519",
            limit=8,
            ttl_seconds=3600,
        )
        cutoff = datetime(2020, 1, 1, tzinfo=UTC)
        calls = []

        async def archived(**kwargs) -> FinancialReportsResponse:
            calls.append(kwargs)
            return FinancialReportsResponse(
                symbol="600519",
                reports=[],
                fetched_at=datetime.now(UTC),
                as_of=cutoff,
                knowledge=FinancialKnowledgeSnapshot(point_in_time=True, cutoff=cutoff),
            )

        monkeypatch.setattr(fundamentals, "read_financial_snapshot", archived)
        historical = await fundamentals.get_financial_reports(
            provider,
            cache,
            symbol="600519.SH",
            limit=8,
            ttl_seconds=3600,
            as_of=cutoff,
        )
        indicators = await fundamentals.get_fundamental_indicators(
            provider,
            cache,
            symbol="600519",
            limit=8,
            ttl_seconds=3600,
            as_of=cutoff,
        )
        assert provider.calls == 1
        assert historical.reports == []
        assert indicators.points == []
        assert indicators.knowledge.point_in_time is True
        assert indicators.as_of == cutoff
        assert historical.data_quality.status == "warning"
        assert calls[0] == dict(symbol="600519", provider="eastmoney", cutoff=cutoff, limit=8)

        async def unavailable(**kwargs):
            raise DatabaseError("archive unavailable")

        monkeypatch.setattr(fundamentals, "read_financial_snapshot", unavailable)
        with pytest.raises(DatabaseError, match="archive unavailable"):
            await fundamentals.get_financial_reports(
                provider,
                cache,
                symbol="600519",
                limit=8,
                ttl_seconds=3600,
                as_of=cutoff,
            )
        assert provider.calls == 1

    asyncio.run(scenario())


def test_history_routes_reject_ambiguous_or_future_cutoffs_and_require_capture_auth(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    monkeypatch.setenv("QUANTPILOT_MARKET_ADMIN_TOKEN", "pit-contract-admin-token")
    provider = Provider()
    app = FastAPI()
    app.include_router(
        create_fundamentals_router(
            client=provider,
            cache=MarketDataCache(root=tmp_path),
            financial_cache_ttl_seconds=3600,
        )
    )
    client = TestClient(app)
    for cutoff in ["2020-01-01T00:00:00", (datetime.now(UTC) + timedelta(days=1)).isoformat()]:
        response = client.get("/api/v1/fundamentals/financials/600519", params={"as_of": cutoff})
        assert response.status_code == 400
    assert client.post("/api/v1/fundamentals/financials/600519/capture").status_code == 401
    assert provider.calls == 0


def test_capture_rejects_cross_symbol_payload(monkeypatch: pytest.MonkeyPatch) -> None:
    provider = Provider()

    async def wrong_symbol(*args, **kwargs):
        return [FinancialReportItem(symbol="000001")]

    monkeypatch.setattr(provider, "get_financial_reports", wrong_symbol)
    with pytest.raises(ValueError, match="不同标的"):
        asyncio.run(fundamentals.capture_financial_reports(provider, symbol="600519", limit=8))


def test_financial_notice_times_use_shanghai_and_preserve_explicit_offsets() -> None:
    def notice(value):
        return parse_financial_reports_payload(
            "600519",
            {
                "result": {"data": [{"NOTICE_DATE": value}]},
            },
        )[0].notice_date

    assert notice("2026-04-01 08:30:00") == datetime(2026, 4, 1, 0, 30, tzinfo=UTC)
    assert notice("2026-04-01T08:30:00+08:00") == datetime(2026, 4, 1, 0, 30, tzinfo=UTC)
    assert notice("2026-04-01T08:30:00Z") == datetime(2026, 4, 1, 8, 30, tzinfo=UTC)
    assert notice("unknown") is None


def test_database_only_env_loader_preserves_precedence_and_never_loads_other_secrets(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    monkeypatch.setattr(database_core, "ROOT_DIR", tmp_path)
    monkeypatch.delenv("DATABASE_URL", raising=False)
    monkeypatch.delenv("PIT_FIXTURE_SECRET", raising=False)
    (tmp_path / ".env").write_text("DATABASE_URL=postgresql://defaults/test\n")
    (tmp_path / ".env.local").write_text(
        "DATABASE_URL=postgresql://local/test\nPIT_FIXTURE_SECRET=must-not-load\n",
    )
    assert database_core.database_url_from_env() == "postgresql://local/test"
    assert "PIT_FIXTURE_SECRET" not in database_core.os.environ
    monkeypatch.setenv("DATABASE_URL", "postgresql://injected/test")
    assert database_core.database_url_from_env() == "postgresql://injected/test"
    monkeypatch.setenv("DATABASE_URL", "")
    with pytest.raises(DatabaseError, match="未配置"):
        database_core.database_url_from_env()
