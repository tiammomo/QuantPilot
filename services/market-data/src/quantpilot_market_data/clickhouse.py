from __future__ import annotations

import asyncio
import json
import os
import re
from collections.abc import Iterable
from dataclasses import dataclass
from datetime import UTC, date, datetime
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
        return ClickHouseHealthResponse(
            enabled=True,
            status="ok",
            host=config.host,
            port=config.port,
            database=config.database,
            server_version=str(rows[0]["server_version"]) if rows else None,
            tables={str(row["name"]): int(row["total_rows"] or 0) for row in table_rows},
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
          target_date - 260 AS start_date
        SELECT
          features.*,
          target_date AS requested_trade_date,
          count() OVER () AS scanned_symbols
        FROM
        (
          SELECT
            symbol,
            anyIf(code, rn = 1) AS code,
            anyIf(name, rn = 1) AS name,
            anyIf(exchange, rn = 1) AS exchange,
            anyIf(security_metadata, rn = 1) AS security_metadata,
            count() AS sample_count,
            anyIf(trade_date, rn = 1) AS latest_trade_date,
            anyIf(provider, rn = 1) AS latest_provider,
            anyIf(open, rn = 1) AS latest_open,
            anyIf(high, rn = 1) AS latest_high,
            anyIf(low, rn = 1) AS latest_low,
            anyIf(close, rn = 1) AS latest_close,
            anyIf(previous_close, rn = 1) AS previous_close,
            anyIf(amount, rn = 1) AS latest_amount,
            anyIf(turnover, rn = 1) AS latest_turnover,
            anyIf(change_percent, rn = 1) AS latest_change_percent,
            anyIf(change_percent, rn = 2) AS previous_change_percent,
            maxIf(toUInt8(coalesce(limit_up, false)), rn = 1) AS latest_limit_up,
            maxIf(toUInt8(coalesce(is_st, false)), rn = 1) AS latest_is_st,
            avgIf(close, rn <= 5) AS ma5,
            avgIf(close, rn <= 10) AS ma10,
            avgIf(close, rn <= 20) AS ma20,
            avgIf(close, rn <= 30) AS ma30,
            avgIf(close, rn <= 60) AS ma60,
            avgIf(amount, rn <= 20 AND amount IS NOT NULL) AS avg_amount_20d,
            anyIf(close, rn = 21) AS close_20d,
            countIf(rn <= 4 AND coalesce(limit_up, false)) AS limit_up_count_4d,
            countIf(rn <= 10 AND coalesce(limit_up, false)) AS limit_up_count_10d,
            maxIf(trade_date, rn <= 10 AND coalesce(limit_up, false)) AS latest_limit_up_date
          FROM
          (
            SELECT
              *,
              row_number() OVER (PARTITION BY symbol ORDER BY trade_date DESC) AS rn
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
          ) recent_bars
          GROUP BY symbol
        ) features
        WHERE latest_trade_date = target_date
          AND latest_is_st = 0
          AND latest_limit_up = 0
          AND latest_close IS NOT NULL
          AND sample_count >= 20
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
    rows = await asyncio.to_thread(
        _query_screener_feature_rows_sync,
        universe_id=universe_id,
        trade_date=resolved_trade_date,
        timeframe=timeframe,
        adjustment=adjustment,
    )
    return resolved_trade_date, rows
