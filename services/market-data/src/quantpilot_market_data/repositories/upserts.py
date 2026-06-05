from __future__ import annotations

from datetime import date
from typing import Any

from psycopg.types.json import Jsonb

from quantpilot_market_data.database_core import (
    SHANGHAI_TZ,
    amplitude_percent,
    canonical_symbol,
    connect,
    date_cutoff_datetime,
    decimal_from_json,
    decimal_or_none,
    decimal_or_zero,
    decimal_subtract,
    json_object,
    lookback_cutoff_datetime,
    parse_bar_datetime,
    trade_date_datetime,
)
from quantpilot_market_data.models import KlineResponse, RealtimeQuote

__all__ = ["upsert_kline_response", "upsert_realtime_quote_snapshot"]

async def upsert_kline_response(
    kline: KlineResponse,
    *,
    universe_id: str | None,
    lookback_years: int | None = 5,
    start: str | None = None,
    end: str | None = None,
) -> tuple[str, int, str | None, str | None]:
    symbol = canonical_symbol(kline.symbol, kline.market)
    cutoff = date_cutoff_datetime(start) or lookback_cutoff_datetime(lookback_years)
    end_cutoff = date_cutoff_datetime(end)
    bars: list[tuple[Any, ...]] = []
    factor_rows: list[tuple[Any, ...]] = []
    first_date: str | None = None
    last_date: str | None = None
    for bar in kline.bars:
        if bar.open is None or bar.high is None or bar.low is None or bar.close is None:
            continue
        ts = parse_bar_datetime(bar.date)
        if cutoff is not None and ts < cutoff:
            continue
        if end_cutoff is not None and ts > end_cutoff:
            continue
        first_date = first_date or bar.date
        last_date = bar.date
        bar_metadata = {
            "secid": kline.secid,
            "name": kline.name,
            "market": kline.market,
            "asset_type": kline.asset_type,
            "currency": kline.currency,
            "timezone": kline.timezone,
            "source": kline.source,
            "source_response": kline.metadata,
            "source_bar": bar.metadata,
            "previous_close": (
                str(bar.previous_close) if bar.previous_close is not None else None
            ),
            "amplitude": str(bar.amplitude) if bar.amplitude is not None else None,
            "change_percent": (
                str(bar.change_percent) if bar.change_percent is not None else None
            ),
            "change_amount": (
                str(bar.change_amount) if bar.change_amount is not None else None
            ),
            "turnover": str(bar.turnover) if bar.turnover is not None else None,
            "trade_status": bar.trade_status,
            "is_st": bar.is_st,
            "limit_up": bar.limit_up,
            "limit_down": bar.limit_down,
            "universe_id": universe_id,
        }
        bars.append(
            (
                symbol,
                ts,
                kline.period,
                kline.adjustment,
                bar.open,
                bar.high,
                bar.low,
                bar.close,
                decimal_or_none(bar.previous_close),
                decimal_or_zero(bar.volume),
                decimal_or_none(bar.amount),
                decimal_or_none(bar.amplitude),
                decimal_or_none(bar.change_percent),
                decimal_or_none(bar.change_amount),
                decimal_or_none(bar.turnover),
                bar.trade_status,
                bar.is_st,
                bar.limit_up,
                bar.limit_down,
                kline.source,
                Jsonb(bar_metadata),
            )
        )
        factors = json_object(bar.metadata.get("factors"))
        for factor_key, factor_value in factors.items():
            parsed_factor = decimal_from_json(factor_value)
            if parsed_factor is None:
                continue
            factor_rows.append(
                (
                    symbol,
                    ts,
                    factor_key,
                    float(parsed_factor),
                    kline.source,
                    Jsonb(
                        {
                            "source": kline.source,
                            "source_bar": bar.metadata,
                            "universe_id": universe_id,
                        }
                    ),
                )
            )

    if not bars:
        return symbol, 0, first_date, last_date

    async with await connect() as connection, connection.cursor() as cursor:
        await cursor.execute(
            """
                INSERT INTO quant.securities (
                  symbol, code, name, exchange, asset_type, currency, timezone, secid, provider,
                  metadata, created_at, updated_at
                )
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, now(), now())
                ON CONFLICT (symbol) DO UPDATE SET
                  code = EXCLUDED.code,
                  name = COALESCE(EXCLUDED.name, quant.securities.name),
                  exchange = EXCLUDED.exchange,
                  asset_type = EXCLUDED.asset_type,
                  currency = EXCLUDED.currency,
                  timezone = EXCLUDED.timezone,
                  secid = EXCLUDED.secid,
                  metadata = quant.securities.metadata || EXCLUDED.metadata,
                  updated_at = now()
                """,
            (
                symbol,
                kline.symbol,
                kline.name,
                kline.market,
                kline.asset_type,
                kline.currency,
                kline.timezone,
                kline.secid,
                kline.source,
                Jsonb({"source": kline.source, "fetched_at": kline.fetched_at.isoformat()}),
            ),
        )
        await cursor.executemany(
            """
                INSERT INTO quant.stock_bars (
                  symbol, ts, timeframe, adjustment, open, high, low, close, previous_close,
                  volume, amount, amplitude, change_percent, change_amount, turnover,
                  trade_status, is_st, limit_up, limit_down, provider, metadata, created_at
                )
                VALUES (
                  %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s,
                  %s, %s, %s, now()
                )
                ON CONFLICT (symbol, timeframe, adjustment, ts) DO UPDATE SET
                  open = EXCLUDED.open,
                  high = EXCLUDED.high,
                  low = EXCLUDED.low,
                  close = EXCLUDED.close,
                  previous_close = COALESCE(
                    EXCLUDED.previous_close,
                    quant.stock_bars.previous_close
                  ),
                  volume = EXCLUDED.volume,
                  amount = COALESCE(EXCLUDED.amount, quant.stock_bars.amount),
                  amplitude = COALESCE(EXCLUDED.amplitude, quant.stock_bars.amplitude),
                  change_percent = COALESCE(
                    EXCLUDED.change_percent,
                    quant.stock_bars.change_percent
                  ),
                  change_amount = COALESCE(
                    EXCLUDED.change_amount,
                    quant.stock_bars.change_amount
                  ),
                  turnover = COALESCE(EXCLUDED.turnover, quant.stock_bars.turnover),
                  trade_status = COALESCE(EXCLUDED.trade_status, quant.stock_bars.trade_status),
                  is_st = COALESCE(EXCLUDED.is_st, quant.stock_bars.is_st),
                  limit_up = COALESCE(EXCLUDED.limit_up, quant.stock_bars.limit_up),
                  limit_down = COALESCE(EXCLUDED.limit_down, quant.stock_bars.limit_down),
                  provider = CASE
                    WHEN EXCLUDED.amount IS NULL
                     AND EXCLUDED.turnover IS NULL
                     AND (
                       quant.stock_bars.amount IS NOT NULL
                       OR quant.stock_bars.turnover IS NOT NULL
                     )
                    THEN quant.stock_bars.provider
                    ELSE EXCLUDED.provider
                  END,
                  metadata = quant.stock_bars.metadata || jsonb_strip_nulls(EXCLUDED.metadata)
            """,
            bars,
        )
        if factor_rows:
            await cursor.executemany(
                """
                    INSERT INTO quant.stock_factors (
                      symbol, ts, factor_key, factor_value, provider, metadata, created_at
                    )
                    VALUES (%s, %s, %s, %s, %s, %s, now())
                    ON CONFLICT (symbol, factor_key, ts) DO UPDATE SET
                      factor_value = EXCLUDED.factor_value,
                      provider = EXCLUDED.provider,
                      metadata = quant.stock_factors.metadata || EXCLUDED.metadata
                    """,
                factor_rows,
            )
        await cursor.execute(
            """
                INSERT INTO quant.market_data_sync_state (
                  symbol, timeframe, adjustment, provider, first_ts, last_ts, row_count,
                  last_success_at, last_error, metadata, created_at, updated_at
                )
                SELECT
                  %s,
                  %s,
                  %s,
                  %s,
                  min(ts),
                  max(ts),
                  count(*)::INT,
                  now(),
                  NULL,
                  %s,
                  now(),
                  now()
                FROM quant.stock_bars
                WHERE symbol = %s
                  AND timeframe = %s
                  AND adjustment = %s
                  AND provider = %s
                ON CONFLICT (symbol, timeframe, adjustment, provider) DO UPDATE SET
                  first_ts = EXCLUDED.first_ts,
                  last_ts = EXCLUDED.last_ts,
                  row_count = EXCLUDED.row_count,
                  last_success_at = now(),
                  last_error = NULL,
                  metadata = quant.market_data_sync_state.metadata || EXCLUDED.metadata,
                  updated_at = now()
                """,
            (
                symbol,
                kline.period,
                kline.adjustment,
                kline.source,
                Jsonb({"name": kline.name, "secid": kline.secid, "universe_id": universe_id}),
                symbol,
                kline.period,
                kline.adjustment,
                kline.source,
            ),
        )

    return symbol, len(bars), first_date, last_date


