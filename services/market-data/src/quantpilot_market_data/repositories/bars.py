from __future__ import annotations

from datetime import date, datetime, time, timedelta
from decimal import Decimal

from psycopg.rows import dict_row

from quantpilot_market_data.database_core import (
    SHANGHAI_TZ,
    bool_or_none,
    connect,
    first_decimal,
    first_text,
    json_object,
)
from quantpilot_market_data.models import (
    LocalKlineBar,
    LocalKlineResponse,
    LocalKlineSummary,
)

__all__ = [
    "estimate_latest_completed_trade_date",
    "get_expected_latest_trade_date",
    "get_local_kline",
    "get_market_latest_bar_ts",
    "resolve_local_symbol",
]

DAILY_BAR_READY_TIME = time(hour=18)
CN_CALENDAR_MARKETS = ("CN-A", "SSE", "SZSE", "BSE")


def estimate_latest_completed_trade_date(now: datetime | None = None) -> date:
    """Estimate the latest completed CN session when no maintained calendar is available."""
    local_now = (now or datetime.now(SHANGHAI_TZ)).astimezone(SHANGHAI_TZ)
    candidate = local_now.date()
    if local_now.timetz().replace(tzinfo=None) < DAILY_BAR_READY_TIME:
        candidate -= timedelta(days=1)
    while candidate.weekday() >= 5:
        candidate -= timedelta(days=1)
    return candidate


async def get_expected_latest_trade_date(
    *,
    now: datetime | None = None,
) -> tuple[date, str]:
    """Resolve the latest completed trade date from a covered calendar or a safe estimate."""
    estimated_date = estimate_latest_completed_trade_date(now)
    async with await connect() as connection, connection.cursor(row_factory=dict_row) as cursor:
        await cursor.execute(
            """
            SELECT
              max(trade_date) FILTER (
                WHERE is_open IS TRUE AND trade_date <= %s
              ) AS latest_open_date,
              max(trade_date) AS calendar_through
            FROM quant.trading_calendars
            WHERE market = ANY(%s::text[])
              AND session = 'regular'
            """,
            (estimated_date, list(CN_CALENDAR_MARKETS)),
        )
        row = await cursor.fetchone()
    latest_open_date = row["latest_open_date"] if row else None
    calendar_through = row["calendar_through"] if row else None
    if (
        latest_open_date is not None
        and calendar_through is not None
        and calendar_through >= estimated_date
    ):
        return latest_open_date, "trading_calendar"
    return estimated_date, "weekday_close_estimate"


async def resolve_local_symbol(query: str) -> str | None:
    """Resolve user-facing codes/secids to the canonical local security symbol."""
    normalized = query.strip().upper()
    if not normalized:
        return None
    async with await connect() as connection, connection.cursor(row_factory=dict_row) as cursor:
        await cursor.execute(
            """
            SELECT symbol
            FROM quant.securities
            WHERE upper(symbol) = %s
               OR upper(code) = %s
               OR upper(COALESCE(secid, '')) = %s
            ORDER BY
              CASE
                WHEN upper(symbol) = %s THEN 0
                WHEN upper(code) = %s THEN 1
                ELSE 2
              END,
              updated_at DESC
            LIMIT 1
            """,
            (normalized, normalized, normalized, normalized, normalized),
        )
        row = await cursor.fetchone()
    return str(row["symbol"]) if row else None


async def get_market_latest_bar_ts(
    *,
    timeframe: str,
    adjustment: str,
    end_ts: datetime | None = None,
) -> datetime | None:
    """Return the latest canonical timestamp available for a market data basis."""
    query_timeframe = "daily" if timeframe in {"weekly", "monthly"} else timeframe
    async with await connect() as connection, connection.cursor(row_factory=dict_row) as cursor:
        await cursor.execute(
            """
            SELECT max(ts) AS latest_ts
            FROM quant.canonical_stock_bars
            WHERE timeframe = %s
              AND adjustment = %s
              AND (%s::TIMESTAMPTZ IS NULL OR ts <= %s)
            """,
            (query_timeframe, adjustment, end_ts, end_ts),
        )
        row = await cursor.fetchone()
    return row["latest_ts"] if row else None

def calculate_return_pct(
    latest_close: Decimal | None,
    previous_close: Decimal | None,
) -> Decimal | None:
    if latest_close is None or previous_close is None or previous_close == 0:
        return None
    return ((latest_close - previous_close) / previous_close) * Decimal("100")


