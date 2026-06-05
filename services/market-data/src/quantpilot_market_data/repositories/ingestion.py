from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

from psycopg.rows import dict_row
from psycopg.types.json import Jsonb

from quantpilot_market_data.database_core import (
    DatabaseError,
    connect,
    date_cutoff_datetime,
    json_object,
    lookback_cutoff_datetime,
)
from quantpilot_market_data.models import (
    HistoryIngestionResponse,
    IngestionJobSummary,
    IngestionPreflightCoverage,
)

INGESTION_JOB_STALE_SECONDS = 15 * 60
INGESTION_JOB_STOP_GRACE_SECONDS = 60

__all__ = [
    "control_ingestion_job",
    "create_ingestion_job",
    "finish_ingestion_job",
    "get_history_ingestion_preflight",
    "get_ingestion_job_control",
    "list_ingestion_jobs",
    "reconcile_stale_ingestion_jobs",
    "update_ingestion_job_progress",
]


async def create_ingestion_job(
    *,
    job_id: str,
    universe_id: str | None,
    provider: str,
    timeframe: str,
    adjustment: str,
    total_symbols: int,
    metadata: dict[str, Any],
) -> None:
    async with await connect() as connection, connection.cursor() as cursor:
        await cursor.execute(
            """
                INSERT INTO quant.market_data_ingestion_jobs (
                  id, universe_id, provider, timeframe, adjustment, status, total_symbols,
                  metadata, started_at, created_at, updated_at
                )
                VALUES (%s, %s, %s, %s, %s, 'running', %s, %s, now(), now(), now())
                ON CONFLICT (id) DO UPDATE SET
                  provider = EXCLUDED.provider,
                  status = 'running',
                  total_symbols = EXCLUDED.total_symbols,
                  metadata = quant.market_data_ingestion_jobs.metadata || EXCLUDED.metadata,
                  started_at = now(),
                  updated_at = now()
                """,
            (job_id, universe_id, provider, timeframe, adjustment, total_symbols, Jsonb(metadata)),
        )


async def finish_ingestion_job(response: HistoryIngestionResponse) -> None:
    errors = [
        {"symbol": item.symbol, "error": item.error}
        for item in response.symbols
        if item.status == "failed" and item.error
    ]
    async with await connect() as connection, connection.cursor() as cursor:
        await cursor.execute(
            """
                UPDATE quant.market_data_ingestion_jobs
                SET
                  status = %s,
                  completed_symbols = %s,
                  failed_symbols = %s,
                  rows_received = %s,
                  rows_upserted = %s,
                  error = %s,
                  metadata = metadata || %s,
                  completed_at = %s,
                  updated_at = now()
                WHERE id = %s
                """,
            (
                response.status,
                response.completed_symbols,
                response.failed_symbols,
                response.rows_received,
                response.rows_upserted,
                "; ".join(f"{item['symbol']}: {item['error']}" for item in errors)[:2000]
                or None,
                Jsonb(
                    {
                        "symbol_results": [
                            item.model_dump(mode="json") for item in response.symbols
                        ],
                        "batch_offset": response.batch_offset,
                        "batch_size": response.batch_size,
                        "next_offset": response.next_offset,
                        "universe_total_symbols": response.universe_total_symbols,
                    }
                ),
                response.completed_at,
                response.job_id,
            ),
        )


async def update_ingestion_job_progress(
    *,
    job_id: str,
    status: str | None = None,
    completed_symbols: int | None = None,
    failed_symbols: int | None = None,
    rows_received: int | None = None,
    rows_upserted: int | None = None,
    error: str | None = None,
    metadata: dict[str, Any] | None = None,
    completed_at: datetime | None = None,
) -> None:
    updates = ["updated_at = now()"]
    params: list[Any] = []
    if status is not None:
        updates.append("status = %s")
        params.append(status)
    if completed_symbols is not None:
        updates.append("completed_symbols = %s")
        params.append(completed_symbols)
    if failed_symbols is not None:
        updates.append("failed_symbols = %s")
        params.append(failed_symbols)
    if rows_received is not None:
        updates.append("rows_received = %s")
        params.append(rows_received)
    if rows_upserted is not None:
        updates.append("rows_upserted = %s")
        params.append(rows_upserted)
    if error is not None:
        updates.append("error = %s")
        params.append(error[:2000])
    if metadata:
        updates.append("metadata = metadata || %s")
        params.append(Jsonb(metadata))
    if completed_at is not None:
        updates.append("completed_at = %s")
        params.append(completed_at)

    params.append(job_id)
    async with await connect() as connection, connection.cursor() as cursor:
        await cursor.execute(
            f"""
                UPDATE quant.market_data_ingestion_jobs
                SET {", ".join(updates)}
                WHERE id = %s
                """,
            tuple(params),
        )


