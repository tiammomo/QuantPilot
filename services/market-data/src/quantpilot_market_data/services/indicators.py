from __future__ import annotations

from quantpilot_market_data.cache import MarketDataCache
from quantpilot_market_data.indicators import build_technical_indicators
from quantpilot_market_data.models import (
    Adjustment,
    KlinePeriod,
    TechnicalIndicatorsResponse,
)
from quantpilot_market_data.providers.base import HistoricalKlineProvider
from quantpilot_market_data.services.caching import cache_response, read_cached_response
from quantpilot_market_data.services.kline_gateway import (
    get_kline_local_first,
    get_local_kline_if_ready,
)


async def get_technical_indicators(
    client: HistoricalKlineProvider,
    cache: MarketDataCache,
    *,
    symbol: str,
    period: KlinePeriod,
    adjustment: Adjustment,
    limit: int,
    end: str,
    ttl_seconds: int,
) -> TechnicalIndicatorsResponse:
    normalized_limit = max(1, min(limit, 1000))
    local = await get_local_kline_if_ready(
        symbol=symbol,
        period=period,
        adjustment=adjustment,
        limit=normalized_limit,
        end=end,
    )
    if local is not None:
        return build_technical_indicators(local)
    cache_key = cache.build_key(
        "technical-indicators",
        {
            "symbol": symbol,
            "period": period,
            "adjustment": adjustment,
            "limit": normalized_limit,
            "end": end,
        },
    )
    cached = read_cached_response(cache, cache_key, TechnicalIndicatorsResponse)
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
    response = build_technical_indicators(kline)
    return cache_response(cache, cache_key, ttl_seconds, response, TechnicalIndicatorsResponse)
