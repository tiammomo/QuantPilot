from __future__ import annotations

import asyncio
import json
import os
import re
from collections.abc import Iterable
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal
from typing import Any
from urllib.parse import urlsplit

from quantpilot_market_data.models import ClickHouseHealthResponse

try:
    import clickhouse_connect
except ImportError:  # pragma: no cover - exercised when optional dependency is absent
    clickhouse_connect = None  # type: ignore[assignment]


TRUE_VALUES = {"1", "true", "yes", "on", "enabled"}
FALSE_VALUES = {"0", "false", "no", "off", "disabled"}
DEFAULT_DATABASE = "quantpilot"
DAILY_BARS_TABLE = "quant_bars_daily"
DAILY_FACTORS_TABLE = "quant_factors_daily"
SYNC_BATCH_SIZE = 10_000
SCREENER_FEATURE_CACHE_TTL_SECONDS = 60
_SCREENER_FEATURE_ROWS_CACHE: dict[
    tuple[str, str, str, str], tuple[datetime, list[dict[str, Any]]]
] = {}

DAILY_BAR_COLUMNS = [
    "universe_id",
    "symbol",
    "code",
    "name",
    "exchange",
    "asset_type",
    "trade_date",
    "timeframe",
    "adjustment",
    "open",
    "high",
    "low",
    "close",
    "previous_close",
    "volume",
    "amount",
    "amplitude",
    "change_percent",
    "change_amount",
    "turnover",
    "trade_status",
    "is_st",
    "limit_up",
    "limit_down",
    "security_metadata",
    "provider",
    "synced_at",
]


class ClickHouseError(RuntimeError):
    """ClickHouse analysis layer is disabled or unavailable."""


@dataclass(frozen=True)
class ClickHouseConfig:
    enabled: bool
    host: str
    port: int
    username: str
    password: str
    database: str
    secure: bool


def _env_flag(name: str, default: bool = False) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    normalized = raw.strip().lower()
    if normalized in TRUE_VALUES:
        return True
    if normalized in FALSE_VALUES:
        return False
    return default


def clickhouse_config() -> ClickHouseConfig:
    url = os.getenv("CLICKHOUSE_URL", "").strip()
    secure = _env_flag("CLICKHOUSE_SECURE", False)
    host = os.getenv("CLICKHOUSE_HOST", "127.0.0.1").strip() or "127.0.0.1"
    port = int(os.getenv("CLICKHOUSE_PORT") or os.getenv("CLICKHOUSE_HTTP_PORT") or "8123")

    if url:
        parsed = urlsplit(url)
        secure = parsed.scheme == "https"
        host = parsed.hostname or host
        port = parsed.port or (8443 if secure else 8123)

    return ClickHouseConfig(
        enabled=_env_flag("QUANTPILOT_CLICKHOUSE_ENABLED", False),
        host=host,
        port=port,
        username=os.getenv("CLICKHOUSE_USER", "quantpilot").strip() or "quantpilot",
        password=os.getenv("CLICKHOUSE_PASSWORD", "").strip(),
        database=(
            os.getenv("CLICKHOUSE_DATABASE")
            or os.getenv("CLICKHOUSE_DB")
            or DEFAULT_DATABASE
        ).strip(),
        secure=secure,
    )


def is_clickhouse_enabled() -> bool:
    return clickhouse_config().enabled


def _quote_identifier(value: str) -> str:
    if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", value):
        raise ClickHouseError(f"非法 ClickHouse 标识符：{value}")
    return f"`{value}`"


def _client(*, database: str | None = None) -> Any:
    config = clickhouse_config()
    if not config.enabled:
        raise ClickHouseError("ClickHouse 分析层未启用。")
    if clickhouse_connect is None:
        raise ClickHouseError("缺少 clickhouse-connect 依赖。")
    return clickhouse_connect.get_client(
        host=config.host,
        port=config.port,
        username=config.username,
        password=config.password,
        database=database or config.database,
        secure=config.secure,
        connect_timeout=3,
        send_receive_timeout=30,
    )


def _close_client(client: Any) -> None:
    close = getattr(client, "close", None)
    if callable(close):
        close()


def _query_rows(sql: str, parameters: dict[str, Any] | None = None) -> list[dict[str, Any]]:
    client = _client()
    try:
        result = client.query(sql, parameters=parameters or {})
        return [dict(zip(result.column_names, row, strict=True)) for row in result.result_rows]
    finally:
        _close_client(client)