def aggregate_local_bars(
    bars: list[LocalKlineBar],
    timeframe: str,
) -> list[LocalKlineBar]:
    if timeframe not in {"weekly", "monthly"}:
        return bars

    grouped: dict[tuple[int, int], list[LocalKlineBar]] = {}
    for bar in bars:
        local_date = bar.ts.astimezone(SHANGHAI_TZ).date()
        if timeframe == "weekly":
            iso_year, iso_week, _ = local_date.isocalendar()
            key = (iso_year, iso_week)
        else:
            key = (local_date.year, local_date.month)
        grouped.setdefault(key, []).append(bar)

    aggregated: list[LocalKlineBar] = []
    for _, bucket_bars in sorted(grouped.items()):
        ordered = sorted(bucket_bars, key=lambda item: item.ts)
        amount_values = [item.amount for item in ordered if item.amount is not None]
        turnover_values = [item.turnover for item in ordered if item.turnover is not None]
        aggregated.append(
            LocalKlineBar(
                ts=ordered[-1].ts,
                open=ordered[0].open,
                high=max(item.high for item in ordered),
                low=min(item.low for item in ordered),
                close=ordered[-1].close,
                previous_close=ordered[0].previous_close,
                volume=sum((item.volume for item in ordered), Decimal("0")),
                amount=sum(amount_values, Decimal("0")) if amount_values else None,
                turnover=sum(turnover_values, Decimal("0")) if turnover_values else None,
                trade_status=ordered[-1].trade_status,
                is_st=ordered[-1].is_st,
                limit_up=None,
                limit_down=None,
                provider=ordered[-1].provider,
                metadata={
                    "aggregated_from": "daily",
                    "source_bar_count": len(ordered),
                    "source_first_ts": ordered[0].ts.isoformat(),
                    "source_last_ts": ordered[-1].ts.isoformat(),
                },
            )
        )
    return aggregated


def enrich_local_change_fields(bars: list[LocalKlineBar]) -> list[LocalKlineBar]:
    enriched: list[LocalKlineBar] = []
    previous_close: Decimal | None = None
    for bar in bars:
        base_close = bar.previous_close or previous_close
        change_amount = bar.change_amount
        change_percent = bar.change_percent
        if (
            bar.close is not None
            and base_close is not None
            and base_close != 0
        ):
            calculated_amount = bar.close - base_close
            change_amount = change_amount if change_amount is not None else calculated_amount
            change_percent = (
                change_percent
                if change_percent is not None
                else (calculated_amount / base_close) * Decimal("100")
            )
        enriched.append(
            bar.model_copy(
                update={
                    "previous_close": base_close,
                    "change_amount": change_amount,
                    "change_percent": change_percent,
                }
            )
        )
        previous_close = bar.close
    return enriched


