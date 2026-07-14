from __future__ import annotations

from datetime import UTC, date, datetime, time
from decimal import Decimal

from psycopg import Error as PsycopgError

from quantpilot_market_data.database_core import SHANGHAI_TZ, DatabaseError
from quantpilot_market_data.models import (
    Adjustment,
    KlineBar,
    KlinePeriod,
    KlineResponse,
    LocalKlineResponse,
)
from quantpilot_market_data.providers.base import HistoricalKlineProvider
from quantpilot_market_data.repositories.bars import (
    get_expected_latest_trade_date,
    get_local_kline,
    get_market_latest_bar_ts,
    resolve_local_symbol,
)

LOCAL_KLINE_PERIODS = {"daily", "weekly", "monthly"}


def _shanghai_date(value: datetime) -> date:
    return value.astimezone(SHANGHAI_TZ).date()


def _end_datetime(value: str) -> datetime | None:
    raw = value.strip()
    if not raw:
        return None
    parsed = (
        date(int(raw[:4]), int(raw[4:6]), int(raw[6:8]))
        if len(raw) == 8 and raw.isdigit()
        else date.fromisoformat(raw)
    )
    # A far-future provider sentinel means "latest", not an actual historical cutoff.
    if parsed > datetime.now(SHANGHAI_TZ).date():
        return None
    return datetime.combine(parsed, time.max, tzinfo=SHANGHAI_TZ).astimezone(UTC)


def _local_to_kline(
    local: LocalKlineResponse,
    *,
    requested_symbol: str,
    requested_limit: int,
    benchmark_last_ts: datetime | None,
    expected_trade_date: date | None,
    expected_trade_date_basis: str | None,
) -> KlineResponse:
    local_last_ts = local.bars[-1].ts if local.bars else None
    benchmark_lag_days = None
    if local_last_ts is not None and benchmark_last_ts is not None:
        benchmark_lag_days = max(
            0,
            (_shanghai_date(benchmark_last_ts) - _shanghai_date(local_last_ts)).days,
        )
    expected_lag_days = None
    if local_last_ts is not None and expected_trade_date is not None:
        expected_lag_days = max(0, (expected_trade_date - _shanghai_date(local_last_ts)).days)
    observed_lags = [
        lag
        for lag in (benchmark_lag_days, expected_lag_days)
        if lag is not None
    ]
    lag_days = max(observed_lags, default=None)
    freshness_status = "current" if lag_days in {None, 0} else "stale"
    provider = local.provider or "unknown"
    volume_max = Decimal(2**63 - 1)
    bars = [
        KlineBar(
            date=bar.ts.astimezone(SHANGHAI_TZ).date().isoformat()
            if local.timeframe in LOCAL_KLINE_PERIODS
            else bar.ts.isoformat(),
            open=bar.open,
            close=bar.close,
            high=bar.high,
            low=bar.low,
            previous_close=bar.previous_close,
            volume=int(min(bar.volume, volume_max)),
            amount=bar.amount,
            amplitude=bar.amplitude,
            change_percent=bar.change_percent,
            change_amount=bar.change_amount,
            turnover=bar.turnover,
            trade_status=bar.trade_status,
            is_st=bar.is_st,
            limit_up=bar.limit_up,
            limit_down=bar.limit_down,
            metadata=bar.metadata,
        )
        for bar in local.bars
    ]
    return KlineResponse(
        symbol=local.code or requested_symbol,
        name=local.name,
        secid=local.secid or local.symbol,
        asset_type=local.asset_type,
        market=local.exchange,
        source="timescaledb",
        currency=local.currency,
        timezone=local.timezone,
        period=local.timeframe,
        adjustment=local.adjustment,
        bars=bars,
        as_of=bars[-1].date if bars else local.fetched_at,
        fetched_at=local.fetched_at,
        metadata={
            "data_basis": "timescaledb.canonical_stock_bars",
            "local_provider": provider,
            "coverage": {
                "requested_bars": requested_limit,
                "returned_bars": len(bars),
                "total_rows": local.summary.row_count,
                "first_ts": local.summary.first_ts.isoformat()
                if local.summary.first_ts
                else None,
                "last_ts": local.summary.last_ts.isoformat() if local.summary.last_ts else None,
            },
            "freshness": {
                "status": freshness_status,
                "local_last_ts": local_last_ts.isoformat() if local_last_ts else None,
                "benchmark_last_ts": benchmark_last_ts.isoformat()
                if benchmark_last_ts
                else None,
                "expected_trade_date": expected_trade_date.isoformat()
                if expected_trade_date
                else None,
                "expected_trade_date_basis": expected_trade_date_basis,
                "benchmark_lag_days": benchmark_lag_days,
                "expected_lag_days": expected_lag_days,
                "lag_days": lag_days,
            },
        },
        data_quality=local.data_quality,
    )


