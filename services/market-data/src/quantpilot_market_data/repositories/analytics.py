from __future__ import annotations

from datetime import date
from typing import Any

from psycopg.rows import dict_row

from quantpilot_market_data.clickhouse import (
    ClickHouseError,
    initialize_clickhouse,
    insert_daily_bars,
    is_clickhouse_enabled,
)
from quantpilot_market_data.database_core import connect
from quantpilot_market_data.models import ClickHouseSyncResponse

DEFAULT_UNIVERSE_ID = "a-share-sample-research-pool"

__all__ = ["sync_clickhouse_daily_bars"]


async def sync_clickhouse_daily_bars(
    *,
    universe_id: str = DEFAULT_UNIVERSE_ID,
    start: date | None = None,
    end: date | None = None,
    timeframe: str = "daily",
    adjustment: str = "qfq",
    limit: int | None = 300_000,
) -> ClickHouseSyncResponse:
    if not is_clickhouse_enabled():
        return ClickHouseSyncResponse(
            enabled=False,
            status="disabled",
            universe_id=universe_id,
            timeframe=timeframe,
            adjustment=adjustment,
            start=start,
            end=end,
            message="ClickHouse 分析层未启用，设置 QUANTPILOT_CLICKHOUSE_ENABLED=1 后可同步。",
        )

    safe_limit = None if limit is None else max(1, min(limit, 2_000_000))
    limit_clause = "" if safe_limit is None else "LIMIT %s"
    params: list[Any] = [
        universe_id,
        universe_id,
        timeframe,
        adjustment,
        start,
        start,
        end,
        end,
    ]
    if safe_limit is not None:
        params.append(safe_limit)

    async with await connect() as connection, connection.cursor(row_factory=dict_row) as cursor:
        await cursor.execute(
            f"""
            SELECT
              %s::text AS universe_id,
              bars.symbol,
              COALESCE(securities.code, split_part(bars.symbol, '.', 1)) AS code,
              securities.name,
              COALESCE(securities.exchange, 'UNKNOWN') AS exchange,
              COALESCE(securities.asset_type, 'stock') AS asset_type,
              (bars.ts AT TIME ZONE 'Asia/Shanghai')::date AS trade_date,
              bars.timeframe,
              bars.adjustment,
              bars.open,
              bars.high,
              bars.low,
              bars.close,
              bars.previous_close,
              bars.volume,
              bars.amount,
              bars.amplitude,
              bars.change_percent,
              bars.change_amount,
              bars.turnover,
              bars.trade_status,
              bars.is_st,
              bars.limit_up,
              bars.limit_down,
              COALESCE(securities.metadata, '{{}}'::jsonb) AS security_metadata,
              bars.provider
            FROM quant.stock_bars bars
            JOIN quant.security_universe_members members
              ON members.symbol = bars.symbol
              AND members.universe_id = %s
            LEFT JOIN quant.securities securities
              ON securities.symbol = bars.symbol
            WHERE bars.timeframe = %s
              AND bars.adjustment = %s
              AND COALESCE(members.role, 'member') <> 'inactive'
              AND COALESCE(securities.status, 'active') NOT IN ('inactive', 'delisted')
              AND (
                %s::date IS NULL
                OR bars.ts >= (%s::date::timestamp AT TIME ZONE 'Asia/Shanghai')
              )
              AND (
                %s::date IS NULL
                OR bars.ts < (((%s::date + 1)::timestamp) AT TIME ZONE 'Asia/Shanghai')
              )
            ORDER BY bars.ts DESC, bars.symbol ASC
            {limit_clause}
            """,
            params,
        )
        rows = [dict(row) for row in await cursor.fetchall()]

    try:
        await initialize_clickhouse()
        written = await insert_daily_bars(rows)
    except ClickHouseError as error:
        return ClickHouseSyncResponse(
            enabled=True,
            status="error",
            universe_id=universe_id,
            timeframe=timeframe,
            adjustment=adjustment,
            start=start,
            end=end,
            rows_read=len(rows),
            rows_written=0,
            message=str(error),
        )

    return ClickHouseSyncResponse(
        enabled=True,
        status="ok",
        universe_id=universe_id,
        timeframe=timeframe,
        adjustment=adjustment,
        start=start,
        end=end,
        rows_read=len(rows),
        rows_written=written,
        message="已同步日线行情到 ClickHouse 分析表。",
    )
