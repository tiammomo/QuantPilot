from __future__ import annotations

import os
from datetime import UTC, date, datetime, timedelta
from typing import Any, Literal

from psycopg.rows import dict_row
from psycopg.types.json import Jsonb

from quantpilot_market_data.clickhouse import get_clickhouse_health
from quantpilot_market_data.database_core import (
    SHANGHAI_TZ,
    canonical_symbol,
    connect,
    infer_market_from_symbol,
    json_array,
    json_object,
    normalize_fetch_symbol,
)
from quantpilot_market_data.models import (
    DataQualityIssue,
    DataQualityScanRequest,
    DataQualityScanResponse,
    FactorDefinition,
    FoundationComponentStatus,
    IngestionPreflightCoverage,
    TradingCalendarDay,
)
from quantpilot_market_data.repositories.ingestion import get_history_ingestion_preflight

__all__ = [
    "list_factor_definitions",
    "list_foundation_components",
    "list_trading_calendar_days",
    "run_data_quality_scan",
    "upsert_trading_calendar_days",
]


def _coverage_missing_fields(
    coverage: IngestionPreflightCoverage,
    require_fields: list[str],
) -> tuple[bool, list[str]]:
    missing: list[str] = []
    if coverage.row_count <= 0 or coverage.rows_since_cutoff <= 0:
        return False, ["kline"]
    expected_rows = max(1, coverage.expected_rows_since_cutoff or 0)
    observed_rows = coverage.rows_since_cutoff
    if coverage.benchmark_last_ts is not None and (
        coverage.last_ts is None or coverage.last_ts < coverage.benchmark_last_ts
    ):
        missing.append("latest_trade_date")
    if coverage.rows_since_cutoff < expected_rows:
        missing.append("kline")
    if coverage.rows_since_cutoff <= 0:
        missing.append("kline")
    field_count_by_key = {
        "amount": coverage.amount_count,
        "turnover": coverage.turnover_count,
        "trade_status": coverage.trade_status_count,
        "is_st": coverage.is_st_count,
        "limit_up": coverage.limit_up_count,
        "limit_down": coverage.limit_down_count,
    }
    for key, count in field_count_by_key.items():
        if key in require_fields and count < observed_rows:
            missing.append(key)
    factor_count_by_key = {
        "pe_ttm": coverage.pe_ttm_count,
        "pb_mrq": coverage.pb_mrq_count,
        "ps_ttm": coverage.ps_ttm_count,
        "pcf_ncf_ttm": coverage.pcf_ncf_ttm_count,
    }
    for key, count in factor_count_by_key.items():
        if key in require_fields and count < observed_rows:
            missing.append(key)
    missing = list(dict.fromkeys(missing))
    return not missing, missing


