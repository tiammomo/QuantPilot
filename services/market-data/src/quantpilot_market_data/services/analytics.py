from __future__ import annotations

from quantpilot_market_data.clickhouse import get_clickhouse_health, initialize_clickhouse
from quantpilot_market_data.contracts.analytics import ClickHouseSyncRequest, ClickHouseSyncResponse
from quantpilot_market_data.contracts.foundation import ClickHouseHealthResponse
from quantpilot_market_data.repositories.analytics import sync_clickhouse_daily_bars


async def get_clickhouse_analytics_health() -> ClickHouseHealthResponse:
    return await get_clickhouse_health()


async def initialize_clickhouse_analytics() -> ClickHouseHealthResponse:
    await initialize_clickhouse()
    return await get_clickhouse_health()


async def sync_clickhouse_analytics(
    request: ClickHouseSyncRequest,
) -> ClickHouseSyncResponse:
    return await sync_clickhouse_daily_bars(
        universe_id=request.universe_id.strip(),
        start=request.start,
        end=request.end,
        timeframe=str(request.timeframe),
        adjustment=str(request.adjustment),
        limit=request.limit,
    )