async def get_local_kline_if_ready(
    *,
    symbol: str,
    period: KlinePeriod,
    adjustment: Adjustment,
    limit: int,
    end: str,
) -> KlineResponse | None:
    """Read the canonical database first and return only complete, current coverage."""
    if period not in LOCAL_KLINE_PERIODS:
        return None
    end_ts = _end_datetime(end)
    try:
        local_symbol = await resolve_local_symbol(symbol)
        if local_symbol is None:
            return None
        local, benchmark_last_ts = await _read_local_and_benchmark(
            local_symbol=local_symbol,
            period=period,
            adjustment=adjustment,
            limit=limit,
            end_ts=end_ts,
        )
        expected_trade_date = None
        expected_trade_date_basis = None
        if end_ts is None:
            expected_trade_date, expected_trade_date_basis = (
                await get_expected_latest_trade_date()
            )
    except (DatabaseError, PsycopgError):
        return None
    if len(local.bars) < limit:
        return None
    local_last_ts = local.bars[-1].ts if local.bars else None
    if benchmark_last_ts is not None and (
        local_last_ts is None
        or _shanghai_date(local_last_ts) < _shanghai_date(benchmark_last_ts)
    ):
        return None
    if expected_trade_date is not None and (
        local_last_ts is None or _shanghai_date(local_last_ts) < expected_trade_date
    ):
        return None
    return _local_to_kline(
        local,
        requested_symbol=symbol,
        requested_limit=limit,
        benchmark_last_ts=benchmark_last_ts,
        expected_trade_date=expected_trade_date,
        expected_trade_date_basis=expected_trade_date_basis,
    )


async def _read_local_and_benchmark(
    *,
    local_symbol: str,
    period: KlinePeriod,
    adjustment: Adjustment,
    limit: int,
    end_ts: datetime | None,
) -> tuple[LocalKlineResponse, datetime | None]:
    local = await get_local_kline(
        symbol=local_symbol,
        timeframe=period,
        adjustment=adjustment,
        limit=limit,
        end_ts=end_ts,
    )
    benchmark = await get_market_latest_bar_ts(
        timeframe=period,
        adjustment=adjustment,
        end_ts=end_ts,
    )
    return local, benchmark


def with_provider_basis(response: KlineResponse, provider_id: str) -> KlineResponse:
    metadata = dict(response.metadata)
    metadata.update(
        {
            "data_basis": f"provider.{provider_id}",
            "freshness": {
                "status": "provider-response",
                "as_of": str(response.as_of) if response.as_of is not None else None,
                "fetched_at": response.fetched_at.isoformat(),
            },
        }
    )
    return response.model_copy(update={"metadata": metadata})


async def get_kline_local_first(
    client: HistoricalKlineProvider,
    *,
    symbol: str,
    period: KlinePeriod,
    adjustment: Adjustment,
    limit: int,
    end: str,
    bypass_local: bool = False,
) -> KlineResponse:
    if not bypass_local:
        local = await get_local_kline_if_ready(
            symbol=symbol,
            period=period,
            adjustment=adjustment,
            limit=limit,
            end=end,
        )
        if local is not None:
            return local
    response = await client.get_kline(
        symbol,
        period=period,
        adjustment=adjustment,
        limit=limit,
        end=end,
    )
    return with_provider_basis(response, client.id)