async def list_foundation_components() -> list[FoundationComponentStatus]:
    async with await connect() as connection, connection.cursor(row_factory=dict_row) as cursor:
        await cursor.execute(
            """
            WITH hypertable_estimates AS (
              SELECT
                hypertables.table_name AS relname,
                COALESCE(SUM(GREATEST(classes.reltuples, 0))::BIGINT, 0) AS estimated_rows
              FROM _timescaledb_catalog.hypertable hypertables
              JOIN _timescaledb_catalog.chunk chunks
                ON chunks.hypertable_id = hypertables.id
               AND chunks.status = 0
              JOIN pg_namespace namespaces
                ON namespaces.nspname = chunks.schema_name
              JOIN pg_class classes
                ON classes.relnamespace = namespaces.oid
               AND classes.relname = chunks.table_name
              WHERE hypertables.schema_name = 'quant'
                AND hypertables.table_name IN ('stock_bars', 'stock_factors')
              GROUP BY hypertables.table_name
            ),
            table_estimates AS (
              SELECT relname, estimated_rows
              FROM hypertable_estimates
              UNION ALL
              SELECT
                classes.relname,
                GREATEST(classes.reltuples::BIGINT, 0) AS estimated_rows
              FROM pg_class classes
              JOIN pg_namespace namespaces
                ON namespaces.oid = classes.relnamespace
              WHERE namespaces.nspname = 'quant'
                AND classes.relname IN ('stock_bars', 'stock_factors')
                AND NOT EXISTS (
                  SELECT 1
                  FROM hypertable_estimates
                  WHERE hypertable_estimates.relname = classes.relname
                )
            )
            SELECT
              (SELECT count(*)::INT FROM quant.trading_calendars) AS calendar_count,
              (SELECT count(*)::INT FROM quant.factor_definitions) AS factor_count,
              (SELECT count(*)::INT FROM quant.data_quality_scans) AS quality_scan_count,
              (SELECT count(*)::INT FROM quant.platform_jobs) AS platform_job_count,
              COALESCE(
                (SELECT estimated_rows FROM table_estimates WHERE relname = 'stock_bars'),
                0
              ) AS bar_count,
              COALESCE(
                (SELECT estimated_rows FROM table_estimates WHERE relname = 'stock_factors'),
                0
              ) AS factor_value_count,
              (SELECT count(*)::INT FROM quant.market_data_ingestion_jobs) AS ingestion_job_count
            """
        )
        row = await cursor.fetchone()

    row = row or {}
    calendar_count = int(row.get("calendar_count") or 0)
    factor_count = int(row.get("factor_count") or 0)
    quality_scan_count = int(row.get("quality_scan_count") or 0)
    platform_job_count = int(row.get("platform_job_count") or 0)
    bar_count = int(row.get("bar_count") or 0)
    factor_value_count = int(row.get("factor_value_count") or 0)
    ingestion_job_count = int(row.get("ingestion_job_count") or 0)
    clickhouse_health = await get_clickhouse_health()
    clickhouse_rows = int(clickhouse_health.tables.get("quant_bars_daily") or 0)
    clickhouse_latest = clickhouse_health.table_latest_trade_dates.get("quant_bars_daily")
    clickhouse_status: Literal["ready", "partial", "missing"] = "missing"
    if clickhouse_health.status == "ok" and clickhouse_rows > 0:
        clickhouse_status = "ready"
    elif clickhouse_health.enabled:
        clickhouse_status = "partial"
    if clickhouse_latest:
        clickhouse_detail = (
            f"分析日线 {clickhouse_rows} 行，最新交易日 {clickhouse_latest.isoformat()}。"
        )
    elif clickhouse_health.enabled:
        clickhouse_detail = clickhouse_health.error or "ClickHouse 已配置但尚未同步分析日线。"
    else:
        clickhouse_detail = "ClickHouse 未启用，当前分析查询直接使用 TimescaleDB。"

    return [
        FoundationComponentStatus(
            id="trading-calendar",
            name="交易日历",
            status="ready" if calendar_count else "partial",
            count=calendar_count,
            detail=(
                f"已维护 {calendar_count} 个交易日记录。"
                if calendar_count
                else "尚未维护独立交易日历，当前按本地 K 线日期推断。"
            ),
        ),
        FoundationComponentStatus(
            id="factor-registry",
            name="因子定义仓库",
            status="ready" if factor_count else "missing",
            count=factor_count,
            detail=(
                f"已登记 {factor_count} 个因子口径，因子值约 {factor_value_count} 条"
                "（按 TimescaleDB chunk 统计估算）。"
            ),
        ),
        FoundationComponentStatus(
            id="data-quality",
            name="数据质量扫描",
            status="ready" if quality_scan_count else "partial",
            count=quality_scan_count,
            detail=(
                f"已有 {quality_scan_count} 次扫描归档。"
                if quality_scan_count
                else "扫描 API 已可用，尚未产生归档。"
            ),
        ),
        FoundationComponentStatus(
            id="platform-jobs",
            name="平台任务底座",
            status="ready" if platform_job_count or ingestion_job_count else "partial",
            count=platform_job_count + ingestion_job_count,
            detail=(
                f"平台任务 {platform_job_count} 个，补数任务 {ingestion_job_count} 个。"
            ),
        ),
        FoundationComponentStatus(
            id="timeseries-store",
            name="TimescaleDB 行情时序库",
            status="ready" if bar_count else "partial",
            count=bar_count,
            detail=f"本地 K 线约 {bar_count} 行（按 TimescaleDB chunk 统计估算）。",
        ),
        FoundationComponentStatus(
            id="clickhouse-analytics",
            name="ClickHouse 分析加速层",
            status=clickhouse_status,
            count=clickhouse_rows,
            detail=clickhouse_detail,
        ),
    ]


