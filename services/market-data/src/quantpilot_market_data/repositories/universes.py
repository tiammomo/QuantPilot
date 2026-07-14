from __future__ import annotations

from datetime import UTC, date, datetime
from decimal import Decimal
from typing import Any

from psycopg.rows import dict_row
from psycopg.types.json import Jsonb

from quantpilot_market_data.database_core import (
    DatabaseError,
    bool_or_none,
    canonical_symbol,
    connect,
    coverage_status,
    decimal_or_none,
    json_array,
    json_object,
    percent_change,
    security_sector_fields,
    universe_trend_status,
)
from quantpilot_market_data.models import (
    ResearchUniverse,
    ResearchUniverseHygieneItem,
    ResearchUniverseHygieneResponse,
    ResearchUniverseMember,
    ResearchUniverseSummary,
    SymbolResolveResult,
)

__all__ = [
    "add_securities_to_universe",
    "add_security_to_universe",
    "clean_research_universe_tradable_members",
    "get_universe_fetch_targets",
    "list_research_universe_members_page",
    "list_research_universe_summaries",
    "list_research_universes",
]

def research_member_from_row(row: dict[str, Any]) -> ResearchUniverseMember:
    row_count = int(row["row_count"] or 0)
    sector_fields = security_sector_fields(row["security_metadata"])
    latest_close = decimal_or_none(row["latest_close"])
    previous_close = decimal_or_none(row["previous_close"])
    latest_change_percent = decimal_or_none(row.get("latest_change_percent"))
    close_20d = decimal_or_none(row["close_20d"])
    close_60d = decimal_or_none(row["close_60d"])
    ma20 = decimal_or_none(row["ma20"])
    ma60 = decimal_or_none(row["ma60"])
    sample_count = int(row["sample_count"] or 0)
    return ResearchUniverseMember(
        symbol=str(row["symbol"]),
        code=str(row["code"]),
        name=row["security_name"],
        industry=sector_fields["industry"],
        region=sector_fields["region"],
        concepts=sector_fields["concepts"],
        sector_hint=sector_fields["sector_hint"],
        sector_tags=sector_fields["sector_tags"],
        exchange=row["exchange"],
        asset_type=row["asset_type"],
        currency=row["currency"],
        timezone=row["timezone"],
        secid=row["secid"],
        provider=str(row["provider"] or "eastmoney"),
        security_status=str(row["security_status"] or "active"),
        role=str(row["role"] or "member"),
        weight=decimal_or_none(row["weight"]),
        row_count=row_count,
        first_ts=row["first_ts"],
        last_ts=row["last_ts"],
        data_provider=row["data_provider"],
        latest_close=latest_close,
        latest_change_pct=(
            latest_change_percent
            if latest_change_percent is not None
            else percent_change(latest_close, previous_close)
        ),
        latest_amount=decimal_or_none(row.get("latest_amount")),
        latest_turnover=decimal_or_none(row.get("latest_turnover")),
        strength_20d_pct=percent_change(latest_close, close_20d),
        strength_60d_pct=percent_change(latest_close, close_60d),
        ma20=ma20,
        ma60=ma60,
        trend_status=universe_trend_status(
            latest_close=latest_close,
            ma20=ma20,
            ma60=ma60,
            sample_count=sample_count,
        ),
        avg_amount_20d=decimal_or_none(row["avg_amount_20d"]),
        avg_volume_20d=decimal_or_none(row["avg_volume_20d"]),
        avg_turnover_20d=decimal_or_none(row.get("avg_turnover_20d")),
        trade_status=row.get("trade_status"),
        is_st=bool_or_none(row.get("is_st")),
        limit_up=bool_or_none(row.get("limit_up")),
        limit_down=bool_or_none(row.get("limit_down")),
        pe_ttm=decimal_or_none(row.get("pe_ttm")),
        pb_mrq=decimal_or_none(row.get("pb_mrq")),
        ps_ttm=decimal_or_none(row.get("ps_ttm")),
        pcf_ncf_ttm=decimal_or_none(row.get("pcf_ncf_ttm")),
        data_status=coverage_status(row_count, row["last_ts"]),
    )


async def get_universe_fetch_targets(universe_id: str) -> list[dict[str, str]]:
    async with await connect() as connection, connection.cursor(row_factory=dict_row) as cursor:
        await cursor.execute(
            """
                SELECT securities.symbol, securities.code, securities.secid, securities.asset_type
                FROM quant.security_universe_members members
                JOIN quant.securities securities
                  ON securities.symbol = members.symbol
                WHERE members.universe_id = %s
                  AND COALESCE(members.role, 'member') <> 'inactive'
                  AND COALESCE(securities.status, 'active') NOT IN ('inactive', 'delisted')
                ORDER BY
                  CASE
                    WHEN members.metadata->>'order' ~ '^[0-9]+$'
                    THEN (members.metadata->>'order')::INT
                  END NULLS LAST,
                  securities.symbol
                """,
            (universe_id,),
        )
        rows = await cursor.fetchall()
    return [
        {
            "symbol": str(row["symbol"]),
            "query": str(row["secid"] or row["code"] or row["symbol"]),
            "asset_type": str(row["asset_type"] or "stock"),
        }
        for row in rows
    ]


