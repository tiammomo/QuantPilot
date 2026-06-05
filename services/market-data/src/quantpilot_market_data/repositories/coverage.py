from __future__ import annotations

from dataclasses import dataclass

from psycopg.rows import dict_row

from quantpilot_market_data.database_core import connect, coverage_status
from quantpilot_market_data.models import (
    MarketDataCoverageItem,
    MarketDataCoverageSummary,
)

__all__ = ["MarketDataCoveragePage", "get_market_data_coverage_page", "list_market_data_coverage"]


@dataclass(frozen=True)
class MarketDataCoveragePage:
    items: list[MarketDataCoverageItem]
    total: int
    total_pages: int
    summary: MarketDataCoverageSummary


def _coverage_item_from_row(row) -> MarketDataCoverageItem:
    return MarketDataCoverageItem(
        symbol=str(row["symbol"]),
        name=row["name"],
        timeframe=row["timeframe"],
        adjustment=row["adjustment"],
        provider=str(row["provider"]),
        first_ts=row["first_ts"],
        last_ts=row["last_ts"],
        row_count=int(row["row_count"] or 0),
        data_status=coverage_status(int(row["row_count"] or 0), row["last_ts"]),
    )


def _summary_from_row(row) -> MarketDataCoverageSummary:
    total = int(row["total"] or 0)
    ready = int(row["ready"] or 0)
    missing = int(row["missing"] or 0)
    return MarketDataCoverageSummary(
        total=total,
        ready=ready,
        missing=missing,
        stale=int(row["stale"] or 0),
        ready_ratio=round((ready / total) * 100, 2) if total else 0,
        latest_ts=row["latest_ts"],
        total_rows=int(row["total_rows"] or 0),
    )