async def list_factor_definitions(
    *,
    category: str | None = None,
    status: str | None = None,
) -> list[FactorDefinition]:
    params: list[Any] = []
    filters: list[str] = []
    if category:
        filters.append("category = %s")
        params.append(category)
    if status:
        filters.append("status = %s")
        params.append(status)
    where_sql = f"WHERE {' AND '.join(filters)}" if filters else ""

    async with await connect() as connection, connection.cursor(row_factory=dict_row) as cursor:
        await cursor.execute(
            f"""
            SELECT
              factor_key,
              name,
              category,
              frequency,
              value_type,
              unit,
              description,
              formula,
              dependencies,
              status,
              provider,
              metadata,
              updated_at
            FROM quant.factor_definitions
            {where_sql}
            ORDER BY
              category,
              COALESCE((metadata->>'display_order')::INT, 9999),
              factor_key
            """,
            tuple(params),
        )
        rows = await cursor.fetchall()

    return [
        FactorDefinition(
            factor_key=str(row["factor_key"]),
            name=str(row["name"]),
            category=str(row["category"]),
            frequency=str(row["frequency"]),
            value_type=str(row["value_type"]),
            unit=row["unit"],
            description=str(row["description"] or ""),
            formula=row["formula"],
            dependencies=json_array(row["dependencies"]),
            status=str(row["status"]),
            provider=str(row["provider"]),
            metadata=json_object(row["metadata"]),
            updated_at=row["updated_at"],
        )
        for row in rows
    ]


async def list_trading_calendar_days(
    *,
    market: str = "CN-A",
    start: str | None = None,
    end: str | None = None,
    limit: int = 260,
) -> list[TradingCalendarDay]:
    start_date = date.fromisoformat(start) if start else None
    end_date = date.fromisoformat(end) if end else None
    normalized_limit = max(1, min(limit, 5000))
    inferred_start_date = start_date
    if inferred_start_date is None:
        range_end = end_date or datetime.now(SHANGHAI_TZ).date()
        inferred_start_date = range_end - timedelta(days=max(45, normalized_limit * 4))
    async with await connect() as connection, connection.cursor(row_factory=dict_row) as cursor:
        await cursor.execute(
            """
            SELECT market, trade_date, is_open, session, source, metadata
            FROM quant.trading_calendars
            WHERE market = %s
              AND (%s::DATE IS NULL OR trade_date >= %s)
              AND (%s::DATE IS NULL OR trade_date <= %s)
            ORDER BY trade_date DESC
            LIMIT %s
            """,
            (market, start_date, start_date, end_date, end_date, normalized_limit),
        )
        rows = await cursor.fetchall()

    if rows:
        return [
            TradingCalendarDay(
                market=str(row["market"]),
                trade_date=row["trade_date"],
                is_open=bool(row["is_open"]),
                session=str(row["session"]),
                source=str(row["source"]),
                metadata=json_object(row["metadata"]),
            )
            for row in reversed(rows)
        ]

    inferred_market = market or "CN-A"
    async with await connect() as connection, connection.cursor(row_factory=dict_row) as cursor:
        await cursor.execute(
            """
            SELECT DISTINCT bars.ts::date AS trade_date
            FROM quant.canonical_stock_bars bars
            JOIN quant.securities securities
              ON securities.symbol = bars.symbol
            WHERE bars.timeframe = 'daily'
              AND securities.asset_type IN ('stock', 'etf', 'index', 'fund')
              AND (
                %s = 'CN-A'
                OR (%s = 'SSE' AND securities.exchange = 'SH')
                OR (%s = 'SZSE' AND securities.exchange = 'SZ')
                OR (%s = 'BSE' AND securities.exchange = 'BJ')
              )
              AND (%s::DATE IS NULL OR bars.ts >= %s::DATE)
              AND (%s::DATE IS NULL OR bars.ts::date <= %s)
            ORDER BY trade_date DESC
            LIMIT %s
            """,
            (
                inferred_market,
                inferred_market,
                inferred_market,
                inferred_market,
                inferred_start_date,
                inferred_start_date,
                end_date,
                end_date,
                normalized_limit,
            ),
        )
        inferred_rows = await cursor.fetchall()

    return [
        TradingCalendarDay(
            market=inferred_market,
            trade_date=row["trade_date"],
            is_open=True,
            session="regular",
            source="stock_bars-inferred",
            metadata={"inferred": True},
        )
        for row in reversed(inferred_rows)
    ]