async def list_research_universes() -> list[ResearchUniverse]:
    async with await connect() as connection, connection.cursor(row_factory=dict_row) as cursor:
        await cursor.execute(
            """
                SELECT
                  universes.id,
                  universes.name,
                  universes.description,
                  universes.status,
                  universes.source,
                  universes.tags,
                  universes.metadata AS universe_metadata,
                  universes.created_at,
                  universes.updated_at,
                  securities.symbol,
                  securities.code,
                  securities.name AS security_name,
                  securities.exchange,
                  securities.asset_type,
                  securities.currency,
                  securities.timezone,
                  securities.secid,
                  securities.provider,
                  securities.metadata AS security_metadata,
                  securities.status AS security_status,
                  members.role,
                  members.weight,
                  sync_state.first_ts,
                  sync_state.last_ts,
                  sync_state.provider AS data_provider,
                  COALESCE(sync_state.row_count, 0) AS row_count,
                  market_metrics.sample_count,
                  market_metrics.latest_close,
                  market_metrics.previous_close,
                  market_metrics.latest_change_percent,
                  market_metrics.latest_amount,
                  market_metrics.latest_turnover,
                  market_metrics.close_20d,
                  market_metrics.close_60d,
                  market_metrics.ma20,
                  market_metrics.ma60,
                  market_metrics.avg_amount_20d,
                  market_metrics.avg_volume_20d,
                  market_metrics.avg_turnover_20d,
                  market_metrics.trade_status,
                  market_metrics.is_st,
                  market_metrics.limit_up,
                  market_metrics.limit_down,
                  factor_metrics.pe_ttm,
                  factor_metrics.pb_mrq,
                  factor_metrics.ps_ttm,
                  factor_metrics.pcf_ncf_ttm
                FROM quant.security_universes universes
                LEFT JOIN quant.security_universe_members members
                  ON members.universe_id = universes.id
                 AND COALESCE(members.role, 'member') <> 'inactive'
                LEFT JOIN quant.securities securities
                  ON securities.symbol = members.symbol
                 AND COALESCE(securities.status, 'active') NOT IN ('inactive', 'delisted')
                LEFT JOIN LATERAL (
                  SELECT
                    min(sync_row.first_ts) AS first_ts,
                    max(sync_row.last_ts) AS last_ts,
                    (array_agg(
                      sync_row.provider
                      ORDER BY (
                        sync_row.provider = COALESCE(
                          universes.metadata->>'provider',
                          'eastmoney'
                        )
                      ) DESC, sync_row.last_ts DESC NULLS LAST
                    ))[1] AS provider,
                    COALESCE(sum(sync_row.row_count), 0)::INT AS row_count
                  FROM quant.market_data_sync_state sync_row
                  WHERE sync_row.symbol = securities.symbol
                    AND sync_row.timeframe = COALESCE(
                      universes.metadata->>'default_timeframe',
                      'daily'
                    )
                    AND sync_row.adjustment = COALESCE(
                      universes.metadata->>'default_adjustment',
                      'qfq'
                    )
                ) sync_state ON TRUE
                LEFT JOIN LATERAL (
                  SELECT
                    count(*)::INT AS sample_count,
                    (array_agg(recent.close ORDER BY recent.ts DESC))[1] AS latest_close,
                    (array_agg(recent.close ORDER BY recent.ts DESC))[2] AS previous_close,
                    (array_agg(recent.change_percent ORDER BY recent.ts DESC))[1]
                      AS latest_change_percent,
                    (array_agg(recent.amount ORDER BY recent.ts DESC))[1] AS latest_amount,
                    (array_agg(recent.turnover ORDER BY recent.ts DESC))[1] AS latest_turnover,
                    (array_agg(recent.close ORDER BY recent.ts DESC))[21] AS close_20d,
                    (array_agg(recent.close ORDER BY recent.ts DESC))[61] AS close_60d,
                    avg(recent.close) FILTER (WHERE recent.rn <= 20) AS ma20,
                    avg(recent.close) FILTER (WHERE recent.rn <= 60) AS ma60,
                    avg(recent.amount) FILTER (
                      WHERE recent.rn <= 20 AND recent.amount IS NOT NULL
                    ) AS avg_amount_20d,
                    avg(recent.volume) FILTER (WHERE recent.rn <= 20) AS avg_volume_20d,
                    avg(recent.turnover) FILTER (
                      WHERE recent.rn <= 20 AND recent.turnover IS NOT NULL
                    ) AS avg_turnover_20d,
                    (array_agg(recent.trade_status ORDER BY recent.ts DESC))[1] AS trade_status,
                    (array_agg(recent.is_st ORDER BY recent.ts DESC))[1] AS is_st,
                    (array_agg(recent.limit_up ORDER BY recent.ts DESC))[1] AS limit_up,
                    (array_agg(recent.limit_down ORDER BY recent.ts DESC))[1] AS limit_down
                  FROM (
                    SELECT
                      bars.ts,
                      bars.close,
                      bars.amount,
                      bars.volume,
                      bars.change_percent,
                      bars.turnover,
                      bars.trade_status,
                      bars.is_st,
                      bars.limit_up,
                      bars.limit_down,
                      row_number() OVER (ORDER BY bars.ts DESC) AS rn
                    FROM quant.canonical_stock_bars bars
                    WHERE bars.symbol = securities.symbol
                      AND bars.timeframe = COALESCE(
                        universes.metadata->>'default_timeframe',
                        'daily'
                      )
                      AND bars.adjustment = COALESCE(
                        universes.metadata->>'default_adjustment',
                        'qfq'
                      )
                    ORDER BY bars.ts DESC
                    LIMIT 61
                  ) recent
                ) market_metrics ON TRUE
                LEFT JOIN LATERAL (
                  SELECT
                    max(factor_value) FILTER (WHERE factor_key = 'pe_ttm') AS pe_ttm,
                    max(factor_value) FILTER (WHERE factor_key = 'pb_mrq') AS pb_mrq,
                    max(factor_value) FILTER (WHERE factor_key = 'ps_ttm') AS ps_ttm,
                    max(factor_value) FILTER (WHERE factor_key = 'pcf_ncf_ttm')
                      AS pcf_ncf_ttm
                  FROM (
                    SELECT DISTINCT ON (factor_key)
                      factor_key,
                      factor_value
                    FROM quant.stock_factors
                    WHERE symbol = securities.symbol
                    ORDER BY factor_key, ts DESC
                  ) latest_factors
                ) factor_metrics ON TRUE
                ORDER BY
                  CASE
                    WHEN universes.metadata->>'display_order' ~ '^[0-9]+$'
                    THEN (universes.metadata->>'display_order')::INT
                  END NULLS LAST,
                  universes.created_at,
                  CASE
                    WHEN members.metadata->>'order' ~ '^[0-9]+$'
                    THEN (members.metadata->>'order')::INT
                  END NULLS LAST,
                  securities.symbol
                """,
        )
        rows = await cursor.fetchall()

    universes: dict[str, ResearchUniverse] = {}
    for row in rows:
        universe_id = str(row["id"])
        metadata = json_object(row["universe_metadata"])
        if universe_id not in universes:
            universes[universe_id] = ResearchUniverse(
                id=universe_id,
                name=str(row["name"]),
                description=row["description"],
                status=str(row["status"]),
                source=str(row["source"]),
                tags=json_array(row["tags"]),
                default_timeframe=metadata.get("default_timeframe") or "daily",
                default_adjustment=metadata.get("default_adjustment") or "qfq",
                provider=metadata.get("provider") or "eastmoney",
                created_at=row["created_at"],
                updated_at=row["updated_at"],
            )
        if row["symbol"]:
            universes[universe_id].members.append(research_member_from_row(row))

    for universe in universes.values():
        universe.member_count = len(universe.members)
        universe.stock_count = sum(
            1 for member in universe.members if member.asset_type == "stock"
        )
        universe.etf_count = sum(1 for member in universe.members if member.asset_type == "etf")
        universe.index_count = sum(
            1 for member in universe.members if member.asset_type == "index"
        )
        universe.fund_count = sum(
            1 for member in universe.members if member.asset_type == "fund"
        )
        universe.ready_count = sum(
            1 for member in universe.members if member.data_status == "ready"
        )
        universe.bar_count = sum(member.row_count for member in universe.members)
        universe.latest_ts = max(
            (member.last_ts for member in universe.members if member.last_ts),
            default=None,
        )
    return list(universes.values())