def _command(
    sql: str,
    parameters: dict[str, Any] | None = None,
    *,
    database: str | None = None,
) -> None:
    client = _client(database=database)
    try:
        client.command(sql, parameters=parameters or {})
    finally:
        _close_client(client)


def _table_name(table: str) -> str:
    database = _quote_identifier(clickhouse_config().database)
    return f"{database}.{_quote_identifier(table)}"


async def get_clickhouse_health() -> ClickHouseHealthResponse:
    config = clickhouse_config()
    if not config.enabled:
        return ClickHouseHealthResponse(
            enabled=False,
            status="disabled",
            host=config.host,
            port=config.port,
            database=config.database,
        )

    try:
        rows = await asyncio.to_thread(
            _query_rows,
            """
            SELECT version() AS server_version
            """,
        )
        table_rows = await asyncio.to_thread(
            _query_rows,
            """
            SELECT name, coalesce(total_rows, 0) AS total_rows
            FROM system.tables
            WHERE database = {database:String}
              AND name IN ('quant_bars_daily', 'quant_factors_daily')
            """,
            {"database": config.database},
        )
        table_names = {str(row["name"]) for row in table_rows}
        latest_trade_dates: dict[str, date | None] = {}
        if DAILY_BARS_TABLE in table_names:
            latest_rows = await asyncio.to_thread(
                _query_rows,
                f"""
                SELECT max(trade_date) AS latest_trade_date
                FROM {_table_name(DAILY_BARS_TABLE)}
                """,
            )
            latest_value = latest_rows[0]["latest_trade_date"] if latest_rows else None
            latest_trade_dates[DAILY_BARS_TABLE] = (
                _date_value(latest_value) if latest_value else None
            )
        return ClickHouseHealthResponse(
            enabled=True,
            status="ok",
            host=config.host,
            port=config.port,
            database=config.database,
            server_version=str(rows[0]["server_version"]) if rows else None,
            tables={str(row["name"]): int(row["total_rows"] or 0) for row in table_rows},
            table_latest_trade_dates=latest_trade_dates,
        )
    except Exception as error:
        return ClickHouseHealthResponse(
            enabled=True,
            status="error",
            host=config.host,
            port=config.port,
            database=config.database,
            error=str(error),
        )


def _initialize_clickhouse_sync() -> None:
    config = clickhouse_config()
    database = _quote_identifier(config.database)
    bars_table = _table_name(DAILY_BARS_TABLE)
    factors_table = _table_name(DAILY_FACTORS_TABLE)

    _command(f"CREATE DATABASE IF NOT EXISTS {database}", database="default")
    _command(
        f"""
        CREATE TABLE IF NOT EXISTS {bars_table}
        (
            universe_id LowCardinality(String),
            symbol String,
            code String,
            name Nullable(String),
            exchange LowCardinality(String),
            asset_type LowCardinality(String),
            trade_date Date,
            timeframe LowCardinality(String),
            adjustment LowCardinality(String),
            open Decimal(20, 8),
            high Decimal(20, 8),
            low Decimal(20, 8),
            close Decimal(20, 8),
            previous_close Nullable(Decimal(20, 8)),
            volume Decimal(24, 4),
            amount Nullable(Decimal(24, 4)),
            amplitude Nullable(Decimal(20, 8)),
            change_percent Nullable(Decimal(20, 8)),
            change_amount Nullable(Decimal(20, 8)),
            turnover Nullable(Decimal(20, 8)),
            trade_status Nullable(String),
            is_st Nullable(Bool),
            limit_up Nullable(Bool),
            limit_down Nullable(Bool),
            security_metadata String,
            provider LowCardinality(String),
            synced_at DateTime64(3, 'UTC')
        )
        ENGINE = ReplacingMergeTree(synced_at)
        PARTITION BY toYYYYMM(trade_date)
        ORDER BY (universe_id, symbol, timeframe, adjustment, trade_date)
        """,
    )
    _command(
        f"""
        CREATE TABLE IF NOT EXISTS {factors_table}
        (
            universe_id LowCardinality(String),
            symbol String,
            trade_date Date,
            factor_key LowCardinality(String),
            factor_value Float64,
            provider LowCardinality(String),
            metadata String,
            synced_at DateTime64(3, 'UTC')
        )
        ENGINE = ReplacingMergeTree(synced_at)
        PARTITION BY toYYYYMM(trade_date)
        ORDER BY (universe_id, factor_key, trade_date, symbol)
        """,
    )


