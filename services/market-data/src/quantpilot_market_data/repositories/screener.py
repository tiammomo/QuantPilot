from __future__ import annotations

from datetime import UTC, date, datetime, timedelta
from decimal import Decimal
from typing import Any, Literal

from psycopg.rows import dict_row

from quantpilot_market_data.cache import RedisJsonCache, ttl_from_env
from quantpilot_market_data.clickhouse import (
    is_clickhouse_enabled,
    query_screener_feature_rows,
)
from quantpilot_market_data.database_core import (
    bool_or_none,
    connect,
    decimal_or_none,
    decimal_ratio,
    percent_change,
    security_sector_fields,
)
from quantpilot_market_data.models import (
    AnalyticsExecutionMetadata,
    AShareScreenerCandidate,
    AShareScreenerResponse,
    ScreenerMode,
)
from quantpilot_market_data.repositories.analytics import sync_clickhouse_daily_bars

DEFAULT_UNIVERSE_ID = "a-share-sample-research-pool"
SCREENER_CACHE_TTL_SECONDS = ttl_from_env("QUANTPILOT_SCREENER_CACHE_TTL_SECONDS", 60)
_SCREENER_CACHE: dict[tuple[str, str, str, int], tuple[datetime, AShareScreenerResponse]] = {}
_SCREENER_TRADE_DATE_CACHE: dict[tuple[str, str], tuple[datetime, date | None]] = {}
_SCREENER_REDIS_CACHE = RedisJsonCache()
SAFE_TRADE_STATUSES = {"1", "active", "normal", "trading", "正常", "正常交易"}
SCREENER_MIN_SAFETY_COVERAGE_PCT = 95.0

__all__ = ["screen_a_share_short_term_candidates"]


def _screener_missing_fields(row: dict[str, Any]) -> list[str]:
    required = {
        "close": row.get("latest_close"),
        "open": row.get("latest_open"),
        "previous_close": row.get("previous_close"),
        "amount": row.get("latest_amount"),
        "turnover": row.get("latest_turnover"),
        "ma5": row.get("ma5"),
        "ma10": row.get("ma10"),
        "ma20": row.get("ma20"),
        "ma30": row.get("ma30"),
        "ma60": row.get("ma60"),
        "trade_status": row.get("latest_trade_status"),
        "is_st": row.get("latest_is_st"),
        "limit_up": row.get("latest_limit_up"),
        "limit_down": row.get("latest_limit_down"),
    }
    return [key for key, value in required.items() if value is None]


def _is_known_tradable(row: dict[str, Any]) -> bool:
    """Unknown safety flags are unsafe: only an explicit normal state may execute."""
    status = str(row.get("latest_trade_status") or "").strip().lower()
    return bool(
        bool_or_none(row.get("latest_is_st")) is False
        and bool_or_none(row.get("latest_limit_up")) is False
        and bool_or_none(row.get("latest_limit_down")) is False
        and status in SAFE_TRADE_STATUSES
    )


def _row_trade_date(value: Any) -> date | None:
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    if value in {None, ""}:
        return None
    try:
        return date.fromisoformat(str(value))
    except ValueError:
        return None


def _safety_fields_complete(row: dict[str, Any]) -> bool:
    status = row.get("latest_trade_status")
    return bool(
        row.get("latest_is_st") is not None
        and row.get("latest_limit_up") is not None
        and row.get("latest_limit_down") is not None
        and status is not None
        and str(status).strip()
    )


def _screener_exclusion_reasons(
    row: dict[str, Any],
    *,
    target_trade_date: date,
) -> list[str]:
    reasons: list[str] = []
    code = str(row.get("code") or "")
    name = str(row.get("name") or "")
    exchange = str(row.get("exchange") or "UNKNOWN").upper()
    latest_trade_date = _row_trade_date(row.get("latest_trade_date"))
    if exchange == "BJ":
        reasons.append("unsupported_exchange")
    if code.startswith(("688", "8", "4")):
        reasons.append("unsupported_board")
    if "ST" in name.upper():
        reasons.append("name_st_marker")
    if latest_trade_date is None:
        reasons.append("missing_latest_bar")
    elif latest_trade_date != target_trade_date:
        reasons.append("stale_latest_bar")
    if int(row.get("sample_count") or 0) < 20:
        reasons.append("insufficient_history")
    if row.get("latest_close") is None:
        reasons.append("missing_close")

    is_st = bool_or_none(row.get("latest_is_st"))
    limit_up = bool_or_none(row.get("latest_limit_up"))
    limit_down = bool_or_none(row.get("latest_limit_down"))
    trade_status = str(row.get("latest_trade_status") or "").strip().lower()
    if row.get("latest_is_st") is None:
        reasons.append("missing_is_st")
    elif is_st is True:
        reasons.append("is_st")
    if row.get("latest_limit_up") is None:
        reasons.append("missing_limit_up")
    elif limit_up is True:
        reasons.append("is_limit_up")
    if row.get("latest_limit_down") is None:
        reasons.append("missing_limit_down")
    elif limit_down is True:
        reasons.append("is_limit_down")
    if not trade_status:
        reasons.append("missing_trade_status")
    elif trade_status not in SAFE_TRADE_STATUSES:
        reasons.append("unsafe_trade_status")
    return reasons


