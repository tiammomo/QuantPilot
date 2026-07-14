from __future__ import annotations

from decimal import Decimal

from quantpilot_market_data.backtest import build_ma_crossover_backtest, build_strategy_backtest
from quantpilot_market_data.cache import MarketDataCache
from quantpilot_market_data.models import Adjustment, BacktestResponse, KlinePeriod
from quantpilot_market_data.providers.base import HistoricalKlineProvider
from quantpilot_market_data.services.caching import cache_response, read_cached_response
from quantpilot_market_data.services.kline_gateway import (
    get_kline_local_first,
    get_local_kline_if_ready,
)


async def get_ma_crossover_backtest(
    client: HistoricalKlineProvider,
    cache: MarketDataCache,
    *,
    symbol: str,
    fast_window: int,
    slow_window: int,
    period: KlinePeriod,
    adjustment: Adjustment,
    limit: int,
    end: str,
    initial_cash: Decimal,
    fee_bps: Decimal,
    ttl_seconds: int,
) -> BacktestResponse:
    normalized_fast = max(2, min(fast_window, 120))
    normalized_slow = max(3, min(slow_window, 250))
    normalized_limit = max(normalized_slow + 5, min(limit, 1000))
    local = await get_local_kline_if_ready(
        symbol=symbol,
        period=period,
        adjustment=adjustment,
        limit=normalized_limit,
        end=end,
    )
    if local is not None:
        return build_ma_crossover_backtest(
            local,
            fast_window=normalized_fast,
            slow_window=normalized_slow,
            initial_cash=initial_cash,
            fee_bps=fee_bps,
        )
    cache_key = cache.build_key(
        "backtest-ma-crossover",
        {
            "symbol": symbol,
            "fast_window": normalized_fast,
            "slow_window": normalized_slow,
            "period": period,
            "adjustment": adjustment,
            "limit": normalized_limit,
            "end": end,
            "initial_cash": str(initial_cash),
            "fee_bps": str(fee_bps),
        },
    )
    cached = read_cached_response(cache, cache_key, BacktestResponse)
    if cached is not None:
        return cached

    kline = await get_kline_local_first(
        client,
        symbol=symbol,
        period=period,
        adjustment=adjustment,
        limit=normalized_limit,
        end=end,
        bypass_local=True,
    )
    response = build_ma_crossover_backtest(
        kline,
        fast_window=normalized_fast,
        slow_window=normalized_slow,
        initial_cash=initial_cash,
        fee_bps=fee_bps,
    )
    return cache_response(cache, cache_key, ttl_seconds, response, BacktestResponse)


async def get_strategy_backtest(
    client: HistoricalKlineProvider,
    cache: MarketDataCache,
    *,
    strategy_id: str,
    symbol: str,
    parameters: dict[str, str],
    period: KlinePeriod,
    adjustment: Adjustment,
    limit: int,
    end: str,
    initial_cash: Decimal,
    fee_bps: Decimal,
    ttl_seconds: int,
) -> BacktestResponse:
    normalized_limit = max(80, min(limit, 1500))
    local = await get_local_kline_if_ready(
        symbol=symbol,
        period=period,
        adjustment=adjustment,
        limit=normalized_limit,
        end=end,
    )
    if local is not None:
        return build_strategy_backtest(
            local,
            strategy_id=strategy_id,
            parameters=parameters,
            initial_cash=initial_cash,
            fee_bps=fee_bps,
        )
    cache_key = cache.build_key(
        "backtest-strategy",
        {
            "strategy_id": strategy_id,
            "symbol": symbol,
            "parameters": parameters,
            "period": period,
            "adjustment": adjustment,
            "limit": normalized_limit,
            "end": end,
            "initial_cash": str(initial_cash),
            "fee_bps": str(fee_bps),
        },
    )
    cached = read_cached_response(cache, cache_key, BacktestResponse)
    if cached is not None:
        return cached

    kline = await get_kline_local_first(
        client,
        symbol=symbol,
        period=period,
        adjustment=adjustment,
        limit=normalized_limit,
        end=end,
        bypass_local=True,
    )
    response = build_strategy_backtest(
        kline,
        strategy_id=strategy_id,
        parameters=parameters,
        initial_cash=initial_cash,
        fee_bps=fee_bps,
    )
    return cache_response(cache, cache_key, ttl_seconds, response, BacktestResponse)