async def initialize_clickhouse() -> None:
    await asyncio.to_thread(_initialize_clickhouse_sync)


def _json_string(value: Any) -> str:
    if isinstance(value, str):
        return value
    return json.dumps(value or {}, ensure_ascii=False, default=str, sort_keys=True)


def _date_value(value: Any) -> date:
    if isinstance(value, date) and not isinstance(value, datetime):
        return value
    if isinstance(value, datetime):
        return value.date()
    return date.fromisoformat(str(value))


def _decimal_value(value: Any, default: str = "0") -> Decimal:
    if value is None:
        return Decimal(default)
    return value if isinstance(value, Decimal) else Decimal(str(value))


def _bar_tuple(row: dict[str, Any], synced_at: datetime) -> tuple[Any, ...]:
    return (
        str(row.get("universe_id") or ""),
        str(row.get("symbol") or ""),
        str(row.get("code") or ""),
        row.get("name"),
        str(row.get("exchange") or "UNKNOWN"),
        str(row.get("asset_type") or "stock"),
        _date_value(row.get("trade_date")),
        str(row.get("timeframe") or "daily"),
        str(row.get("adjustment") or "qfq"),
        _decimal_value(row.get("open")),
        _decimal_value(row.get("high")),
        _decimal_value(row.get("low")),
        _decimal_value(row.get("close")),
        row.get("previous_close"),
        _decimal_value(row.get("volume")),
        row.get("amount"),
        row.get("amplitude"),
        row.get("change_percent"),
        row.get("change_amount"),
        row.get("turnover"),
        row.get("trade_status"),
        row.get("is_st"),
        row.get("limit_up"),
        row.get("limit_down"),
        _json_string(row.get("security_metadata")),
        str(row.get("provider") or "unknown"),
        synced_at,
    )


def _chunks(values: list[tuple[Any, ...]], size: int) -> Iterable[list[tuple[Any, ...]]]:
    for index in range(0, len(values), size):
        yield values[index : index + size]


def _insert_daily_bars_sync(rows: list[dict[str, Any]]) -> int:
    if not rows:
        return 0
    synced_at = datetime.now(UTC)
    prepared = [_bar_tuple(row, synced_at) for row in rows]
    table = _table_name(DAILY_BARS_TABLE)
    written = 0
    client = _client()
    try:
        for chunk in _chunks(prepared, SYNC_BATCH_SIZE):
            client.insert(table, chunk, column_names=DAILY_BAR_COLUMNS)
            written += len(chunk)
    finally:
        _close_client(client)
    return written


async def insert_daily_bars(rows: list[dict[str, Any]]) -> int:
    return await asyncio.to_thread(_insert_daily_bars_sync, rows)


def _delete_daily_bars_sync(
    *,
    universe_id: str,
    start: date | None,
    end: date | None,
    timeframe: str,
    adjustment: str,
) -> None:
    table = _table_name(DAILY_BARS_TABLE)
    clauses = [
        "universe_id = {universe_id:String}",
        "timeframe = {timeframe:String}",
        "adjustment = {adjustment:String}",
    ]
    parameters: dict[str, Any] = {
        "universe_id": universe_id,
        "timeframe": timeframe,
        "adjustment": adjustment,
    }
    if start is not None:
        clauses.append("trade_date >= {start:Date}")
        parameters["start"] = start
    if end is not None:
        clauses.append("trade_date <= {end:Date}")
        parameters["end"] = end
    _command(
        f"""
        ALTER TABLE {table}
        DELETE WHERE {" AND ".join(clauses)}
        SETTINGS mutations_sync = 1
        """,
        parameters,
    )


async def delete_daily_bars(
    *,
    universe_id: str,
    start: date | None = None,
    end: date | None = None,
    timeframe: str = "daily",
    adjustment: str = "qfq",
) -> None:
    await asyncio.to_thread(
        _delete_daily_bars_sync,
        universe_id=universe_id,
        start=start,
        end=end,
        timeframe=timeframe,
        adjustment=adjustment,
    )


def _parse_metadata(row: dict[str, Any]) -> dict[str, Any]:
    metadata = row.get("security_metadata")
    if isinstance(metadata, str):
        try:
            row["security_metadata"] = json.loads(metadata)
        except json.JSONDecodeError:
            row["security_metadata"] = {}
    elif metadata is None:
        row["security_metadata"] = {}

    if row.get("latest_limit_up_date") == date(1970, 1, 1):
        row["latest_limit_up_date"] = None
    return row