async def list_research_universe_summaries() -> list[ResearchUniverseSummary]:
    async with await connect() as connection, connection.cursor(row_factory=dict_row) as cursor:
        await cursor.execute(
            """
                WITH member_rows AS (
                  SELECT
                    universes.id,
                    universes.name,
                    universes.description,
                    universes.status,
                    universes.source,
                    universes.tags,
                    universes.metadata AS universe_metadata,
                    universes.created_at,
                    universes.updated_at,
                    securities.symbol,
                    securities.asset_type,
                    COALESCE(
                      universes.metadata->>'default_timeframe',
                      'daily'
                    ) AS default_timeframe,
                    COALESCE(
                      universes.metadata->>'default_adjustment',
                      'qfq'
                    ) AS default_adjustment
                  FROM quant.security_universes universes
                  LEFT JOIN quant.security_universe_members members
                    ON members.universe_id = universes.id
                   AND COALESCE(members.role, 'member') <> 'inactive'
                  LEFT JOIN quant.securities securities
                    ON securities.symbol = members.symbol
                   AND COALESCE(securities.status, 'active') NOT IN ('inactive', 'delisted')
                ),
                bar_summary AS (
                  SELECT
                    member_rows.id,
                    member_rows.symbol,
                    min(sync_state.first_ts) AS first_ts,
                    max(sync_state.last_ts) AS last_ts,
                    COALESCE(sum(sync_state.row_count), 0)::INT AS row_count
                  FROM member_rows
                  JOIN quant.market_data_sync_state sync_state
                    ON sync_state.symbol = member_rows.symbol
                   AND sync_state.timeframe = member_rows.default_timeframe
                   AND sync_state.adjustment = member_rows.default_adjustment
                  GROUP BY member_rows.id, member_rows.symbol
                )
                SELECT
                  member_rows.id,
                  member_rows.name,
                  member_rows.description,
                  member_rows.status,
                  member_rows.source,
                  member_rows.tags,
                  member_rows.universe_metadata,
                  member_rows.created_at,
                  member_rows.updated_at,
                  count(member_rows.symbol)::INT AS member_count,
                  count(*) FILTER (WHERE member_rows.asset_type = 'stock')::INT AS stock_count,
                  count(*) FILTER (WHERE member_rows.asset_type = 'etf')::INT AS etf_count,
                  count(*) FILTER (WHERE member_rows.asset_type = 'index')::INT AS index_count,
                  count(*) FILTER (WHERE member_rows.asset_type = 'fund')::INT AS fund_count,
                  count(*) FILTER (
                    WHERE COALESCE(bar_summary.row_count, 0) > 0
                      AND bar_summary.last_ts IS NOT NULL
                  )::INT AS ready_count,
                  COALESCE(sum(bar_summary.row_count), 0)::BIGINT AS bar_count,
                  max(bar_summary.last_ts) AS latest_ts
                FROM member_rows
                LEFT JOIN bar_summary
                  ON bar_summary.id = member_rows.id
                 AND bar_summary.symbol = member_rows.symbol
                GROUP BY
                  member_rows.id,
                  member_rows.name,
                  member_rows.description,
                  member_rows.status,
                  member_rows.source,
                  member_rows.tags,
                  member_rows.universe_metadata,
                  member_rows.created_at,
                  member_rows.updated_at
                ORDER BY
                  CASE
                    WHEN member_rows.universe_metadata->>'display_order' ~ '^[0-9]+$'
                    THEN (member_rows.universe_metadata->>'display_order')::INT
                  END NULLS LAST,
                  member_rows.created_at
                """,
        )
        rows = await cursor.fetchall()

    summaries: list[ResearchUniverseSummary] = []
    for row in rows:
        metadata = json_object(row["universe_metadata"])
        summaries.append(
            ResearchUniverseSummary(
                id=str(row["id"]),
                name=str(row["name"]),
                description=row["description"],
                status=str(row["status"]),
                source=str(row["source"]),
                tags=json_array(row["tags"]),
                default_timeframe=metadata.get("default_timeframe") or "daily",
                default_adjustment=metadata.get("default_adjustment") or "qfq",
                provider=metadata.get("provider") or "eastmoney",
                member_count=int(row["member_count"] or 0),
                stock_count=int(row["stock_count"] or 0),
                etf_count=int(row["etf_count"] or 0),
                index_count=int(row["index_count"] or 0),
                fund_count=int(row["fund_count"] or 0),
                ready_count=int(row["ready_count"] or 0),
                bar_count=int(row["bar_count"] or 0),
                latest_ts=row["latest_ts"],
                created_at=row["created_at"],
                updated_at=row["updated_at"],
            )
        )
    return summaries