async def control_ingestion_job(
    *,
    job_id: str,
    control: str,
    reason: str | None = None,
) -> IngestionJobSummary:
    now_iso = datetime.now(UTC).isoformat()
    metadata = {
        "control": control,
        "control_reason": reason,
        "control_updated_at": now_iso,
    }
    async with await connect() as connection, connection.cursor(row_factory=dict_row) as cursor:
        await cursor.execute(
            """
                UPDATE quant.market_data_ingestion_jobs
                SET
                  metadata = metadata || %s,
                  updated_at = now()
                WHERE id = %s
                RETURNING
                  id,
                  universe_id,
                  provider,
                  timeframe,
                  adjustment,
                  status,
                  total_symbols,
                  completed_symbols,
                  failed_symbols,
                  rows_received,
                  rows_upserted,
                  error,
                  metadata,
                  started_at,
                  completed_at,
                  created_at,
                  updated_at
                """,
            (Jsonb(metadata), job_id),
        )
        row = await cursor.fetchone()

    if not row:
        raise DatabaseError(f"补数任务不存在：{job_id}")
    return ingestion_job_summary_from_row(row)


async def reconcile_stale_ingestion_jobs(
    *,
    universe_id: str | None = None,
    heartbeat_timeout_seconds: int = INGESTION_JOB_STALE_SECONDS,
    stop_grace_seconds: int = INGESTION_JOB_STOP_GRACE_SECONDS,
) -> int:
    """Close running ingestion jobs that no longer have a live worker behind them."""
    now_iso = datetime.now(UTC).isoformat()
    universe_sql = "AND universe_id = %s" if universe_id else ""
    params: list[Any] = [stop_grace_seconds, heartbeat_timeout_seconds]
    if universe_id:
        params.append(universe_id)
    params.append(now_iso)

    async with await connect() as connection, connection.cursor(row_factory=dict_row) as cursor:
        await cursor.execute(
            f"""
                WITH stale AS (
                  SELECT
                    id,
                    CASE
                      WHEN metadata->>'control' = 'stop'
                        THEN '补数任务已请求停止，心跳未继续，已自动收口。'
                      ELSE '补数任务心跳过期，已自动标记为部分完成。'
                    END AS reason
                  FROM quant.market_data_ingestion_jobs
                  WHERE status = 'running'
                    AND (
                      (
                        metadata->>'control' = 'stop'
                        AND COALESCE(
                          NULLIF(metadata->>'control_updated_at', '')::timestamptz,
                          updated_at
                        )
                          < now() - (%s * interval '1 second')
                      )
                      OR (
                        COALESCE(
                          NULLIF(metadata->>'last_heartbeat_at', '')::timestamptz,
                          updated_at
                        )
                          < now() - (%s * interval '1 second')
                      )
                    )
                    {universe_sql}
                )
                UPDATE quant.market_data_ingestion_jobs AS job
                SET
                  status = 'partial',
                  completed_at = COALESCE(job.completed_at, now()),
                  error = COALESCE(job.error, stale.reason),
                  metadata = COALESCE(job.metadata, '{{}}'::jsonb) || jsonb_build_object(
                    'control', 'idle',
                    'active_child_job_id', NULL,
                    'stop_reason',
                      CASE
                        WHEN job.metadata->>'control' = 'stop' THEN 'stopped'
                        ELSE 'stale_heartbeat'
                      END,
                    'stale_reconciled_at', %s::text
                  ),
                  updated_at = now()
                FROM stale
                WHERE job.id = stale.id
                RETURNING job.id
                """,
            tuple(params),
        )
        rows = await cursor.fetchall()
    return len(rows)


async def list_ingestion_jobs(
    *,
    universe_id: str | None = None,
    limit: int = 20,
) -> list[IngestionJobSummary]:
    normalized_limit = max(1, min(limit, 100))
    params: tuple[Any, ...]
    where_sql = ""
    if universe_id:
        where_sql = "WHERE universe_id = %s"
        params = (universe_id, normalized_limit)
    else:
        params = (normalized_limit,)

    await reconcile_stale_ingestion_jobs(universe_id=universe_id)

    async with await connect() as connection, connection.cursor(row_factory=dict_row) as cursor:
        await cursor.execute(
            f"""
                SELECT
                  id,
                  universe_id,
                  provider,
                  timeframe,
                  adjustment,
                  status,
                  total_symbols,
                  completed_symbols,
                  failed_symbols,
                  rows_received,
                  rows_upserted,
                  error,
                  metadata,
                  started_at,
                  completed_at,
                  created_at,
                  updated_at
                FROM quant.market_data_ingestion_jobs
                {where_sql}
                ORDER BY created_at DESC
                LIMIT %s
                """,
            params,
        )
        rows = await cursor.fetchall()

    return [ingestion_job_summary_from_row(row) for row in rows]