def _resolve_screener_trade_date_sync(
    *,
    universe_id: str,
    trade_date: date | None,
    timeframe: str,
    adjustment: str,
) -> date | None:
    if trade_date is None:
        rows = _query_rows(
            """
            SELECT max(trade_date) AS resolved_trade_date
            FROM quant_bars_daily
            WHERE universe_id = {universe_id:String}
              AND timeframe = {timeframe:String}
              AND adjustment = {adjustment:String}
              AND asset_type = 'stock'
            """,
            {
                "universe_id": universe_id,
                "timeframe": timeframe,
                "adjustment": adjustment,
            },
        )
    else:
        rows = _query_rows(
            """
            SELECT max(trade_date) AS resolved_trade_date
            FROM quant_bars_daily
            WHERE universe_id = {universe_id:String}
              AND timeframe = {timeframe:String}
              AND adjustment = {adjustment:String}
              AND asset_type = 'stock'
              AND trade_date <= {trade_date:Date}
            """,
            {
                "universe_id": universe_id,
                "timeframe": timeframe,
                "adjustment": adjustment,
                "trade_date": trade_date,
            },
        )
    value = rows[0]["resolved_trade_date"] if rows else None
    return _date_value(value) if value else None


def _screener_feature_cache_key(
    *,
    universe_id: str,
    trade_date: date,
    timeframe: str,
    adjustment: str,
) -> tuple[str, str, str, str]:
    return (universe_id, trade_date.isoformat(), timeframe, adjustment)


def _screener_feature_cache_get(
    key: tuple[str, str, str, str],
) -> list[dict[str, Any]] | None:
    cached = _SCREENER_FEATURE_ROWS_CACHE.get(key)
    if cached is None:
        return None
    cached_at, rows = cached
    if datetime.now(UTC) - cached_at > timedelta(seconds=SCREENER_FEATURE_CACHE_TTL_SECONDS):
        _SCREENER_FEATURE_ROWS_CACHE.pop(key, None)
        return None
    return [row.copy() for row in rows]


def _screener_feature_cache_set(
    key: tuple[str, str, str, str],
    rows: list[dict[str, Any]],
) -> None:
    if SCREENER_FEATURE_CACHE_TTL_SECONDS <= 0 or not rows:
        return
    _SCREENER_FEATURE_ROWS_CACHE[key] = (datetime.now(UTC), [row.copy() for row in rows])
    if len(_SCREENER_FEATURE_ROWS_CACHE) > 16:
        oldest_key = min(
            _SCREENER_FEATURE_ROWS_CACHE.items(),
            key=lambda item: item[1][0],
        )[0]
        _SCREENER_FEATURE_ROWS_CACHE.pop(oldest_key, None)