async def list_research_universe_members_page(
    *,
    universe_id: str,
    page: int = 1,
    page_size: int = 10,
    keyword: str | None = None,
    include_inactive: bool = False,
) -> tuple[list[ResearchUniverseMember], int, int, int]:
    clean_keyword = (keyword or "").strip()
    keyword_pattern = f"%{clean_keyword}%"
    page_size = max(1, min(page_size, 100))

    filter_params = (
        universe_id,
        include_inactive,
        clean_keyword,
        keyword_pattern,
        keyword_pattern,
        keyword_pattern,
        keyword_pattern,
        keyword_pattern,
        keyword_pattern,
    )
    filter_sql = """
        members.universe_id = %s
        AND (
          %s
          OR (
            COALESCE(members.role, 'member') <> 'inactive'
            AND COALESCE(securities.status, 'active') NOT IN ('inactive', 'delisted')
          )
        )
        AND (
          %s = ''
          OR securities.symbol ILIKE %s
          OR securities.code ILIKE %s
          OR securities.name ILIKE %s
          OR securities.exchange ILIKE %s
          OR securities.asset_type ILIKE %s
          OR COALESCE(securities.metadata::TEXT, '') ILIKE %s
        )
    """

    async with await connect() as connection, connection.cursor(row_factory=dict_row) as cursor:
        await cursor.execute(
            f"""
                SELECT count(*)::INT AS total
                FROM quant.security_universe_members members
                JOIN quant.securities securities
                  ON securities.symbol = members.symbol
                WHERE {filter_sql}
                """,
            filter_params,
        )
        total_row = await cursor.fetchone()
        total = int(total_row["total"] or 0) if total_row else 0
        total_pages = max(1, (total + page_size - 1) // page_size)
        current_page = min(max(1, page), total_pages)
        offset = (current_page - 1) * page_size

        await cursor.execute(
            f"""
                WITH filtered_members AS (
                  SELECT
                    universes.metadata AS universe_metadata,
                    securities.symbol,
                    securities.code,
                    securities.name AS security_name,
                    securities.exchange,
                    securities.asset_type,
                    securities.currency,
                    securities.timezone,
                    securities.secid,
                    securities.provider,
                    securities.metadata AS security_metadata,
                    securities.status AS security_status,
                    members.role,
                    members.weight,
                    CASE
                      WHEN members.metadata->>'order' ~ '^[0-9]+$'
                      THEN (members.metadata->>'order')::INT
                    END AS member_order
                  FROM quant.security_universe_members members
                  JOIN quant.security_universes universes
                    ON universes.id = members.universe_id
                  JOIN quant.securities securities
                    ON securities.symbol = members.symbol
                  WHERE {filter_sql}
                  ORDER BY member_order NULLS LAST, securities.symbol
                  LIMIT %s OFFSET %s
                )
                SELECT
                  filtered_members.symbol,
                  filtered_members.code,
                  filtered_members.security_name,
                  filtered_members.exchange,
                  filtered_members.asset_type,
                  filtered_members.currency,
                  filtered_members.timezone,
                  filtered_members.secid,
                  filtered_members.provider,
                  filtered_members.security_metadata,
                  filtered_members.security_status,
                  filtered_members.role,
                  filtered_members.weight,
                  sync_state.first_ts,
                  sync_state.last_ts,
                  sync_state.provider AS data_provider,
                  COALESCE(sync_state.row_count, 0) AS row_count,
                  market_metrics.sample_count,
                  market_metrics.latest_close,
                  market_metrics.previous_close,
                  market_metrics.latest_change_percent,
                  market_metrics.latest_amount,
                  market_metrics.latest_turnover,
                  market_metrics.close_20d,
                  market_metrics.close_60d,
                  market_metrics.ma20,
                  market_metrics.ma60,
                  market_metrics.avg_amount_20d,
                  market_metrics.avg_volume_20d,
                  market_metrics.avg_turnover_20d,
                  market_metrics.trade_status,
                  market_metrics.is_st,
                  market_metrics.limit_up,
                  market_metrics.limit_down,
                  factor_metrics.pe_ttm,
                  factor_metrics.pb_mrq,
                  factor_metrics.ps_ttm,
                  factor_metrics.pcf_ncf_ttm
                FROM filtered_members
                LEFT JOIN LATERAL (
                  SELECT
                    min(sync_row.first_ts) AS first_ts,
                    max(sync_row.last_ts) AS last_ts,
                    (array_agg(
                      sync_row.provider
                      ORDER BY (
                        sync_row.provider = COALESCE(
                          filtered_members.universe_metadata->>'provider',
                          'eastmoney'
                        )
                      ) DESC, sync_row.last_ts DESC NULLS LAST
                    ))[1] AS provider,
                    COALESCE(sum(sync_row.row_count), 0)::INT AS row_count
                  FROM quant.market_data_sync_state sync_row
                  WHERE sync_row.symbol = filtered_members.symbol
                    AND sync_row.timeframe = COALESCE(
                      filtered_members.universe_metadata->>'default_timeframe',
                      'daily'
                    )
                    AND sync_row.adjustment = COALESCE(
                      filtered_members.universe_metadata->>'default_adjustment',
                      'qfq'
                    )
                ) sync_state ON TRUE
                LEFT JOIN LATERAL (
                  SELECT
                    count(*)::INT AS sample_count,
                    (array_agg(recent.close ORDER BY recent.ts DESC))[1] AS latest_close,
                    (array_agg(recent.close ORDER BY recent.ts DESC))[2] AS previous_close,
                    (array_agg(recent.change_percent ORDER BY recent.ts DESC))[1]
                      AS latest_change_percent,
                    (array_agg(recent.amount ORDER BY recent.ts DESC))[1] AS latest_amount,
                    (array_agg(recent.turnover ORDER BY recent.ts DESC))[1] AS latest_turnover,
                    (array_agg(recent.close ORDER BY recent.ts DESC))[21] AS close_20d,
                    (array_agg(recent.close ORDER BY recent.ts DESC))[61] AS close_60d,
                    avg(recent.close) FILTER (WHERE recent.rn <= 20) AS ma20,
                    avg(recent.close) FILTER (WHERE recent.rn <= 60) AS ma60,
                    avg(recent.amount) FILTER (
                      WHERE recent.rn <= 20 AND recent.amount IS NOT NULL
                    ) AS avg_amount_20d,
                    avg(recent.volume) FILTER (WHERE recent.rn <= 20) AS avg_volume_20d,
                    avg(recent.turnover) FILTER (
                      WHERE recent.rn <= 20 AND recent.turnover IS NOT NULL
                    ) AS avg_turnover_20d,
                    (array_agg(recent.trade_status ORDER BY recent.ts DESC))[1] AS trade_status,
                    (array_agg(recent.is_st ORDER BY recent.ts DESC))[1] AS is_st,
                    (array_agg(recent.limit_up ORDER BY recent.ts DESC))[1] AS limit_up,
                    (array_agg(recent.limit_down ORDER BY recent.ts DESC))[1] AS limit_down
                  FROM (
                    SELECT
                      bars.ts,
                      bars.close,
                      bars.amount,
                      bars.volume,
                      bars.change_percent,
                      bars.turnover,
                      bars.trade_status,
                      bars.is_st,
                      bars.limit_up,
                      bars.limit_down,
                      row_number() OVER (ORDER BY bars.ts DESC) AS rn
                    FROM quant.canonical_stock_bars bars
                    WHERE bars.symbol = filtered_members.symbol
                      AND bars.timeframe = COALESCE(
                        filtered_members.universe_metadata->>'default_timeframe',
                        'daily'
                      )
                      AND bars.adjustment = COALESCE(
                        filtered_members.universe_metadata->>'default_adjustment',
                        'qfq'
                      )
                    ORDER BY bars.ts DESC
                    LIMIT 61
                  ) recent
                ) market_metrics ON TRUE
                LEFT JOIN LATERAL (
                  SELECT
                    max(factor_value) FILTER (WHERE factor_key = 'pe_ttm') AS pe_ttm,
                    max(factor_value) FILTER (WHERE factor_key = 'pb_mrq') AS pb_mrq,
                    max(factor_value) FILTER (WHERE factor_key = 'ps_ttm') AS ps_ttm,
                    max(factor_value) FILTER (WHERE factor_key = 'pcf_ncf_ttm')
                      AS pcf_ncf_ttm
                  FROM (
                    SELECT DISTINCT ON (factor_key)
                      factor_key,
                      factor_value
                    FROM quant.stock_factors
                    WHERE symbol = filtered_members.symbol
                    ORDER BY factor_key, ts DESC
                  ) latest_factors
                ) factor_metrics ON TRUE
                ORDER BY filtered_members.member_order NULLS LAST, filtered_members.symbol
                """,
            (*filter_params, page_size, offset),
        )
        rows = await cursor.fetchall()

    return [research_member_from_row(row) for row in rows], total, current_page, total_pages


async def clean_research_universe_tradable_members(
    *,
    universe_id: str,
    target_trade_date: date | None = None,
    dry_run: bool = True,
    max_items: int = 500,
) -> ResearchUniverseHygieneResponse:
    item_limit = max(1, min(max_items, 2_000))
    async with await connect() as connection, connection.cursor(row_factory=dict_row) as cursor:
        await cursor.execute(
            """
            SELECT id
            FROM quant.security_universes
            WHERE id = %s
            """,
            (universe_id,),
        )
        if await cursor.fetchone() is None:
            raise DatabaseError(f"股票池不存在：{universe_id}")

        if target_trade_date is None:
            await cursor.execute(
                """
                WITH universe_config AS (
                  SELECT
                    id,
                    COALESCE(metadata->>'default_timeframe', 'daily') AS timeframe,
                    COALESCE(metadata->>'default_adjustment', 'qfq') AS adjustment
                  FROM quant.security_universes
                  WHERE id = %s
                )
                SELECT max((sync_state.last_ts AT TIME ZONE 'Asia/Shanghai')::date)
                  AS target_trade_date
                FROM quant.security_universe_members members
                JOIN universe_config
                  ON universe_config.id = members.universe_id
                JOIN quant.securities securities
                  ON securities.symbol = members.symbol
                JOIN quant.market_data_sync_state sync_state
                  ON sync_state.symbol = members.symbol
                 AND sync_state.timeframe = universe_config.timeframe
                 AND sync_state.adjustment = universe_config.adjustment
                WHERE members.universe_id = %s
                  AND securities.asset_type = 'stock'
                """,
                (universe_id, universe_id),
            )
            target_trade_date = (await cursor.fetchone() or {}).get("target_trade_date")

        if target_trade_date is None:
            return ResearchUniverseHygieneResponse(
                universe_id=universe_id,
                dry_run=dry_run,
                target_trade_date=None,
                items=[],
            )

        await cursor.execute(
            """
            WITH universe_config AS (
              SELECT
                id,
                COALESCE(metadata->>'default_timeframe', 'daily') AS timeframe,
                COALESCE(metadata->>'default_adjustment', 'qfq') AS adjustment,
                COALESCE(metadata->>'provider', 'eastmoney') AS provider
              FROM quant.security_universes
              WHERE id = %s
            ),
            preferred AS (
              SELECT
                members.symbol,
                securities.name,
                members.role AS previous_role,
                securities.status AS previous_status,
                members.metadata AS member_metadata,
                securities.metadata AS security_metadata,
                sync_state.last_ts,
                (sync_state.last_ts AT TIME ZONE 'Asia/Shanghai')::date AS last_trade_date,
                row_number() OVER (
                  PARTITION BY members.symbol
                  ORDER BY
                    (sync_state.provider = universe_config.provider) DESC,
                    sync_state.last_ts DESC NULLS LAST
                ) AS rn
              FROM quant.security_universe_members members
              JOIN universe_config
                ON universe_config.id = members.universe_id
              JOIN quant.securities securities
                ON securities.symbol = members.symbol
              LEFT JOIN quant.market_data_sync_state sync_state
                ON sync_state.symbol = members.symbol
               AND sync_state.timeframe = universe_config.timeframe
               AND sync_state.adjustment = universe_config.adjustment
              WHERE members.universe_id = %s
                AND securities.asset_type = 'stock'
            )
            SELECT
              symbol,
              name,
              previous_role,
              previous_status,
              member_metadata,
              security_metadata,
              last_ts,
              last_trade_date,
              CASE
                WHEN last_ts IS NULL THEN 'no_local_coverage'
                WHEN last_trade_date < %s::date THEN 'stale_before_latest_trade_date'
                ELSE 'latest_coverage_ready'
              END AS reason,
              CASE
                WHEN (
                  last_ts IS NULL
                  OR last_trade_date < %s::date
                )
                AND (
                  COALESCE(previous_role, 'member') <> 'inactive'
                  OR COALESCE(previous_status, 'active') NOT IN ('inactive', 'delisted')
                )
                THEN 'mark_inactive'
                WHEN last_trade_date >= %s::date
                AND (
                  (
                    COALESCE(previous_role, 'member') = 'inactive'
                    AND COALESCE(member_metadata, '{}'::jsonb) ? 'hygiene'
                  )
                  OR (
                    COALESCE(previous_status, 'active') IN ('inactive', 'delisted')
                    AND COALESCE(security_metadata, '{}'::jsonb) ? 'hygiene'
                  )
                )
                THEN 'mark_active'
                ELSE 'keep'
              END AS action
            FROM preferred
            WHERE rn = 1
            ORDER BY
              CASE
                WHEN (
                  last_ts IS NULL
                  OR last_trade_date < %s::date
                )
                AND (
                  COALESCE(previous_role, 'member') <> 'inactive'
                  OR COALESCE(previous_status, 'active') NOT IN ('inactive', 'delisted')
                )
                THEN 0
                WHEN last_trade_date >= %s::date
                AND (
                  (
                    COALESCE(previous_role, 'member') = 'inactive'
                    AND COALESCE(member_metadata, '{}'::jsonb) ? 'hygiene'
                  )
                  OR (
                    COALESCE(previous_status, 'active') IN ('inactive', 'delisted')
                    AND COALESCE(security_metadata, '{}'::jsonb) ? 'hygiene'
                  )
                )
                THEN 1
                ELSE 2
              END,
              last_trade_date NULLS FIRST,
              symbol
            """,
            (
                universe_id,
                universe_id,
                target_trade_date,
                target_trade_date,
                target_trade_date,
                target_trade_date,
                target_trade_date,
            ),
        )
        rows = await cursor.fetchall()

        now = datetime.now(UTC)
        items: list[ResearchUniverseHygieneItem] = []
        changed_count = 0
        for row in rows:
            action = str(row["action"])
            previous_role = row["previous_role"] or "member"
            previous_status = row["previous_status"] or "active"
            member_metadata = json_object(row["member_metadata"])
            security_metadata = json_object(row["security_metadata"])
            stored_member_hygiene = json_object(member_metadata.get("hygiene"))
            stored_security_hygiene = json_object(security_metadata.get("hygiene"))

            if action == "mark_inactive":
                new_role = "inactive"
                new_status = "inactive"
            elif action == "mark_active":
                new_role = str(stored_member_hygiene.get("previous_role") or "member")
                if new_role == "inactive":
                    new_role = "member"
                new_status = str(stored_security_hygiene.get("previous_status") or "active")
                if new_status in {"inactive", "delisted"}:
                    new_status = "active"
            else:
                new_role = str(previous_role)
                new_status = str(previous_status)

            if action != "keep":
                changed_count += 1
                hygiene_metadata = {
                    "hygiene": {
                        "last_action": action,
                        "reason": row["reason"],
                        "target_trade_date": target_trade_date.isoformat(),
                        "last_trade_date": row["last_trade_date"].isoformat()
                        if row["last_trade_date"]
                        else None,
                        "checked_at": now.isoformat(),
                        "previous_role": previous_role,
                        "previous_status": previous_status,
                        "new_role": new_role,
                        "new_status": new_status,
                    }
                }
                if not dry_run:
                    await cursor.execute(
                        """
                        UPDATE quant.security_universe_members
                        SET
                          role = %s,
                          metadata = COALESCE(metadata, '{}'::jsonb) || %s
                        WHERE universe_id = %s
                          AND symbol = %s
                        """,
                        (new_role, Jsonb(hygiene_metadata), universe_id, row["symbol"]),
                    )
                    await cursor.execute(
                        """
                        UPDATE quant.securities
                        SET
                          status = %s,
                          metadata = COALESCE(metadata, '{}'::jsonb) || %s,
                          updated_at = now()
                        WHERE symbol = %s
                        """,
                        (new_status, Jsonb(hygiene_metadata), row["symbol"]),
                    )

            if len(items) < item_limit:
                items.append(
                    ResearchUniverseHygieneItem(
                        symbol=str(row["symbol"]),
                        name=row["name"],
                        previous_role=str(previous_role) if previous_role else None,
                        new_role=new_role,
                        previous_status=str(previous_status) if previous_status else None,
                        new_status=new_status,
                        last_ts=row["last_ts"],
                        last_trade_date=row["last_trade_date"],
                        reason=str(row["reason"]),
                        action=action,
                    )
                )

        await cursor.execute(
            """
            SELECT
              COUNT(*) FILTER (
                WHERE COALESCE(members.role, 'member') <> 'inactive'
                  AND COALESCE(securities.status, 'active') NOT IN ('inactive', 'delisted')
              )::INT AS active_count,
              COUNT(*) FILTER (
                WHERE NOT (
                  COALESCE(members.role, 'member') <> 'inactive'
                  AND COALESCE(securities.status, 'active') NOT IN ('inactive', 'delisted')
                )
              )::INT AS inactive_count
            FROM quant.security_universe_members members
            JOIN quant.securities securities
              ON securities.symbol = members.symbol
            WHERE members.universe_id = %s
            """,
            (universe_id,),
        )
        count_row = await cursor.fetchone() or {}

    return ResearchUniverseHygieneResponse(
        universe_id=universe_id,
        dry_run=dry_run,
        target_trade_date=target_trade_date,
        inspected_count=len(rows),
        changed_count=changed_count,
        active_count=int(count_row.get("active_count") or 0),
        inactive_count=int(count_row.get("inactive_count") or 0),
        items=items,
        updated_at=now,
    )


async def add_security_to_universe(
    *,
    universe_id: str,
    security: SymbolResolveResult,
    role: str = "member",
    weight: Decimal | None = None,
) -> ResearchUniverseMember:
    symbol = canonical_symbol(security.symbol, security.market)
    metadata = {
        "query": security.query,
        "raw": security.raw,
        "industry": security.raw.get("industry") or security.raw.get("f100"),
        "region": security.raw.get("region") or security.raw.get("f102"),
        "concepts": security.raw.get("concepts") or security.raw.get("f103"),
        "added_source": "strategy-platform",
    }
    async with await connect() as connection, connection.cursor(row_factory=dict_row) as cursor:
        await cursor.execute(
            """
            SELECT id
            FROM quant.security_universes
            WHERE id = %s
            """,
            (universe_id,),
        )
        if await cursor.fetchone() is None:
            raise DatabaseError(f"股票池不存在：{universe_id}")

        await cursor.execute(
            """
            INSERT INTO quant.securities (
              symbol, code, name, exchange, asset_type, currency, timezone, secid, provider,
              metadata, status, created_at, updated_at
            )
            VALUES (%s, %s, %s, %s, %s, 'CNY', 'Asia/Shanghai', %s, %s, %s, 'active', now(), now())
            ON CONFLICT (symbol) DO UPDATE SET
              code = EXCLUDED.code,
              name = COALESCE(EXCLUDED.name, quant.securities.name),
              exchange = EXCLUDED.exchange,
              asset_type = EXCLUDED.asset_type,
              secid = EXCLUDED.secid,
              provider = EXCLUDED.provider,
              status = 'active',
              metadata = (COALESCE(quant.securities.metadata, '{}'::jsonb) - 'hygiene')
                || EXCLUDED.metadata,
              updated_at = now()
            """,
            (
                symbol,
                security.symbol,
                security.name,
                security.market,
                security.asset_type,
                security.secid,
                security.source,
                Jsonb(metadata),
            ),
        )
        await cursor.execute(
            """
            SELECT COALESCE(max((members.metadata->>'order')::INT), 0) + 1 AS next_order
            FROM quant.security_universe_members members
            WHERE members.universe_id = %s
              AND members.metadata->>'order' ~ '^[0-9]+$'
            """,
            (universe_id,),
        )
        order_row = await cursor.fetchone()
        next_order = int(order_row["next_order"] or 1) if order_row else 1
        await cursor.execute(
            """
            INSERT INTO quant.security_universe_members (
              universe_id, symbol, role, weight, metadata, added_at
            )
            VALUES (%s, %s, %s, %s, %s, now())
            ON CONFLICT (universe_id, symbol) DO UPDATE SET
              role = EXCLUDED.role,
              weight = EXCLUDED.weight,
              metadata = (
                COALESCE(quant.security_universe_members.metadata, '{}'::jsonb) - 'hygiene'
              ) || EXCLUDED.metadata
            """,
            (
                universe_id,
                symbol,
                role or "member",
                weight,
                Jsonb({"order": next_order, "added_source": "strategy-platform"}),
            ),
        )

    members, _, _, _ = await list_research_universe_members_page(
        universe_id=universe_id,
        page=1,
        page_size=10,
        keyword=symbol,
        include_inactive=True,
    )
    for member in members:
        if member.symbol == symbol:
            return member
    raise DatabaseError(f"股票已写入但无法读取股票池成员：{symbol}")


async def add_securities_to_universe(
    *,
    universe_id: str,
    securities: list[SymbolResolveResult],
    role: str = "member",
    added_source: str = "a-share-batch-import",
) -> list[ResearchUniverseMember]:
    if not securities:
        return []

    async with await connect() as connection, connection.cursor(row_factory=dict_row) as cursor:
        await cursor.execute(
            """
            SELECT id
            FROM quant.security_universes
            WHERE id = %s
            """,
            (universe_id,),
        )
        if await cursor.fetchone() is None:
            raise DatabaseError(f"股票池不存在：{universe_id}")

        await cursor.execute(
            """
            SELECT COALESCE(max((members.metadata->>'order')::INT), 0) + 1 AS next_order
            FROM quant.security_universe_members members
            WHERE members.universe_id = %s
              AND members.metadata->>'order' ~ '^[0-9]+$'
            """,
            (universe_id,),
        )
        order_row = await cursor.fetchone()
        next_order = int(order_row["next_order"] or 1) if order_row else 1

        symbols: list[str] = []
        for offset, security in enumerate(securities):
            symbol = canonical_symbol(security.symbol, security.market)
            symbols.append(symbol)
            metadata = {
                "query": security.query,
                "raw": security.raw,
                "industry": security.raw.get("industry") or security.raw.get("f100"),
                "region": security.raw.get("region") or security.raw.get("f102"),
                "concepts": security.raw.get("concepts") or security.raw.get("f103"),
                "added_source": added_source,
            }
            await cursor.execute(
                """
                INSERT INTO quant.securities (
                  symbol, code, name, exchange, asset_type, currency, timezone, secid,
                  provider, metadata, status, created_at, updated_at
                )
                VALUES (
                  %s, %s, %s, %s, %s, 'CNY', 'Asia/Shanghai', %s, %s, %s,
                  'active', now(), now()
                )
                ON CONFLICT (symbol) DO UPDATE SET
                  code = EXCLUDED.code,
                  name = COALESCE(EXCLUDED.name, quant.securities.name),
                  exchange = EXCLUDED.exchange,
                  asset_type = EXCLUDED.asset_type,
                  secid = EXCLUDED.secid,
                  provider = EXCLUDED.provider,
                  status = 'active',
                  metadata = (COALESCE(quant.securities.metadata, '{}'::jsonb) - 'hygiene')
                    || EXCLUDED.metadata,
                  updated_at = now()
                """,
                (
                    symbol,
                    security.symbol,
                    security.name,
                    security.market,
                    security.asset_type,
                    security.secid,
                    security.source,
                    Jsonb(metadata),
                ),
            )
            await cursor.execute(
                """
                INSERT INTO quant.security_universe_members (
                  universe_id, symbol, role, weight, metadata, added_at
                )
                VALUES (%s, %s, %s, NULL, %s, now())
                ON CONFLICT (universe_id, symbol) DO UPDATE SET
                  role = EXCLUDED.role,
                  metadata = CASE
                    WHEN quant.security_universe_members.metadata ? 'order'
                    THEN (
                      COALESCE(quant.security_universe_members.metadata, '{}'::jsonb)
                      - 'hygiene'
                    ) || (EXCLUDED.metadata - 'order')
                    ELSE (
                      COALESCE(quant.security_universe_members.metadata, '{}'::jsonb)
                      - 'hygiene'
                    ) || EXCLUDED.metadata
                  END
                """,
                (
                    universe_id,
                    symbol,
                    role or "member",
                    Jsonb(
                        {
                            "order": next_order + offset,
                            "added_source": added_source,
                        }
                    ),
                ),
            )

    universes = await list_research_universes()
    member_by_symbol = {
        member.symbol: member
        for universe in universes
        if universe.id == universe_id
        for member in universe.members
    }
    return [member_by_symbol[symbol] for symbol in symbols if symbol in member_by_symbol]