def ingestion_job_summary_from_row(row: dict[str, Any]) -> IngestionJobSummary:
    return IngestionJobSummary(
        id=str(row["id"]),
        universe_id=row["universe_id"],
        provider=str(row["provider"]),
        timeframe=str(row["timeframe"]),
        adjustment=str(row["adjustment"]),
        status=str(row["status"]),
        total_symbols=int(row["total_symbols"] or 0),
        completed_symbols=int(row["completed_symbols"] or 0),
        failed_symbols=int(row["failed_symbols"] or 0),
        rows_received=int(row["rows_received"] or 0),
        rows_upserted=int(row["rows_upserted"] or 0),
        error=row["error"],
        metadata=json_object(row["metadata"]),
        started_at=row["started_at"],
        completed_at=row["completed_at"],
        created_at=row["created_at"],
        updated_at=row["updated_at"],
    )


async def get_ingestion_job_control(job_id: str) -> str | None:
    async with await connect() as connection, connection.cursor(row_factory=dict_row) as cursor:
        await cursor.execute(
            """
                SELECT metadata->>'control' AS control
                FROM quant.market_data_ingestion_jobs
                WHERE id = %s
                """,
            (job_id,),
        )
        row = await cursor.fetchone()
    return str(row["control"]) if row and row["control"] else None