async def get_market_data_coverage_page(
    universe_id: str | None = None,
    *,
    page: int = 1,
    page_size: int = 100,
    include_inactive: bool = False,
) -> MarketDataCoveragePage:
    normalized_page = max(1, page)
    normalized_page_size = max(1, page_size)
    offset = (normalized_page - 1) * normalized_page_size
    async with await connect() as connection, connection.cursor(row_factory=dict_row) as cursor:
        if universe_id:
            await cursor.execute(
                """
                    WITH target_members AS (
                      SELECT
                        members.symbol,
                        members.metadata AS member_metadata,
                        securities.name,
                        COALESCE(
                          universes.metadata->>'default_timeframe',
                          'daily'
                        ) AS default_timeframe,
                        COALESCE(
                          universes.metadata->>'default_adjustment',
                          'qfq'
                        ) AS default_adjustment,
                        COALESCE(universes.metadata->>'provider', 'eastmoney') AS default_provider
                      FROM quant.security_universe_members members
                      JOIN quant.security_universes universes
                        ON universes.id = members.universe_id
                      JOIN quant.securities securities
                        ON securities.symbol = members.symbol
                      WHERE members.universe_id = %s
                        AND (
                          %s
                          OR (
                            COALESCE(members.role, 'member') <> 'inactive'
                            AND COALESCE(securities.status, 'active') NOT IN (
                              'inactive',
                              'delisted'
                            )
                          )
                        )
                    ),
                    coverage_rows AS (
                      SELECT
                        target_members.symbol,
                        coverage.last_ts,
                        COALESCE(coverage.row_count, 0) AS row_count
                      FROM target_members
                      LEFT JOIN LATERAL (
                        SELECT sync_state.*
                        FROM quant.market_data_sync_state sync_state
                        WHERE sync_state.symbol = target_members.symbol
                          AND sync_state.timeframe = target_members.default_timeframe
                          AND sync_state.adjustment = target_members.default_adjustment
                        ORDER BY
                          (sync_state.provider = target_members.default_provider) DESC,
                          sync_state.last_ts DESC NULLS LAST
                        LIMIT 1
                      ) coverage ON TRUE
                    )
                    SELECT
                      COUNT(*)::INT AS total,
                      COUNT(*) FILTER (
                        WHERE row_count > 0 AND last_ts IS NOT NULL
                      )::INT AS ready,
                      COUNT(*) FILTER (
                        WHERE row_count <= 0 OR last_ts IS NULL
                      )::INT AS missing,
                      0::INT AS stale,
                      MAX(last_ts) AS latest_ts,
                      COALESCE(SUM(row_count), 0)::INT AS total_rows
                    FROM coverage_rows
                    """,
                (universe_id, include_inactive),
            )
            summary = _summary_from_row(await cursor.fetchone())
            await cursor.execute(
                """
                    WITH target_members AS (
                      SELECT
                        members.symbol,
                        members.metadata AS member_metadata,
                        securities.name,
                        COALESCE(
                          universes.metadata->>'default_timeframe',
                          'daily'
                        ) AS default_timeframe,
                        COALESCE(
                          universes.metadata->>'default_adjustment',
                          'qfq'
                        ) AS default_adjustment,
                        COALESCE(universes.metadata->>'provider', 'eastmoney') AS default_provider
                      FROM quant.security_universe_members members
                      JOIN quant.security_universes universes
                        ON universes.id = members.universe_id
                      JOIN quant.securities securities
                        ON securities.symbol = members.symbol
                      WHERE members.universe_id = %s
                        AND (
                          %s
                          OR (
                            COALESCE(members.role, 'member') <> 'inactive'
                            AND COALESCE(securities.status, 'active') NOT IN (
                              'inactive',
                              'delisted'
                            )
                          )
                        )
                    ),
                    paged_members AS (
                      SELECT *
                      FROM target_members
                      ORDER BY
                        CASE
                          WHEN member_metadata->>'order' ~ '^[0-9]+$'
                          THEN (member_metadata->>'order')::INT
                        END NULLS LAST,
                        symbol
                      LIMIT %s OFFSET %s
                    )
                    SELECT
                      paged_members.symbol,
                      paged_members.name,
                      COALESCE(coverage.timeframe, paged_members.default_timeframe) AS timeframe,
                      COALESCE(coverage.adjustment, paged_members.default_adjustment) AS adjustment,
                      COALESCE(coverage.provider, paged_members.default_provider) AS provider,
                      coverage.first_ts,
                      coverage.last_ts,
                      COALESCE(coverage.row_count, 0) AS row_count
                    FROM paged_members
                    LEFT JOIN LATERAL (
                      SELECT sync_state.*
                      FROM quant.market_data_sync_state sync_state
                      WHERE sync_state.symbol = paged_members.symbol
                        AND sync_state.timeframe = paged_members.default_timeframe
                        AND sync_state.adjustment = paged_members.default_adjustment
                      ORDER BY
                        (sync_state.provider = paged_members.default_provider) DESC,
                        sync_state.last_ts DESC NULLS LAST
                      LIMIT 1
                    ) coverage ON TRUE
                    ORDER BY
                      CASE
                        WHEN paged_members.member_metadata->>'order' ~ '^[0-9]+$'
                        THEN (paged_members.member_metadata->>'order')::INT
                      END NULLS LAST,
                      paged_members.symbol
                    """,
                (universe_id, include_inactive, normalized_page_size, offset),
            )
        else:
            await cursor.execute(
                """
                    SELECT
                      COUNT(*)::INT AS total,
                      COUNT(*) FILTER (
                        WHERE row_count > 0 AND last_ts IS NOT NULL
                      )::INT AS ready,
                      COUNT(*) FILTER (
                        WHERE row_count <= 0 OR last_ts IS NULL
                      )::INT AS missing,
                      0::INT AS stale,
                      MAX(last_ts) AS latest_ts,
                      COALESCE(SUM(row_count), 0)::INT AS total_rows
                    FROM quant.market_data_sync_state
                    """,
            )
            summary = _summary_from_row(await cursor.fetchone())
            await cursor.execute(
                """
                    SELECT
                      sync_state.symbol,
                      securities.name,
                      sync_state.timeframe,
                      sync_state.adjustment,
                      sync_state.provider,
                      sync_state.first_ts,
                      sync_state.last_ts,
                      sync_state.row_count
                    FROM quant.market_data_sync_state sync_state
                    LEFT JOIN quant.securities securities
                      ON securities.symbol = sync_state.symbol
                    ORDER BY
                      sync_state.symbol,
                      sync_state.timeframe,
                      sync_state.adjustment,
                      sync_state.provider
                    LIMIT %s OFFSET %s
                    """,
                (normalized_page_size, offset),
            )
        rows = await cursor.fetchall()

    total = summary.total
    total_pages = max(1, (total + normalized_page_size - 1) // normalized_page_size)
    return MarketDataCoveragePage(
        items=[_coverage_item_from_row(row) for row in rows],
        total=total,
        total_pages=total_pages,
        summary=summary,
    )

async def list_market_data_coverage(
    universe_id: str | None = None,
    *,
    include_inactive: bool = False,
) -> list[MarketDataCoverageItem]:
    page = await get_market_data_coverage_page(
        universe_id=universe_id,
        page=1,
        page_size=100_000,
        include_inactive=include_inactive,
    )
    return page.items