async def upsert_trading_calendar_days(
    days: list[TradingCalendarDay],
) -> dict[str, int]:
    if not days:
        return {
            "received_days": 0,
            "inserted_days": 0,
            "updated_days": 0,
            "unchanged_days": 0,
            "written_days": 0,
        }
    payload = [day.model_dump(mode="json") for day in days]
    async with await connect() as connection, connection.cursor(row_factory=dict_row) as cursor:
        await cursor.execute(
            """
            WITH incoming AS MATERIALIZED (
              SELECT DISTINCT ON (market, trade_date, session)
                market,
                trade_date,
                is_open,
                session,
                source,
                COALESCE(metadata, '{}'::JSONB) AS metadata
              FROM jsonb_to_recordset(%s::JSONB) AS item(
                market TEXT,
                trade_date DATE,
                is_open BOOLEAN,
                session TEXT,
                source TEXT,
                metadata JSONB
              )
              ORDER BY market, trade_date, session
            ),
            comparison AS MATERIALIZED (
              SELECT
                incoming.*,
                calendars.market IS NULL AS is_new,
                calendars.market IS NOT NULL AND (
                  calendars.is_open IS DISTINCT FROM incoming.is_open
                  OR calendars.source IS DISTINCT FROM incoming.source
                  OR calendars.metadata IS DISTINCT FROM incoming.metadata
                ) AS is_changed
              FROM incoming
              LEFT JOIN quant.trading_calendars calendars
                ON calendars.market = incoming.market
               AND calendars.trade_date = incoming.trade_date
               AND calendars.session = incoming.session
            ),
            upserted AS (
              INSERT INTO quant.trading_calendars (
                market, trade_date, is_open, session, source, metadata,
                created_at, updated_at
              )
              SELECT
                market, trade_date, is_open, session, source, metadata,
                now(), now()
              FROM comparison
              ON CONFLICT (market, trade_date, session) DO UPDATE SET
                is_open = EXCLUDED.is_open,
                source = EXCLUDED.source,
                metadata = EXCLUDED.metadata,
                updated_at = now()
              WHERE quant.trading_calendars.is_open IS DISTINCT FROM EXCLUDED.is_open
                 OR quant.trading_calendars.source IS DISTINCT FROM EXCLUDED.source
                 OR quant.trading_calendars.metadata IS DISTINCT FROM EXCLUDED.metadata
              RETURNING 1
            )
            SELECT
              count(*)::INT AS received_days,
              count(*) FILTER (WHERE is_new)::INT AS inserted_days,
              count(*) FILTER (WHERE NOT is_new AND is_changed)::INT AS updated_days,
              count(*) FILTER (WHERE NOT is_new AND NOT is_changed)::INT
                AS unchanged_days,
              (SELECT count(*)::INT FROM upserted) AS written_days
            FROM comparison
            """,
            (Jsonb(payload),),
        )
        row = await cursor.fetchone()
    row = row or {}
    return {
        "received_days": int(row.get("received_days") or 0),
        "inserted_days": int(row.get("inserted_days") or 0),
        "updated_days": int(row.get("updated_days") or 0),
        "unchanged_days": int(row.get("unchanged_days") or 0),
        "written_days": int(row.get("written_days") or 0),
    }