async def upsert_realtime_quote_snapshot(
    quote: RealtimeQuote,
    *,
    universe_id: str | None,
    trade_date: date | str | None = None,
    adjustment: str = "qfq",
) -> tuple[str, int, str | None, str | None]:
    if quote.open is None or quote.high is None or quote.low is None or quote.price is None:
        return canonical_symbol(quote.symbol, quote.market), 0, None, None

    local_trade_date = (
        date.fromisoformat(trade_date)
        if isinstance(trade_date, str)
        else trade_date
        if trade_date is not None
        else (quote.quote_time or quote.fetched_at).astimezone(SHANGHAI_TZ).date()
    )
    ts = trade_date_datetime(local_trade_date)
    symbol = canonical_symbol(quote.symbol, quote.market)
    change_amount = quote.change_amount or decimal_subtract(quote.price, quote.previous_close)
    amplitude = quote.amplitude or amplitude_percent(quote.high, quote.low, quote.previous_close)
    bar_metadata = {
        "secid": quote.secid,
        "name": quote.name,
        "market": quote.market,
        "asset_type": quote.asset_type,
        "currency": quote.currency,
        "timezone": quote.timezone,
        "source": quote.source,
        "market_cap": str(quote.market_cap) if quote.market_cap is not None else None,
        "float_market_cap": (
            str(quote.float_market_cap) if quote.float_market_cap is not None else None
        ),
        "source_bar": {
            "quote_time": quote.quote_time.isoformat() if quote.quote_time else None,
            "fetched_at": quote.fetched_at.isoformat(),
            "price": str(quote.price) if quote.price is not None else None,
            "previous_close": (
                str(quote.previous_close) if quote.previous_close is not None else None
            ),
            "amplitude": str(amplitude) if amplitude is not None else None,
            "change_percent": (
                str(quote.change_percent) if quote.change_percent is not None else None
            ),
            "change_amount": str(change_amount) if change_amount is not None else None,
            "turnover": str(quote.turnover) if quote.turnover is not None else None,
            "market_cap": str(quote.market_cap) if quote.market_cap is not None else None,
            "float_market_cap": (
                str(quote.float_market_cap) if quote.float_market_cap is not None else None
            ),
        },
        "previous_close": str(quote.previous_close) if quote.previous_close is not None else None,
        "amplitude": str(amplitude) if amplitude is not None else None,
        "change_percent": str(quote.change_percent) if quote.change_percent is not None else None,
        "change_amount": str(change_amount) if change_amount is not None else None,
        "turnover": str(quote.turnover) if quote.turnover is not None else None,
        "universe_id": universe_id,
        "ingestion_mode": "realtime_snapshot",
    }

    async with await connect() as connection, connection.cursor() as cursor:
        await cursor.execute(
            """
                INSERT INTO quant.securities (
                  symbol, code, name, exchange, asset_type, currency, timezone,
                  secid, provider, metadata, created_at, updated_at
                )
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, now(), now())
                ON CONFLICT (symbol) DO UPDATE SET
                  code = EXCLUDED.code,
                  name = COALESCE(EXCLUDED.name, quant.securities.name),
                  exchange = EXCLUDED.exchange,
                  asset_type = EXCLUDED.asset_type,
                  currency = EXCLUDED.currency,
                  timezone = EXCLUDED.timezone,
                  secid = EXCLUDED.secid,
                  metadata = quant.securities.metadata || EXCLUDED.metadata,
                  updated_at = now()
                """,
            (
                symbol,
                quote.symbol,
                quote.name,
                quote.market,
                quote.asset_type,
                quote.currency,
                quote.timezone,
                quote.secid,
                quote.source,
                Jsonb(
                    {
                        "source": quote.source,
                        "fetched_at": quote.fetched_at.isoformat(),
                        "latest_quote": {
                            "quote_time": (
                                quote.quote_time.isoformat() if quote.quote_time else None
                            ),
                            "price": str(quote.price) if quote.price is not None else None,
                            "previous_close": (
                                str(quote.previous_close)
                                if quote.previous_close is not None
                                else None
                            ),
                            "change_percent": (
                                str(quote.change_percent)
                                if quote.change_percent is not None
                                else None
                            ),
                            "change_amount": (
                                str(change_amount) if change_amount is not None else None
                            ),
                            "turnover": (
                                str(quote.turnover) if quote.turnover is not None else None
                            ),
                            "amount": str(quote.amount) if quote.amount is not None else None,
                            "volume": quote.volume,
                        },
                        "market_cap": (
                            str(quote.market_cap) if quote.market_cap is not None else None
                        ),
                        "float_market_cap": (
                            str(quote.float_market_cap)
                            if quote.float_market_cap is not None
                            else None
                        ),
                    }
                ),
            ),
        )
        await cursor.execute(
            """
                INSERT INTO quant.stock_bars (
                  symbol, ts, timeframe, adjustment, open, high, low, close, previous_close,
                  volume, amount, amplitude, change_percent, change_amount, turnover,
                  trade_status, is_st, limit_up, limit_down, provider, metadata, created_at
                )
                VALUES (
                  %s, %s, 'daily', %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s,
                  NULL, NULL, NULL, NULL, %s, %s, now()
                )
                ON CONFLICT (symbol, timeframe, adjustment, ts) DO UPDATE SET
                  open = EXCLUDED.open,
                  high = EXCLUDED.high,
                  low = EXCLUDED.low,
                  close = EXCLUDED.close,
                  previous_close = COALESCE(
                    EXCLUDED.previous_close,
                    quant.stock_bars.previous_close
                  ),
                  volume = EXCLUDED.volume,
                  amount = COALESCE(EXCLUDED.amount, quant.stock_bars.amount),
                  amplitude = COALESCE(EXCLUDED.amplitude, quant.stock_bars.amplitude),
                  change_percent = COALESCE(
                    EXCLUDED.change_percent,
                    quant.stock_bars.change_percent
                  ),
                  change_amount = COALESCE(EXCLUDED.change_amount, quant.stock_bars.change_amount),
                  turnover = COALESCE(EXCLUDED.turnover, quant.stock_bars.turnover),
                  provider = EXCLUDED.provider,
                  metadata = quant.stock_bars.metadata || jsonb_strip_nulls(EXCLUDED.metadata)
                """,
            (
                symbol,
                ts,
                adjustment,
                quote.open,
                quote.high,
                quote.low,
                quote.price,
                decimal_or_none(quote.previous_close),
                decimal_or_zero(quote.volume),
                decimal_or_none(quote.amount),
                decimal_or_none(amplitude),
                decimal_or_none(quote.change_percent),
                decimal_or_none(change_amount),
                decimal_or_none(quote.turnover),
                quote.source,
                Jsonb(bar_metadata),
            ),
        )
        await cursor.execute(
            """
                INSERT INTO quant.market_data_sync_state (
                  symbol, timeframe, adjustment, provider, first_ts, last_ts, row_count,
                  last_success_at, last_error, metadata, created_at, updated_at
                )
                SELECT
                  %s,
                  'daily',
                  %s,
                  %s,
                  min(ts),
                  max(ts),
                  count(*)::INT,
                  now(),
                  NULL,
                  %s,
                  now(),
                  now()
                FROM quant.stock_bars
                WHERE symbol = %s
                  AND timeframe = 'daily'
                  AND adjustment = %s
                  AND provider = %s
                ON CONFLICT (symbol, timeframe, adjustment, provider) DO UPDATE SET
                  first_ts = EXCLUDED.first_ts,
                  last_ts = EXCLUDED.last_ts,
                  row_count = EXCLUDED.row_count,
                  last_success_at = now(),
                  last_error = NULL,
                  metadata = quant.market_data_sync_state.metadata || EXCLUDED.metadata,
                  updated_at = now()
                """,
            (
                symbol,
                adjustment,
                quote.source,
                Jsonb({"name": quote.name, "secid": quote.secid, "universe_id": universe_id}),
                symbol,
                adjustment,
                quote.source,
            ),
        )

    trade_date_text = local_trade_date.isoformat()
    return symbol, 1, trade_date_text, trade_date_text