async def get_history_ingestion_preflight(
    *,
    targets: list[dict[str, str]],
    timeframe: str,
    adjustment: str,
    lookback_years: int | None,
    start: str | None = None,
    end: str | None = None,
    require_fields: list[str] | None = None,
) -> dict[str, IngestionPreflightCoverage]:
    if not targets:
        return {}

    cutoff = date_cutoff_datetime(start) or lookback_cutoff_datetime(lookback_years)
    if cutoff is None:
        cutoff = datetime.min.replace(tzinfo=UTC)
    end_cutoff = date_cutoff_datetime(end)
    symbols = [str(target["symbol"]) for target in targets if target.get("symbol")]
    require_fields = require_fields or []
    if not symbols:
        return {}

    async with await connect() as connection, connection.cursor(row_factory=dict_row) as cursor:
        await cursor.execute(
            """
                WITH target_symbols(symbol) AS (
                  SELECT unnest(%s::text[])
                ),
                benchmark_dates AS (
                  SELECT DISTINCT bars.ts
                  FROM quant.stock_bars bars
                  WHERE bars.timeframe = %s
                    AND bars.adjustment = %s
                    AND bars.ts >= %s
                    AND (%s::TIMESTAMPTZ IS NULL OR bars.ts <= %s)
                ),
                benchmark_summary AS (
                  SELECT
                    count(*)::INT AS expected_rows_since_cutoff,
                    max(ts) AS benchmark_last_ts
                  FROM benchmark_dates
                ),
                requested_range AS (
                  SELECT %s::TIMESTAMPTZ AS requested_end_ts
                ),
                bar_summary AS (
                  SELECT
                    bars.symbol,
                    min(bars.ts) AS first_ts,
                    max(bars.ts) AS last_ts,
                    count(*)::INT AS row_count,
                    count(*) FILTER (
                      WHERE bars.ts >= %s
                        AND (%s::TIMESTAMPTZ IS NULL OR bars.ts <= %s)
                    )::INT AS rows_since_cutoff,
                    count(*) FILTER (
                      WHERE bars.ts >= %s
                        AND (%s::TIMESTAMPTZ IS NULL OR bars.ts <= %s)
                        AND (%s::BOOLEAN IS FALSE OR bars.amount IS NOT NULL)
                        AND (%s::BOOLEAN IS FALSE OR bars.turnover IS NOT NULL)
                        AND (%s::BOOLEAN IS FALSE OR bars.trade_status IS NOT NULL)
                        AND (%s::BOOLEAN IS FALSE OR bars.is_st IS NOT NULL)
                        AND (%s::BOOLEAN IS FALSE OR bars.limit_up IS NOT NULL)
                        AND (%s::BOOLEAN IS FALSE OR bars.limit_down IS NOT NULL)
                    )::INT AS complete_rows_since_cutoff
                  FROM quant.stock_bars bars
                  JOIN target_symbols
                    ON target_symbols.symbol = bars.symbol
                  WHERE bars.timeframe = %s
                    AND bars.adjustment = %s
                  GROUP BY bars.symbol
                ),
                factor_summary AS (
                  SELECT
                    factors.symbol,
                    count(*) FILTER (
                      WHERE factors.factor_key = 'pe_ttm'
                        AND factors.ts >= %s
                        AND (%s::TIMESTAMPTZ IS NULL OR factors.ts <= %s)
                    )::INT AS pe_ttm_count,
                    count(*) FILTER (
                      WHERE factors.factor_key = 'pb_mrq'
                        AND factors.ts >= %s
                        AND (%s::TIMESTAMPTZ IS NULL OR factors.ts <= %s)
                    )::INT AS pb_mrq_count,
                    count(*) FILTER (
                      WHERE factors.factor_key = 'ps_ttm'
                        AND factors.ts >= %s
                        AND (%s::TIMESTAMPTZ IS NULL OR factors.ts <= %s)
                    )::INT AS ps_ttm_count,
                    count(*) FILTER (
                      WHERE factors.factor_key = 'pcf_ncf_ttm'
                        AND factors.ts >= %s
                        AND (%s::TIMESTAMPTZ IS NULL OR factors.ts <= %s)
                    )::INT AS pcf_ncf_ttm_count
                  FROM quant.stock_factors factors
                  JOIN target_symbols
                    ON target_symbols.symbol = factors.symbol
                  GROUP BY factors.symbol
                )
                SELECT
                  target_symbols.symbol,
                  bar_summary.first_ts,
                  bar_summary.last_ts,
                  GREATEST(
                    benchmark_summary.benchmark_last_ts,
                    requested_range.requested_end_ts
                  ) AS benchmark_last_ts,
                  COALESCE(bar_summary.row_count, 0) AS row_count,
                  COALESCE(bar_summary.rows_since_cutoff, 0) AS rows_since_cutoff,
                  COALESCE(
                    benchmark_summary.expected_rows_since_cutoff,
                    0
                  ) AS expected_rows_since_cutoff,
                  COALESCE(
                    bar_summary.complete_rows_since_cutoff,
                    0
                  ) AS complete_rows_since_cutoff,
                  COALESCE(factor_summary.pe_ttm_count, 0) AS pe_ttm_count,
                  COALESCE(factor_summary.pb_mrq_count, 0) AS pb_mrq_count,
                  COALESCE(factor_summary.ps_ttm_count, 0) AS ps_ttm_count,
                  COALESCE(factor_summary.pcf_ncf_ttm_count, 0) AS pcf_ncf_ttm_count
                FROM target_symbols
                CROSS JOIN benchmark_summary
                CROSS JOIN requested_range
                LEFT JOIN bar_summary
                  ON bar_summary.symbol = target_symbols.symbol
                LEFT JOIN factor_summary
                  ON factor_summary.symbol = target_symbols.symbol
                """,
            (
                symbols,
                timeframe,
                adjustment,
                cutoff,
                end_cutoff,
                end_cutoff,
                end_cutoff,
                cutoff,
                end_cutoff,
                end_cutoff,
                cutoff,
                end_cutoff,
                end_cutoff,
                "amount" in require_fields,
                "turnover" in require_fields,
                "trade_status" in require_fields,
                "is_st" in require_fields,
                "limit_up" in require_fields,
                "limit_down" in require_fields,
                timeframe,
                adjustment,
                cutoff,
                end_cutoff,
                end_cutoff,
                cutoff,
                end_cutoff,
                end_cutoff,
                cutoff,
                end_cutoff,
                end_cutoff,
                cutoff,
                end_cutoff,
                end_cutoff,
            ),
        )
        rows = await cursor.fetchall()

    result: dict[str, IngestionPreflightCoverage] = {}
    for row in rows:
        result[str(row["symbol"])] = IngestionPreflightCoverage(
            symbol=str(row["symbol"]),
            first_ts=row["first_ts"],
            last_ts=row["last_ts"],
            benchmark_last_ts=row["benchmark_last_ts"],
            row_count=int(row["row_count"] or 0),
            rows_since_cutoff=int(row["rows_since_cutoff"] or 0),
            expected_rows_since_cutoff=int(row["expected_rows_since_cutoff"] or 0),
            complete_rows_since_cutoff=int(row["complete_rows_since_cutoff"] or 0),
            pe_ttm_count=int(row["pe_ttm_count"] or 0),
            pb_mrq_count=int(row["pb_mrq_count"] or 0),
            ps_ttm_count=int(row["ps_ttm_count"] or 0),
            pcf_ncf_ttm_count=int(row["pcf_ncf_ttm_count"] or 0),
        )
    return result
