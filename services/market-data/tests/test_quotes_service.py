from __future__ import annotations

import asyncio
from datetime import UTC, datetime

from quantpilot_market_data.cache import MarketDataCache
from quantpilot_market_data.models import KlineResponse
from quantpilot_market_data.services import quotes


class DummyProvider:
    id = "dummy"


def test_history_refresh_bypasses_file_cache(monkeypatch) -> None:
    response = KlineResponse(
        symbol="600519",
        secid="1.600519",
        market="SH",
        source="provider-refresh",
        period="daily",
        adjustment="qfq",
        bars=[],
        fetched_at=datetime(2026, 7, 14, tzinfo=UTC),
    )
    calls = 0

    def fail_if_cache_is_read(*args, **kwargs):
        raise AssertionError("refresh=true must not read the file cache")

    async def fake_gateway(*args, **kwargs):
        nonlocal calls
        calls += 1
        assert kwargs["bypass_local"] is True
        return response

    monkeypatch.setattr(quotes, "read_cached_response", fail_if_cache_is_read)
    monkeypatch.setattr(quotes, "get_kline_local_first", fake_gateway)

    result = asyncio.run(
        quotes.get_history_quote(
            DummyProvider(),
            MarketDataCache(enabled=False),
            None,  # type: ignore[arg-type]
            symbol="600519",
            period="daily",
            adjustment="qfq",
            limit=30,
            end="20500101",
            refresh=True,
            ttl_seconds=300,
        )
    )

    assert calls == 1
    assert result.source == "provider-refresh"
