from __future__ import annotations

import json

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from quantpilot_market_data import backtest_experiments
from quantpilot_market_data.cache import MarketDataCache
from quantpilot_market_data.contracts.quotes import KlineResponse
from quantpilot_market_data.replay_backtest import replay_backtest
from quantpilot_market_data.routers.backtests import create_backtest_router
from quantpilot_market_data.services import backtests


def test_routes_preserve_replayable_responses_across_cache_and_engine_changes(
    tmp_path, monkeypatch
):
    calls = []
    data = KlineResponse(
        symbol="fixture",
        secid="fixture:1",
        source="fixture",
        period="daily",
        adjustment="none",
        fetched_at="2026-01-01T00:00:00Z",
        bars=[{"date": f"2025-01-{day:02d}", "close": str(20 + day)} for day in range(1, 25)],
    )

    async def no_local(**_kwargs):
        return None

    async def remote_data(*_args, **_kwargs):
        calls.append(True)
        return data

    monkeypatch.setattr(backtests, "get_local_kline_if_ready", no_local)
    monkeypatch.setattr(backtests, "get_kline_local_first", remote_data)
    cache = MarketDataCache(root=tmp_path, enabled=True)
    app = FastAPI()
    app.include_router(
        create_backtest_router(
            client=object(),
            cache=cache,
            kline_cache_ttl_seconds=3600,
        )
    )
    with TestClient(app) as client:
        for endpoint in ["ma-crossover/fixture", "strategies/ma_crossover/fixture"]:
            url = f"/api/v1/backtests/{endpoint}?fast_window=3&slow_window=7&fee_bps=5.123456"
            first = client.get(url)
            assert first.status_code == 200
            assert first.json()["fetch"]["cache_status"] == "miss"
            replay_backtest(first.json())
            second = client.get(url)
            assert second.json()["fetch"]["cache_status"] == "hit"
            assert second.json()["experiment"] == first.json()["experiment"]
            replay_backtest(second.json())
        assert len(calls) == 2

        # Corrupt one replaceable cache entry; the service must produce a fresh receipt.
        cached_path = tmp_path / f"{second.json()['fetch']['cache_key']}.json"
        record = json.loads(cached_path.read_text())
        record["payload"]["summary"]["final_equity"] = "999"
        cached_path.write_text(json.dumps(record))
        repaired = client.get(url)
        assert repaired.json()["fetch"]["cache_status"] == "miss"
        replay_backtest(repaired.json())
        assert len(calls) == 3

        monkeypatch.setattr(backtest_experiments, "_CODE_SHA256", "sha256:" + "0" * 64)
        changed = client.get(url)
        assert changed.json()["fetch"]["cache_status"] == "miss"
        assert len(calls) == 4
        with pytest.raises(ValueError, match="engine or runtime changed"):
            replay_backtest(second.json())