async def run_data_quality_scan(
    request: DataQualityScanRequest,
) -> DataQualityScanResponse:
    started_at = datetime.now(UTC)
    scan_id = f"dq-{started_at.strftime('%Y%m%d%H%M%S')}-{os.urandom(4).hex()}"
    required_fields = [
        field.strip()
        for field in request.required_fields
        if field.strip()
        in {
            "amount",
            "turnover",
            "trade_status",
            "is_st",
            "limit_up",
            "limit_down",
            "pe_ttm",
            "pb_mrq",
            "ps_ttm",
            "pcf_ncf_ttm",
        }
    ]
    async with await connect() as connection, connection.cursor(row_factory=dict_row) as cursor:
        if request.symbols:
            symbols = [
                canonical_symbol(symbol, symbol.split(".")[-1] if "." in symbol else None)
                for symbol in request.symbols
            ]
            await cursor.execute(
                """
                SELECT symbol, name, exchange
                FROM quant.securities
                WHERE symbol = ANY(%s::text[])
                ORDER BY symbol
                """,
                (symbols,),
            )
        else:
            await cursor.execute(
                """
                SELECT securities.symbol, securities.name, securities.exchange
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
                (request.universe_id,),
            )
        target_rows = await cursor.fetchall()

    targets = [
        {
            "symbol": str(row["symbol"]),
            "query": normalize_fetch_symbol(str(row["symbol"])),
            "name": row["name"],
            "market": infer_market_from_symbol(str(row["symbol"])),
        }
        for row in target_rows
    ]
    coverage_by_symbol = await get_history_ingestion_preflight(
        targets=targets,
        timeframe=request.timeframe,
        adjustment=request.adjustment,
        lookback_years=request.lookback_years,
        require_fields=required_fields,
    )

    issues: list[DataQualityIssue] = []
    passed_symbols = 0
    warning_symbols = 0
    failed_symbols = 0
    checked_rows = 0
    missing_field_counts: dict[str, int] = {field: 0 for field in required_fields}
    latest_ts: datetime | None = None
    expected_rows = 0
    for target in targets:
        coverage = coverage_by_symbol.get(target["symbol"])
        if coverage is None or coverage.row_count == 0:
            failed_symbols += 1
            issues.append(
                DataQualityIssue(
                    symbol=target["symbol"],
                    name=target["name"],
                    severity="error",
                    issue_type="missing_kline",
                    message="本地没有可用 K 线。",
                )
            )
            continue

        checked_rows += coverage.rows_since_cutoff
        expected_rows = max(expected_rows, coverage.expected_rows_since_cutoff)
        if coverage.benchmark_last_ts and (
            latest_ts is None or coverage.benchmark_last_ts > latest_ts
        ):
            latest_ts = coverage.benchmark_last_ts

        symbol_issues: list[DataQualityIssue] = []
        if (
            coverage.expected_rows_since_cutoff
            and coverage.rows_since_cutoff < coverage.expected_rows_since_cutoff
        ):
            symbol_issues.append(
                DataQualityIssue(
                    symbol=target["symbol"],
                    name=target["name"],
                    severity="warning",
                    issue_type="missing_window_rows",
                    message=(
                        "补数区间样本少于本地参考交易日，可能存在缺 K 或新上市样本。"
                    ),
                    metrics={
                        "rows_since_cutoff": coverage.rows_since_cutoff,
                        "expected_rows_since_cutoff": coverage.expected_rows_since_cutoff,
                    },
                )
            )
        if (
            coverage.benchmark_last_ts
            and coverage.last_ts
            and coverage.last_ts.date() < coverage.benchmark_last_ts.date()
        ):
            symbol_issues.append(
                DataQualityIssue(
                    symbol=target["symbol"],
                    name=target["name"],
                    severity="warning",
                    issue_type="stale_latest_bar",
                    message="最新 K 线日期落后于本地参考最新交易日。",
                    metrics={
                        "last_ts": coverage.last_ts.isoformat(),
                        "benchmark_last_ts": coverage.benchmark_last_ts.isoformat(),
                    },
                )
            )
        _, missing_fields = _coverage_missing_fields(coverage, required_fields)
        for field in missing_fields:
            missing_field_counts[field] = missing_field_counts.get(field, 0) + 1
        if missing_fields:
            symbol_issues.append(
                DataQualityIssue(
                    symbol=target["symbol"],
                    name=target["name"],
                    severity="warning",
                    issue_type="missing_fields",
                    message=f"补数区间字段覆盖不完整：{', '.join(missing_fields)}。",
                    metrics={
                        "missing_fields": missing_fields,
                        "complete_rows_since_cutoff": coverage.complete_rows_since_cutoff,
                        "rows_since_cutoff": coverage.rows_since_cutoff,
                    },
                )
            )

        if symbol_issues:
            warning_symbols += 1
            issues.extend(symbol_issues)
        else:
            passed_symbols += 1

    severity = "ok"
    if failed_symbols:
        severity = "error"
    elif warning_symbols:
        severity = "warning"
    completed_at = datetime.now(UTC)
    response = DataQualityScanResponse(
        id=scan_id,
        universe_id=None if request.symbols else request.universe_id,
        symbol=targets[0]["symbol"] if len(targets) == 1 else None,
        scope="symbol" if len(targets) == 1 else "symbols" if request.symbols else "universe",
        timeframe=request.timeframe,
        adjustment=request.adjustment,
        status="completed",
        severity=severity,
        checked_symbols=len(targets),
        passed_symbols=passed_symbols,
        warning_symbols=warning_symbols,
        failed_symbols=failed_symbols,
        checked_rows=checked_rows,
        issue_count=len(issues),
        issues=issues[:500],
        metrics={
            "lookback_years": request.lookback_years,
            "required_fields": required_fields,
            "missing_field_counts": missing_field_counts,
            "expected_rows_since_cutoff": expected_rows,
            "benchmark_last_ts": latest_ts.isoformat() if latest_ts else None,
        },
        started_at=started_at,
        completed_at=completed_at,
    )

    if request.persist:
        async with await connect() as connection, connection.cursor() as cursor:
            await cursor.execute(
                """
                INSERT INTO quant.data_quality_scans (
                  id, universe_id, symbol, scope, timeframe, adjustment, status, severity,
                  checked_symbols, passed_symbols, warning_symbols, failed_symbols,
                  checked_rows, issue_count, issues, metrics, started_at, completed_at,
                  created_at, updated_at
                )
                VALUES (
                  %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s,
                  %s, %s, now(), now()
                )
                ON CONFLICT (id) DO UPDATE SET
                  status = EXCLUDED.status,
                  severity = EXCLUDED.severity,
                  checked_symbols = EXCLUDED.checked_symbols,
                  passed_symbols = EXCLUDED.passed_symbols,
                  warning_symbols = EXCLUDED.warning_symbols,
                  failed_symbols = EXCLUDED.failed_symbols,
                  checked_rows = EXCLUDED.checked_rows,
                  issue_count = EXCLUDED.issue_count,
                  issues = EXCLUDED.issues,
                  metrics = EXCLUDED.metrics,
                  completed_at = EXCLUDED.completed_at,
                  updated_at = now()
                """,
                (
                    response.id,
                    response.universe_id,
                    response.symbol,
                    response.scope,
                    response.timeframe,
                    response.adjustment,
                    response.status,
                    response.severity,
                    response.checked_symbols,
                    response.passed_symbols,
                    response.warning_symbols,
                    response.failed_symbols,
                    response.checked_rows,
                    response.issue_count,
                    Jsonb([issue.model_dump(mode="json") for issue in response.issues]),
                    Jsonb(response.metrics),
                    response.started_at,
                    response.completed_at,
                ),
            )
    return response
