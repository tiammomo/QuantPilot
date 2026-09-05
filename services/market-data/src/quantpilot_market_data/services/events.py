from __future__ import annotations

from datetime import UTC, datetime

from quantpilot_market_data.cache import MarketDataCache
from quantpilot_market_data.contracts.fundamentals import (
    AnnouncementResponse,
    DividendEventsResponse,
)
from quantpilot_market_data.providers.base import AnnouncementProvider, DividendEventProvider
from quantpilot_market_data.services.caching import cache_response, read_cached_response


async def get_announcements(
    client: AnnouncementProvider,
    cache: MarketDataCache,
    *,
    symbol: str,
    limit: int,
    ttl_seconds: int,
) -> AnnouncementResponse:
    normalized_limit = max(1, min(limit, 100))
    cache_key = cache.build_key(
        "announcement-events",
        {"symbol": symbol, "limit": normalized_limit},
    )
    cached = read_cached_response(cache, cache_key, AnnouncementResponse)
    if cached is not None:
        return cached

    announcements = await client.get_announcements(symbol, limit=normalized_limit)
    response = AnnouncementResponse(
        symbol=symbol,
        announcements=announcements,
        fetched_at=datetime.now(UTC),
    )
    return cache_response(cache, cache_key, ttl_seconds, response, AnnouncementResponse)


async def get_dividend_events(
    client: DividendEventProvider,
    cache: MarketDataCache,
    *,
    symbol: str,
    limit: int,
    ttl_seconds: int,
) -> DividendEventsResponse:
    normalized_limit = max(1, min(limit, 100))
    cache_key = cache.build_key(
        "dividend-events",
        {"symbol": symbol, "limit": normalized_limit},
    )
    cached = read_cached_response(cache, cache_key, DividendEventsResponse)
    if cached is not None:
        return cached

    response = DividendEventsResponse(
        symbol=symbol,
        events=await client.get_dividend_events(symbol, limit=normalized_limit),
        fetched_at=datetime.now(UTC),
    )
    return cache_response(cache, cache_key, ttl_seconds, response, DividendEventsResponse)