def _query_screener_feature_rows_sync(
    *,
    universe_id: str,
    trade_date: date,
    timeframe: str,
    adjustment: str,
) -> list[dict[str, Any]]:
    rows = _query_rows(
        """
        WITH
          {trade_date:Date} AS target_date,
          target_date - 260 AS start_date,
          toDate('1970-01-01') AS empty_limit_up_date
        SELECT
          feature_rows.*,
          count(*) OVER () AS scanned_symbols
        FROM (
          SELECT
            symbol,
            bars[1].2 AS code,
            bars[1].3 AS name,
            bars[1].4 AS exchange,
            bars[1].5 AS security_metadata,
            length(bars) AS sample_count,
            bars[1].1 AS latest_trade_date,
            bars[1].6 AS latest_provider,
            bars[1].7 AS latest_open,
            bars[1].8 AS latest_high,
            bars[1].9 AS latest_low,
            bars[1].10 AS latest_close,
            bars[1].11 AS previous_close,
            bars[1].12 AS latest_amount,
            bars[1].13 AS latest_turnover,
            bars[1].14 AS latest_change_percent,
            if(length(bars) > 1, bars[2].14, NULL) AS previous_change_percent,
            coalesce(bars[1].15, false) AS latest_limit_up,
            coalesce(bars[1].16, false) AS latest_is_st,
            arrayAvg(x -> toFloat64(x.10), arraySlice(bars, 1, 5)) AS ma5,
            arrayAvg(x -> toFloat64(x.10), arraySlice(bars, 1, 10)) AS ma10,
            arrayAvg(x -> toFloat64(x.10), arraySlice(bars, 1, 20)) AS ma20,
            arrayAvg(x -> toFloat64(x.10), arraySlice(bars, 1, 30)) AS ma30,
            arrayAvg(x -> toFloat64(x.10), arraySlice(bars, 1, 60)) AS ma60,
            if(
              empty(arrayFilter(x -> isNotNull(x.12), arraySlice(bars, 1, 20))),
              NULL,
              arrayAvg(
                x -> toFloat64(assumeNotNull(x.12)),
                arrayFilter(x -> isNotNull(x.12), arraySlice(bars, 1, 20))
              )
            ) AS avg_amount_20d,
            if(length(bars) > 20, bars[21].10, NULL) AS close_20d,
            arrayCount(x -> coalesce(x.15, false), arraySlice(bars, 1, 4))
              AS limit_up_count_4d,
            arrayCount(x -> coalesce(x.15, false), arraySlice(bars, 1, 10))
              AS limit_up_count_10d,
            arrayMax(
              arrayMap(
                x -> if(coalesce(x.15, false), x.1, empty_limit_up_date),
                arraySlice(bars, 1, 10)
              )
            ) AS latest_limit_up_date,
            target_date AS requested_trade_date
          FROM (
            SELECT
              symbol,
              arraySlice(
                arrayReverseSort(
                  x -> x.1,
                  groupArray((
                    trade_date,
                    code,
                    name,
                    exchange,
                    security_metadata,
                    provider,
                    open,
                    high,
                    low,
                    close,
                    previous_close,
                    amount,
                    turnover,
                    change_percent,
                    limit_up,
                    is_st
                  ))
                ),
                1,
                60
              ) AS bars
            FROM (
              SELECT
                symbol,
                code,
                name,
                exchange,
                security_metadata,
                trade_date,
                provider,
                open,
                high,
                low,
                close,
                previous_close,
                amount,
                turnover,
                change_percent,
                limit_up,
                is_st
              FROM (
                SELECT
                  symbol,
                  code,
                  name,
                  exchange,
                  security_metadata,
                  trade_date,
                  provider,
                  open,
                  high,
                  low,
                  close,
                  previous_close,
                  amount,
                  turnover,
                  change_percent,
                  limit_up,
                  is_st,
                  row_number() OVER (
                    PARTITION BY symbol, trade_date
                    ORDER BY synced_at DESC
                  ) AS daily_rank
                FROM quant_bars_daily
                WHERE universe_id = {universe_id:String}
                  AND timeframe = {timeframe:String}
                  AND adjustment = {adjustment:String}
                  AND asset_type = 'stock'
                  AND exchange != 'BJ'
                  AND NOT startsWith(code, '688')
                  AND NOT startsWith(code, '8')
                  AND NOT startsWith(code, '4')
                  AND positionCaseInsensitiveUTF8(coalesce(name, ''), 'ST') = 0
                  AND trade_date >= start_date
                  AND trade_date <= target_date
              ) daily_latest
              WHERE daily_rank = 1
            ) deduplicated
            GROUP BY symbol
          ) grouped
          WHERE bars[1].1 = target_date
            AND coalesce(bars[1].16, false) = false
            AND coalesce(bars[1].15, false) = false
            AND isNotNull(bars[1].10)
            AND length(bars) >= 20
        ) feature_rows
        """,
        {
            "universe_id": universe_id,
            "trade_date": trade_date,
            "timeframe": timeframe,
            "adjustment": adjustment,
        },
    )
    return [_parse_metadata(row) for row in rows]


async def query_screener_feature_rows(
    *,
    universe_id: str,
    trade_date: date | None,
    timeframe: str = "daily",
    adjustment: str = "qfq",
) -> tuple[date | None, list[dict[str, Any]]]:
    resolved_trade_date = await asyncio.to_thread(
        _resolve_screener_trade_date_sync,
        universe_id=universe_id,
        trade_date=trade_date,
        timeframe=timeframe,
        adjustment=adjustment,
    )
    if resolved_trade_date is None:
        return None, []
    cache_key = _screener_feature_cache_key(
        universe_id=universe_id,
        trade_date=resolved_trade_date,
        timeframe=timeframe,
        adjustment=adjustment,
    )
    cached_rows = _screener_feature_cache_get(cache_key)
    if cached_rows is not None:
        return resolved_trade_date, cached_rows
    rows = await asyncio.to_thread(
        _query_screener_feature_rows_sync,
        universe_id=universe_id,
        trade_date=resolved_trade_date,
        timeframe=timeframe,
        adjustment=adjustment,
    )
    _screener_feature_cache_set(cache_key, rows)
    return resolved_trade_date, rows