def _merge_feature_rows_with_members(
    rows: list[dict[str, Any]],
    members: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    rows_by_symbol = {str(row.get("symbol")): dict(row) for row in rows}
    merged: list[dict[str, Any]] = []
    for member in members:
        symbol = str(member["symbol"])
        row = rows_by_symbol.pop(symbol, {})
        merged.append(
            {
                **row,
                "symbol": symbol,
                "code": row.get("code") or member.get("code") or symbol.split(".", 1)[0],
                "name": row.get("name") or member.get("name"),
                "exchange": row.get("exchange") or member.get("exchange") or "UNKNOWN",
                "security_metadata": row.get("security_metadata")
                or member.get("security_metadata")
                or {},
            }
        )
    return merged


def _screener_coverage(
    rows: list[dict[str, Any]],
    *,
    total_symbols: int,
    target_trade_date: date,
) -> tuple[list[dict[str, Any]], dict[str, int], int, float, str | None]:
    eligible_rows: list[dict[str, Any]] = []
    excluded_reasons: dict[str, int] = {}
    safety_complete_symbols = 0
    for row in rows:
        if _safety_fields_complete(row):
            safety_complete_symbols += 1
        reasons = _screener_exclusion_reasons(
            row,
            target_trade_date=target_trade_date,
        )
        if not reasons:
            eligible_rows.append(row)
        for reason in set(reasons):
            excluded_reasons[reason] = excluded_reasons.get(reason, 0) + 1

    safety_coverage_pct = (
        round(safety_complete_symbols / total_symbols * 100, 2) if total_symbols else 0.0
    )
    coverage_warning = None
    if total_symbols and safety_coverage_pct < SCREENER_MIN_SAFETY_COVERAGE_PCT:
        coverage_warning = (
            f"交易安全字段仅覆盖 {safety_complete_symbols}/{total_symbols} 个标的"
            f"（{safety_coverage_pct:.2f}%），低于 {SCREENER_MIN_SAFETY_COVERAGE_PCT:.0f}% "
            "可用阈值；未知状态已按不可交易排除，请先完成正式日线字段增强。"
        )
    return (
        eligible_rows,
        dict(sorted(excluded_reasons.items())),
        safety_complete_symbols,
        safety_coverage_pct,
        coverage_warning,
    )


def _screener_score(row: dict[str, Any]) -> Decimal:
    close = decimal_or_none(row.get("latest_close"))
    open_price = decimal_or_none(row.get("latest_open"))
    previous_close = decimal_or_none(row.get("previous_close"))
    amount = decimal_or_none(row.get("latest_amount"))
    avg_amount_20d = decimal_or_none(row.get("avg_amount_20d"))
    strength_20d = percent_change(close, decimal_or_none(row.get("close_20d")))
    amount_ratio = decimal_ratio(amount, avg_amount_20d)
    ma5 = decimal_or_none(row.get("ma5"))
    ma10 = decimal_or_none(row.get("ma10"))
    ma20 = decimal_or_none(row.get("ma20"))
    ma30 = decimal_or_none(row.get("ma30"))
    ma60 = decimal_or_none(row.get("ma60"))
    latest_change = decimal_or_none(row.get("latest_change_percent"))
    previous_change = decimal_or_none(row.get("previous_change_percent"))
    limit_up_count_4d = int(row.get("limit_up_count_4d") or 0)
    limit_up_count_10d = int(row.get("limit_up_count_10d") or 0)
    score = Decimal("0")

    if (
        all(value is not None for value in (ma5, ma10, ma20, ma30, ma60))
        and ma5 >= ma10 >= ma20 >= ma30 >= ma60
    ):
        score += Decimal("28")
    elif (
        all(value is not None for value in (ma5, ma10, ma20, ma60))
        and ma5 >= ma10 >= ma20 >= ma60
    ):
        score += Decimal("20")
    if close is not None and ma5 is not None and close >= ma5:
        score += Decimal("12")
        distance = decimal_ratio(close, ma5)
        if distance is not None and distance > Decimal("1.12"):
            score -= Decimal("6")
    if strength_20d is not None:
        score += max(Decimal("0"), min(Decimal("18"), strength_20d / Decimal("2")))
    if amount_ratio is not None:
        score += max(Decimal("0"), min(Decimal("16"), amount_ratio * Decimal("5")))
    if latest_change is not None and latest_change > 0:
        score += Decimal("8")
    if open_price is not None and previous_close is not None and open_price > previous_close:
        score += Decimal("6")
    if previous_change is not None and previous_change >= 0:
        score += Decimal("4")
    if limit_up_count_4d > 0:
        score += Decimal("10")
    elif limit_up_count_10d > 0:
        score += Decimal("5")
    return score.quantize(Decimal("0.01"))


def _screener_signals(row: dict[str, Any]) -> list[str]:
    close = decimal_or_none(row.get("latest_close"))
    open_price = decimal_or_none(row.get("latest_open"))
    previous_close = decimal_or_none(row.get("previous_close"))
    amount = decimal_or_none(row.get("latest_amount"))
    avg_amount_20d = decimal_or_none(row.get("avg_amount_20d"))
    amount_ratio = decimal_ratio(amount, avg_amount_20d)
    ma5 = decimal_or_none(row.get("ma5"))
    ma10 = decimal_or_none(row.get("ma10"))
    ma20 = decimal_or_none(row.get("ma20"))
    ma30 = decimal_or_none(row.get("ma30"))
    ma60 = decimal_or_none(row.get("ma60"))
    latest_change = decimal_or_none(row.get("latest_change_percent"))
    previous_change = decimal_or_none(row.get("previous_change_percent"))
    limit_up_count_4d = int(row.get("limit_up_count_4d") or 0)
    signals: list[str] = []
    if limit_up_count_4d > 0:
        signals.append("近4日出现涨停")
    if (
        all(value is not None for value in (ma5, ma10, ma20, ma30, ma60))
        and ma5 >= ma10 >= ma20 >= ma30 >= ma60
    ):
        signals.append("MA5/10/20/30/60 多头排列")
    if close is not None and ma5 is not None and close >= ma5:
        signals.append("收盘价站上 MA5")
    if open_price is not None and previous_close is not None and open_price > previous_close:
        signals.append("今日高开")
    if latest_change is not None and latest_change > 0:
        signals.append("今日上涨")
    if previous_change is not None and previous_change >= 0:
        signals.append("前一日未下跌")
    if amount_ratio is not None and amount_ratio >= Decimal("1.2"):
        signals.append("成交额较20日均额放大")
    return signals


def _screener_warnings(row: dict[str, Any]) -> list[str]:
    warnings: list[str] = []
    if int(row.get("sample_count") or 0) < 60:
        warnings.append("样本不足 60 根日 K，MA60 稳定性较弱")
    if bool_or_none(row.get("latest_limit_up")) is True:
        warnings.append("当日涨停，可能无法合理买入")
    if decimal_or_none(row.get("latest_amount")) is None:
        warnings.append("缺少成交额，流动性判断不完整")
    if decimal_or_none(row.get("latest_turnover")) is None:
        warnings.append("缺少换手率")
    return warnings


def _screener_cache_key(
    *,
    universe_id: str,
    trade_date: date,
    mode: ScreenerMode,
    limit: int,
) -> tuple[str, str, str, int]:
    return (universe_id, trade_date.isoformat(), mode, limit)


def _screener_trade_date_cache_key(
    *,
    universe_id: str,
    trade_date: date | None,
) -> tuple[str, str]:
    return (universe_id, trade_date.isoformat() if trade_date else "latest")


def _screener_trade_date_cache_get(
    key: tuple[str, str],
) -> tuple[bool, date | None]:
    cached = _SCREENER_TRADE_DATE_CACHE.get(key)
    if not cached:
        return False, None
    cached_at, value = cached
    if datetime.now(UTC) - cached_at > timedelta(seconds=SCREENER_CACHE_TTL_SECONDS):
        _SCREENER_TRADE_DATE_CACHE.pop(key, None)
        return False, None
    return True, value


def _screener_trade_date_cache_set(
    key: tuple[str, str],
    value: date | None,
) -> None:
    if SCREENER_CACHE_TTL_SECONDS <= 0:
        return
    _SCREENER_TRADE_DATE_CACHE[key] = (datetime.now(UTC), value)
    if len(_SCREENER_TRADE_DATE_CACHE) > 64:
        oldest_key = min(_SCREENER_TRADE_DATE_CACHE.items(), key=lambda item: item[1][0])[0]
        _SCREENER_TRADE_DATE_CACHE.pop(oldest_key, None)


def _screener_cached_response(
    response: AShareScreenerResponse,
    cache_status: str,
) -> AShareScreenerResponse:
    return response.model_copy(
        update={
            "cache_status": cache_status,
            "cache_ttl_seconds": SCREENER_CACHE_TTL_SECONDS,
            "fetched_at": datetime.now(UTC),
        }
    )


def _screener_cache_get(
    key: tuple[str, str, str, int],
) -> AShareScreenerResponse | None:
    cached = _SCREENER_CACHE.get(key)
    if not cached:
        return None
    cached_at, response = cached
    if datetime.now(UTC) - cached_at > timedelta(seconds=SCREENER_CACHE_TTL_SECONDS):
        _SCREENER_CACHE.pop(key, None)
        return None
    return _screener_cached_response(response, "hit")


def _screener_cache_set(
    key: tuple[str, str, str, int],
    response: AShareScreenerResponse,
) -> None:
    if SCREENER_CACHE_TTL_SECONDS <= 0:
        return
    _SCREENER_CACHE[key] = (datetime.now(UTC), response)
    if len(_SCREENER_CACHE) > 64:
        oldest_key = min(_SCREENER_CACHE.items(), key=lambda item: item[1][0])[0]
        _SCREENER_CACHE.pop(oldest_key, None)


def _screener_cached_response_is_usable(response: AShareScreenerResponse) -> bool:
    if response.scanned_symbols != response.total_symbols:
        return False
    if (
        response.total_symbols > response.eligible_symbols
        and not response.excluded_reasons
    ):
        return False
    if any(
        candidate.is_st is not False
        or candidate.is_limit_up is not False
        or candidate.is_limit_down is not False
        or str(candidate.trade_status or "").strip().lower() not in SAFE_TRADE_STATUSES
        for candidate in response.candidates
    ):
        return False
    if not is_clickhouse_enabled():
        return response.data_basis.startswith("timescaledb.")
    return response.data_basis.startswith("clickhouse.")


def _screener_redis_key(key: tuple[str, str, str, int]) -> str:
    return _SCREENER_REDIS_CACHE.key(
        ":".join(str(part) for part in ("screener-v2", *key))
    )


async def _screener_redis_get(
    key: tuple[str, str, str, int],
) -> AShareScreenerResponse | None:
    payload = await _SCREENER_REDIS_CACHE.read(_screener_redis_key(key))
    if payload is None:
        return None
    try:
        response = AShareScreenerResponse.model_validate(payload)
    except (TypeError, ValueError):
        return None
    return _screener_cached_response(response, "redis-hit")


async def _screener_redis_set(
    key: tuple[str, str, str, int],
    response: AShareScreenerResponse,
) -> None:
    await _SCREENER_REDIS_CACHE.write(
        _screener_redis_key(key),
        ttl_seconds=SCREENER_CACHE_TTL_SECONDS,
        payload=response.model_dump(mode="json"),
    )


async def screen_a_share_short_term_candidates(
    *,
    universe_id: str = DEFAULT_UNIVERSE_ID,
    trade_date: date | None = None,
    mode: ScreenerMode = "short_term",
    limit: int = 20,
) -> AShareScreenerResponse:
    safe_limit = max(1, min(limit, 100))
    resolved_trade_date = trade_date
    requested_trade_date_input = trade_date
    trade_date_cache_key = _screener_trade_date_cache_key(
        universe_id=universe_id,
        trade_date=trade_date,
    )
    trade_date_cache_hit, cached_trade_date = _screener_trade_date_cache_get(trade_date_cache_key)
    if trade_date_cache_hit and cached_trade_date is not None:
        cache_key = _screener_cache_key(
            universe_id=universe_id,
            trade_date=cached_trade_date,
            mode=mode,
            limit=safe_limit,
        )
        cached = _screener_cache_get(cache_key)
        if cached is not None and _screener_cached_response_is_usable(cached):
            return cached
        cached = await _screener_redis_get(cache_key)
        if cached is not None and _screener_cached_response_is_usable(cached):
            _screener_cache_set(cache_key, cached)
            return cached

    async with await connect() as connection, connection.cursor(row_factory=dict_row) as cursor:
        await cursor.execute(
            """
            SELECT
              securities.symbol,
              securities.code,
              securities.name,
              securities.exchange,
              securities.metadata AS security_metadata
            FROM quant.security_universe_members members
            JOIN quant.securities securities
              ON securities.symbol = members.symbol
            WHERE members.universe_id = %s
              AND securities.asset_type = 'stock'
              AND COALESCE(members.role, 'member') <> 'inactive'
              AND COALESCE(securities.status, 'active') NOT IN ('inactive', 'delisted')
            ORDER BY securities.symbol
            """,
            (universe_id,),
        )
        universe_members = [dict(row) for row in await cursor.fetchall()]
        total_symbols = len(universe_members)

        if trade_date_cache_hit:
            resolved_trade_date = cached_trade_date
        else:
            if resolved_trade_date is None:
                await cursor.execute(
                    """
                    WITH universe_config AS (
                      SELECT
                        id,
                        COALESCE(metadata->>'default_timeframe', 'daily') AS timeframe,
                        COALESCE(metadata->>'default_adjustment', 'qfq') AS adjustment
                      FROM quant.security_universes
                      WHERE id = %s
                    ),
                    target_members AS (
                      SELECT
                        members.symbol,
                        universe_config.timeframe,
                        universe_config.adjustment
                      FROM quant.security_universe_members members
                      JOIN universe_config
                        ON universe_config.id = members.universe_id
                      JOIN quant.securities securities
                        ON securities.symbol = members.symbol
                      WHERE members.universe_id = %s
                        AND securities.asset_type = 'stock'
                        AND COALESCE(members.role, 'member') <> 'inactive'
                        AND COALESCE(securities.status, 'active') NOT IN (
                          'inactive',
                          'delisted'
                        )
                    )
                    SELECT max((bars.ts AT TIME ZONE 'Asia/Shanghai')::date)
                      AS trade_date
                    FROM target_members
                    JOIN quant.canonical_stock_bars bars
                      ON bars.symbol = target_members.symbol
                     AND bars.timeframe = target_members.timeframe
                     AND bars.adjustment = target_members.adjustment
                    """,
                    (universe_id, universe_id),
                )
                target_row = await cursor.fetchone()
                resolved_trade_date = target_row["trade_date"] if target_row else None

            if requested_trade_date_input is not None or resolved_trade_date is None:
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
                    SELECT max((bars.ts AT TIME ZONE 'Asia/Shanghai')::date) AS trade_date
                    FROM quant.security_universe_members members
                    JOIN universe_config
                      ON universe_config.id = members.universe_id
                    JOIN quant.securities securities
                      ON securities.symbol = members.symbol
                    JOIN quant.canonical_stock_bars bars
                      ON bars.symbol = members.symbol
                     AND bars.timeframe = universe_config.timeframe
                     AND bars.adjustment = universe_config.adjustment
                    WHERE members.universe_id = %s
                      AND securities.asset_type = 'stock'
                      AND COALESCE(members.role, 'member') <> 'inactive'
                      AND COALESCE(securities.status, 'active') NOT IN ('inactive', 'delisted')
                      AND (
                        %s::date IS NULL
                        OR bars.ts < ((%s::date + 1)::timestamp AT TIME ZONE 'Asia/Shanghai')
                      )
                    """,
                    (universe_id, universe_id, resolved_trade_date, resolved_trade_date),
                )
                target_row = await cursor.fetchone()
                resolved_trade_date = target_row["trade_date"] if target_row else None
            _screener_trade_date_cache_set(trade_date_cache_key, resolved_trade_date)

        if resolved_trade_date is None:
            coverage_warning = (
                f"股票池包含 {total_symbols} 个活跃股票，但没有任何正式日线可供筛选。"
                if total_symbols
                else "股票池没有可扫描的活跃股票。"
            )
            return AShareScreenerResponse(
                universe_id=universe_id,
                mode=mode,
                trade_date=None,
                scanned_symbols=total_symbols,
                total_symbols=total_symbols,
                eligible_symbols=0,
                excluded_reasons={"missing_latest_bar": total_symbols}
                if total_symbols
                else {},
                safety_complete_symbols=0,
                safety_coverage_pct=0,
                coverage_warning=coverage_warning,
                limit=safe_limit,
                candidates=[],
                notes=["本地股票池尚未找到可筛选的交易日。"],
            )

        cache_key = _screener_cache_key(
            universe_id=universe_id,
            trade_date=resolved_trade_date,
            mode=mode,
            limit=safe_limit,
        )
        cached = _screener_cache_get(cache_key)
        if cached is not None and _screener_cached_response_is_usable(cached):
            return cached
        cached = await _screener_redis_get(cache_key)
        if cached is not None and _screener_cached_response_is_usable(cached):
            _screener_cache_set(cache_key, cached)
            return cached

        data_basis = "timescaledb.canonical_stock_bars"
        clickhouse_note: str | None = None
        analytics = AnalyticsExecutionMetadata(
            engine="timescaledb",
            status="disabled" if not is_clickhouse_enabled() else "fallback",
            basis=data_basis,
            target_trade_date=resolved_trade_date,
        )
        rows: list[dict[str, Any]] = []
        if is_clickhouse_enabled():
            try:
                clickhouse_trade_date, clickhouse_rows = await query_screener_feature_rows(
                    universe_id=universe_id,
                    trade_date=resolved_trade_date,
                    timeframe="daily",
                    adjustment="qfq",
                )
                auto_sync_status: Literal["not_needed", "synced", "skipped", "error"] = "not_needed"
                auto_sync_rows_written = 0
                if clickhouse_trade_date != resolved_trade_date:
                    sync_start = (
                        resolved_trade_date - timedelta(days=260)
                        if clickhouse_trade_date is None
                        else min(clickhouse_trade_date + timedelta(days=1), resolved_trade_date)
                    )
                    sync_response = await sync_clickhouse_daily_bars(
                        universe_id=universe_id,
                        start=sync_start,
                        end=resolved_trade_date,
                        timeframe="daily",
                        adjustment="qfq",
                        limit=None,
                    )
                    auto_sync_rows_written = sync_response.rows_written
                    if sync_response.status == "ok" and sync_response.rows_written > 0:
                        auto_sync_status = "synced"
                        clickhouse_trade_date, clickhouse_rows = await query_screener_feature_rows(
                            universe_id=universe_id,
                            trade_date=resolved_trade_date,
                            timeframe="daily",
                            adjustment="qfq",
                        )
                        clickhouse_note = (
                            f"ClickHouse 已自动同步 {sync_response.rows_written} 行日线后重试筛选。"
                        )
                    elif sync_response.status == "error":
                        auto_sync_status = "error"
                        clickhouse_note = (
                            "ClickHouse 自动同步失败，已回退 TimescaleDB："
                            f"{sync_response.message}"
                        )
                    else:
                        auto_sync_status = "skipped"
                        clickhouse_note = "ClickHouse 无新增可同步日线，已回退 TimescaleDB。"

                if clickhouse_trade_date == resolved_trade_date and clickhouse_rows:
                    rows = clickhouse_rows
                    data_basis = "clickhouse.quant_bars_daily"
                    analytics = AnalyticsExecutionMetadata(
                        engine="clickhouse",
                        status="hit",
                        basis=data_basis,
                        target_trade_date=resolved_trade_date,
                        clickhouse_trade_date=clickhouse_trade_date,
                        auto_sync_status=auto_sync_status,
                        auto_sync_rows_written=auto_sync_rows_written,
                        message=clickhouse_note or "本次筛选使用 ClickHouse 分析表生成横截面特征。",
                    )
                    clickhouse_note = analytics.message
                elif clickhouse_trade_date == resolved_trade_date:
                    clickhouse_note = "ClickHouse 未返回可用筛选特征，已回退 TimescaleDB。"
                elif clickhouse_trade_date is not None:
                    clickhouse_note = (
                        "ClickHouse 分析表最新交易日为 "
                        f"{clickhouse_trade_date.isoformat()}，"
                        "与 TimescaleDB 目标交易日不一致，已回退 TimescaleDB。"
                    )
                if data_basis.startswith("timescaledb."):
                    analytics = AnalyticsExecutionMetadata(
                        engine="timescaledb",
                        status="fallback",
                        basis=data_basis,
                        target_trade_date=resolved_trade_date,
                        clickhouse_trade_date=clickhouse_trade_date,
                        auto_sync_status=auto_sync_status,
                        auto_sync_rows_written=auto_sync_rows_written,
                        message=clickhouse_note,
                    )
            except Exception as error:
                clickhouse_note = f"ClickHouse 查询失败，已回退 TimescaleDB：{error}"
                analytics = AnalyticsExecutionMetadata(
                    engine="timescaledb",
                    status="error",
                    basis=data_basis,
                    target_trade_date=resolved_trade_date,
                    auto_sync_status="error",
                    message=clickhouse_note,
                )

        if not rows:
            await cursor.execute(
                """
                WITH universe_config AS (
                  SELECT
                    id,
                    COALESCE(metadata->>'default_timeframe', 'daily') AS timeframe,
                    COALESCE(metadata->>'default_adjustment', 'qfq') AS adjustment
                  FROM quant.security_universes
                  WHERE id = %s
                ),
                member_symbols AS (
                  SELECT
                    securities.symbol,
                    securities.code,
                    securities.name,
                    securities.exchange,
                    securities.metadata AS security_metadata,
                    universe_config.timeframe,
                    universe_config.adjustment
                  FROM quant.security_universe_members members
                  JOIN universe_config
                    ON universe_config.id = members.universe_id
                  JOIN quant.securities securities
                    ON securities.symbol = members.symbol
                  WHERE members.universe_id = %s
                    AND securities.asset_type = 'stock'
                    AND COALESCE(members.role, 'member') <> 'inactive'
                    AND COALESCE(securities.status, 'active') NOT IN ('inactive', 'delisted')
                ),
                features AS (
                  SELECT
                    members.symbol,
                    members.code,
                    members.name,
                    members.exchange,
                    members.security_metadata,
                    count(recent_bars.*)::INT AS sample_count,
                    max(recent_bars.trade_date) FILTER (
                      WHERE recent_bars.rn = 1
                    ) AS latest_trade_date,
                    max(recent_bars.provider) FILTER (
                      WHERE recent_bars.rn = 1
                    ) AS latest_provider,
                    max(recent_bars.open) FILTER (WHERE recent_bars.rn = 1) AS latest_open,
                    max(recent_bars.high) FILTER (WHERE recent_bars.rn = 1) AS latest_high,
                    max(recent_bars.low) FILTER (WHERE recent_bars.rn = 1) AS latest_low,
                    max(recent_bars.close) FILTER (WHERE recent_bars.rn = 1) AS latest_close,
                    max(recent_bars.previous_close) FILTER (
                      WHERE recent_bars.rn = 1
                    ) AS previous_close,
                    max(recent_bars.amount) FILTER (
                      WHERE recent_bars.rn = 1
                    ) AS latest_amount,
                    max(recent_bars.turnover) FILTER (
                      WHERE recent_bars.rn = 1
                    ) AS latest_turnover,
                    max(recent_bars.change_percent) FILTER (
                      WHERE recent_bars.rn = 1
                    ) AS latest_change_percent,
                    max(recent_bars.change_percent) FILTER (
                      WHERE recent_bars.rn = 2
                    ) AS previous_change_percent,
                    bool_or(recent_bars.limit_up) FILTER (
                      WHERE recent_bars.rn = 1
                    ) AS latest_limit_up,
                    bool_or(recent_bars.limit_down) FILTER (
                      WHERE recent_bars.rn = 1
                    ) AS latest_limit_down,
                    bool_or(recent_bars.is_st) FILTER (
                      WHERE recent_bars.rn = 1
                    ) AS latest_is_st,
                    max(recent_bars.trade_status) FILTER (
                      WHERE recent_bars.rn = 1
                    ) AS latest_trade_status,
                    avg(recent_bars.close) FILTER (WHERE recent_bars.rn <= 5) AS ma5,
                    avg(recent_bars.close) FILTER (WHERE recent_bars.rn <= 10) AS ma10,
                    avg(recent_bars.close) FILTER (WHERE recent_bars.rn <= 20) AS ma20,
                    avg(recent_bars.close) FILTER (WHERE recent_bars.rn <= 30) AS ma30,
                    avg(recent_bars.close) FILTER (WHERE recent_bars.rn <= 60) AS ma60,
                    avg(recent_bars.amount) FILTER (
                      WHERE recent_bars.rn <= 20 AND recent_bars.amount IS NOT NULL
                    ) AS avg_amount_20d,
                    max(recent_bars.close) FILTER (WHERE recent_bars.rn = 21) AS close_20d,
                    count(*) FILTER (
                      WHERE recent_bars.rn <= 4 AND recent_bars.limit_up IS TRUE
                    )::INT AS limit_up_count_4d,
                    count(*) FILTER (
                      WHERE recent_bars.rn <= 10 AND recent_bars.limit_up IS TRUE
                    )::INT AS limit_up_count_10d,
                    max(recent_bars.trade_date) FILTER (
                      WHERE recent_bars.rn <= 10 AND recent_bars.limit_up IS TRUE
                    ) AS latest_limit_up_date
                  FROM member_symbols members
                  LEFT JOIN LATERAL (
                    SELECT
                      local_bars.*,
                      row_number() OVER (ORDER BY local_bars.ts DESC) AS rn
                    FROM (
                      SELECT
                        bars.ts,
                        (bars.ts AT TIME ZONE 'Asia/Shanghai')::date AS trade_date,
                        bars.open,
                        bars.high,
                        bars.low,
                        bars.close,
                        bars.previous_close,
                        bars.amount,
                        bars.volume,
                        bars.turnover,
                        bars.change_percent,
                        bars.limit_up,
                        bars.limit_down,
                        bars.is_st,
                        bars.trade_status,
                        bars.provider
                      FROM quant.canonical_stock_bars bars
                      WHERE bars.symbol = members.symbol
                        AND bars.timeframe = members.timeframe
                        AND bars.adjustment = members.adjustment
                        AND bars.ts >= (
                          (%s::date - 260)::timestamp
                          AT TIME ZONE 'Asia/Shanghai'
                        )
                        AND bars.ts < (
                          (%s::date + 1)::timestamp
                          AT TIME ZONE 'Asia/Shanghai'
                        )
                      ORDER BY bars.ts DESC
                      LIMIT 60
                    ) local_bars
                  ) recent_bars ON TRUE
                  GROUP BY
                    members.symbol,
                    members.code,
                    members.name,
                    members.exchange,
                    members.security_metadata
                )
                SELECT
                  features.*,
                  %s::date AS requested_trade_date
                FROM features
                """,
                (
                    universe_id,
                    universe_id,
                    resolved_trade_date,
                    resolved_trade_date,
                    resolved_trade_date,
                ),
            )
            rows = [dict(row) for row in await cursor.fetchall()]

        rows = _merge_feature_rows_with_members(
            [dict(row) for row in rows],
            universe_members,
        )

    def passes_mode(row: dict[str, Any]) -> bool:
        if not _is_known_tradable(row):
            return False
        close = decimal_or_none(row.get("latest_close"))
        open_price = decimal_or_none(row.get("latest_open"))
        previous_close = decimal_or_none(row.get("previous_close"))
        amount = decimal_or_none(row.get("latest_amount"))
        avg_amount_20d = decimal_or_none(row.get("avg_amount_20d"))
        amount_ratio = decimal_ratio(amount, avg_amount_20d)
        ma5 = decimal_or_none(row.get("ma5"))
        ma10 = decimal_or_none(row.get("ma10"))
        ma20 = decimal_or_none(row.get("ma20"))
        ma30 = decimal_or_none(row.get("ma30"))
        ma60 = decimal_or_none(row.get("ma60"))
        latest_change = decimal_or_none(row.get("latest_change_percent"))
        previous_change = decimal_or_none(row.get("previous_change_percent"))
        strength_20d = percent_change(close, decimal_or_none(row.get("close_20d")))
        has_ma_stack_60 = all(
            value is not None for value in (ma5, ma10, ma20, ma30, ma60)
        ) and ma5 >= ma10 >= ma20 >= ma30 >= ma60
        has_ma_stack_20 = all(
            value is not None for value in (ma5, ma10, ma20)
        ) and ma5 >= ma10 >= ma20
        has_liquidity = amount is not None and amount >= Decimal("100000000")
        if mode == "limit_up_relay":
            return bool(
                int(row.get("limit_up_count_4d") or 0) >= 1
                and has_ma_stack_60
                and close is not None
                and ma5 is not None
                and close >= ma5
                and open_price is not None
                and previous_close is not None
                and open_price > previous_close
                and latest_change is not None
                and latest_change > 0
                and previous_change is not None
                and previous_change >= 0
                and has_liquidity
            )
        if mode == "trend_liquidity":
            return bool(
                has_ma_stack_20
                and close is not None
                and ma5 is not None
                and close >= ma5
                and strength_20d is not None
                and strength_20d > 0
                and amount_ratio is not None
                and amount_ratio >= Decimal("1.1")
                and has_liquidity
            )
        return bool(
            has_liquidity
            and close is not None
            and ma5 is not None
            and close >= ma5
            and latest_change is not None
            and latest_change > 0
            and (
                has_ma_stack_60
                or int(row.get("limit_up_count_4d") or 0) >= 1
                or (
                    strength_20d is not None
                    and strength_20d >= Decimal("8")
                    and amount_ratio is not None
                    and amount_ratio >= Decimal("1.2")
                )
            )
        )

    (
        eligible_rows,
        excluded_reasons,
        safety_complete_symbols,
        safety_coverage_pct,
        coverage_warning,
    ) = _screener_coverage(
        rows,
        total_symbols=total_symbols,
        target_trade_date=resolved_trade_date,
    )
    filtered_rows = [row for row in eligible_rows if passes_mode(row)]
    filtered_rows.sort(key=_screener_score, reverse=True)
    candidates: list[AShareScreenerCandidate] = []
    for row in filtered_rows[:safe_limit]:
        sector_fields = security_sector_fields(row["security_metadata"])
        amount_ratio = decimal_ratio(
            decimal_or_none(row.get("latest_amount")),
            decimal_or_none(row.get("avg_amount_20d")),
        )
        candidate = AShareScreenerCandidate(
            symbol=str(row["symbol"]),
            code=str(row["code"]),
            name=row["name"],
            exchange=row["exchange"] or "UNKNOWN",
            sector_tags=sector_fields["sector_tags"],
            trade_date=row["latest_trade_date"],
            close=decimal_or_none(row.get("latest_close")),
            open=decimal_or_none(row.get("latest_open")),
            high=decimal_or_none(row.get("latest_high")),
            low=decimal_or_none(row.get("latest_low")),
            previous_close=decimal_or_none(row.get("previous_close")),
            change_percent=decimal_or_none(row.get("latest_change_percent")),
            amount=decimal_or_none(row.get("latest_amount")),
            turnover=decimal_or_none(row.get("latest_turnover")),
            ma5=decimal_or_none(row.get("ma5")),
            ma10=decimal_or_none(row.get("ma10")),
            ma20=decimal_or_none(row.get("ma20")),
            ma30=decimal_or_none(row.get("ma30")),
            ma60=decimal_or_none(row.get("ma60")),
            strength_20d_pct=percent_change(
                decimal_or_none(row.get("latest_close")),
                decimal_or_none(row.get("close_20d")),
            ),
            amount_ratio_20d=amount_ratio,
            limit_up_count_4d=int(row.get("limit_up_count_4d") or 0),
            limit_up_count_10d=int(row.get("limit_up_count_10d") or 0),
            latest_limit_up_date=row.get("latest_limit_up_date"),
            is_limit_up=bool_or_none(row.get("latest_limit_up")),
            is_limit_down=bool_or_none(row.get("latest_limit_down")),
            is_st=bool_or_none(row.get("latest_is_st")),
            trade_status=(
                str(row["latest_trade_status"])
                if row.get("latest_trade_status") is not None
                else None
            ),
            sample_count=int(row.get("sample_count") or 0),
            score=_screener_score(row),
            signals=_screener_signals(row),
            warnings=_screener_warnings(row),
            missing_fields=_screener_missing_fields(row),
        )
        candidates.append(candidate)

    response_trade_date = resolved_trade_date
    notes = [
        (
            "本接口通过 QuantPilot market-data API 读取 ClickHouse 分析表；"
            "skills 不直接访问数据库。"
            if data_basis.startswith("clickhouse.")
            else (
                "本接口只通过 QuantPilot market-data API 读取本地 TimescaleDB；"
                "skills 不直接访问数据库。"
            )
        ),
        "当前 DDE 大单金额/大单净量未落库，候选结果使用日线 OHLCV、涨跌停、均线和流动性代理。",
    ]
    if clickhouse_note:
        notes.append(clickhouse_note)
    notes.append(
        f"股票池共扫描 {total_symbols} 个活跃股票，其中 {len(eligible_rows)} 个满足"
        f"数据与交易安全门槛，{max(0, total_symbols - len(eligible_rows))} 个被排除。"
    )
    if coverage_warning:
        notes.append(coverage_warning)
    if requested_trade_date_input is not None and response_trade_date != requested_trade_date_input:
        notes.append(
            f"用户请求交易日 {requested_trade_date_input.isoformat()} 本地没有完整股票池覆盖，"
            f"已使用不晚于该日期的最近可用交易日 {response_trade_date.isoformat()}。"
        )
    response = AShareScreenerResponse(
        universe_id=universe_id,
        mode=mode,
        trade_date=response_trade_date,
        scanned_symbols=total_symbols,
        total_symbols=total_symbols,
        eligible_symbols=len(eligible_rows),
        excluded_reasons=excluded_reasons,
        safety_complete_symbols=safety_complete_symbols,
        safety_coverage_pct=safety_coverage_pct,
        coverage_warning=coverage_warning,
        limit=safe_limit,
        candidates=candidates,
        data_basis=data_basis,
        analytics=analytics.model_copy(update={"basis": data_basis}),
        notes=notes,
        cache_status="miss",
        cache_ttl_seconds=SCREENER_CACHE_TTL_SECONDS,
    )
    if response_trade_date is not None and _screener_cached_response_is_usable(response):
        cache_key = _screener_cache_key(
            universe_id=universe_id,
            trade_date=response_trade_date,
            mode=mode,
            limit=safe_limit,
        )
        _screener_cache_set(cache_key, response)
        await _screener_redis_set(cache_key, response)
    return response