async def get_local_kline(
    *,
    symbol: str,
    timeframe: str = "daily",
    adjustment: str = "qfq",
    provider: str | None = None,
    limit: int = 240,
    include_metadata: bool = False,
    end_ts: datetime | None = None,
) -> LocalKlineResponse:
    normalized_limit = max(1, min(limit, 2000))
    query_timeframe = "daily" if timeframe in {"weekly", "monthly"} else timeframe
    source_limit = 8000 if timeframe in {"weekly", "monthly"} else normalized_limit

    async with await connect() as connection, connection.cursor(row_factory=dict_row) as cursor:
        await cursor.execute(
            """
            WITH ranked_bars AS (
              SELECT
                stock_bars.*,
                row_number() OVER (
                  PARTITION BY stock_bars.symbol, stock_bars.timeframe, stock_bars.adjustment,
                               stock_bars.ts
                  ORDER BY
                    CASE
                      WHEN stock_bars.provider = %s THEN 0
                      WHEN stock_bars.provider = 'eastmoney' THEN 1
                      WHEN stock_bars.provider = 'baostock' THEN 2
                      WHEN stock_bars.provider = 'akshare' THEN 3
                      ELSE 4
                    END,
                    stock_bars.created_at DESC
                ) AS provider_rank
              FROM quant.canonical_stock_bars AS stock_bars
              WHERE stock_bars.symbol = %s
                AND stock_bars.timeframe = %s
                AND stock_bars.adjustment = %s
                AND (COALESCE(%s::text, '') = '' OR stock_bars.provider = %s)
                AND (%s::TIMESTAMPTZ IS NULL OR stock_bars.ts <= %s)
            ),
            matching_bars AS (
              SELECT ranked_bars.*
              FROM ranked_bars
              WHERE ranked_bars.provider_rank = 1
            ),
            coverage_summary AS (
              SELECT
                count(*)::INT AS coverage_row_count,
                min(ts) AS coverage_first_ts,
                max(ts) AS coverage_last_ts
              FROM matching_bars
            ),
            selected_bars AS (
              SELECT matching_bars.*
              FROM matching_bars
              ORDER BY matching_bars.ts DESC
              LIMIT %s
            )
            SELECT
              selected_bars.ts,
              selected_bars.timeframe,
              selected_bars.adjustment,
              selected_bars.open,
              selected_bars.high,
              selected_bars.low,
              selected_bars.close,
              selected_bars.previous_close,
              selected_bars.volume,
              selected_bars.amount,
              selected_bars.amplitude,
              selected_bars.change_percent,
              selected_bars.change_amount,
              selected_bars.turnover,
              selected_bars.trade_status,
              selected_bars.is_st,
              selected_bars.limit_up,
              selected_bars.limit_down,
              selected_bars.provider AS data_provider,
              selected_bars.metadata AS bar_metadata,
              coverage_summary.coverage_row_count,
              coverage_summary.coverage_first_ts,
              coverage_summary.coverage_last_ts,
              securities.symbol,
              securities.code,
              securities.name,
              securities.exchange,
              securities.asset_type,
              securities.currency,
              securities.timezone,
              securities.secid,
              securities.provider
            FROM selected_bars
            CROSS JOIN coverage_summary
            LEFT JOIN quant.securities securities
              ON securities.symbol = selected_bars.symbol
            ORDER BY selected_bars.ts ASC
            """,
            (
                provider,
                symbol,
                query_timeframe,
                adjustment,
                provider,
                provider,
                end_ts,
                end_ts,
                source_limit,
            ),
        )
        rows = await cursor.fetchall()

    if not rows:
        return LocalKlineResponse(
            symbol=symbol,
            timeframe=timeframe,
            adjustment=adjustment,
            bars=[],
            summary=LocalKlineSummary(),
        )

    source_bars: list[LocalKlineBar] = []
    for row in rows:
        metadata = json_object(row["bar_metadata"])
        source_bars.append(
            LocalKlineBar(
                ts=row["ts"],
                open=row["open"],
                high=row["high"],
                low=row["low"],
                close=row["close"],
                previous_close=first_decimal(row["previous_close"], metadata.get("previous_close")),
                volume=row["volume"],
                amount=row["amount"],
                amplitude=first_decimal(row["amplitude"], metadata.get("amplitude")),
                change_percent=first_decimal(
                    row["change_percent"],
                    metadata.get("change_percent"),
                ),
                change_amount=first_decimal(
                    row["change_amount"],
                    metadata.get("change_amount"),
                ),
                turnover=first_decimal(row["turnover"], metadata.get("turnover")),
                trade_status=first_text(row["trade_status"], metadata.get("trade_status")),
                is_st=(
                    bool_or_none(row["is_st"])
                    if row["is_st"] is not None
                    else bool_or_none(metadata.get("is_st"))
                ),
                limit_up=(
                    bool_or_none(row["limit_up"])
                    if row["limit_up"] is not None
                    else bool_or_none(metadata.get("limit_up"))
                ),
                limit_down=(
                    bool_or_none(row["limit_down"])
                    if row["limit_down"] is not None
                    else bool_or_none(metadata.get("limit_down"))
                ),
                provider=str(row["data_provider"]),
                metadata=metadata if include_metadata else {},
            )
        )
    enriched_source_bars = enrich_local_change_fields(source_bars)
    aggregated_bars = enrich_local_change_fields(
        aggregate_local_bars(enriched_source_bars, timeframe)
    )
    all_bars = aggregated_bars if timeframe in {"weekly", "monthly"} else enriched_source_bars
    bars = all_bars[-normalized_limit:]
    latest = bars[-1] if bars else None
    previous = bars[-2] if len(bars) > 1 else None
    first_row = rows[0]
    summary_first_ts = all_bars[0].ts if all_bars else None
    summary_last_ts = all_bars[-1].ts if all_bars else None
    if timeframe not in {"weekly", "monthly"}:
        summary_first_ts = first_row["coverage_first_ts"] or summary_first_ts
        summary_last_ts = first_row["coverage_last_ts"] or summary_last_ts
    summary = LocalKlineSummary(
        row_count=(
            len(all_bars)
            if timeframe in {"weekly", "monthly"}
            else int(first_row["coverage_row_count"] or len(bars))
        ),
        first_ts=summary_first_ts,
        last_ts=summary_last_ts,
        latest_close=latest.close if latest else None,
        previous_close=(previous.close if previous else latest.previous_close if latest else None),
        return_pct=calculate_return_pct(
            latest.close if latest else None,
            previous.close if previous else latest.previous_close if latest else None,
        ),
        high=max((bar.high for bar in bars), default=None),
        low=min((bar.low for bar in bars), default=None),
        total_volume=sum((bar.volume for bar in bars), Decimal("0")),
        total_amount=sum((bar.amount or Decimal("0") for bar in bars), Decimal("0")),
    )
    return LocalKlineResponse(
        symbol=str(first_row["symbol"] or symbol),
        code=first_row["code"],
        name=first_row["name"],
        exchange=first_row["exchange"] or "UNKNOWN",
        asset_type=first_row["asset_type"] or "stock",
        currency=first_row["currency"] or "CNY",
        timezone=first_row["timezone"] or "Asia/Shanghai",
        secid=first_row["secid"],
        provider=str(first_row["data_provider"] or first_row["provider"]),
        timeframe=timeframe,
        adjustment=str(first_row["adjustment"] or adjustment),
        bars=bars,
        summary=summary,
    )
