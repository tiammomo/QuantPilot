from __future__ import annotations

import asyncio
from datetime import UTC, date, datetime, timedelta
from datetime import time as dt_time
from zoneinfo import ZoneInfo

from quantpilot_market_data.cache import MarketDataCache, RedisJsonCache
from quantpilot_market_data.models import (
    Adjustment,
    BatchQuoteResponse,
    FetchMetadata,
    KlinePeriod,
    KlineResponse,
    RealtimeQuote,
    SymbolResolveResponse,
)
from quantpilot_market_data.providers.base import (
    HistoricalKlineProvider,
    RealtimeQuoteProvider,
    SymbolResolverProvider,
)
from quantpilot_market_data.providers.eastmoney import EastMoneyError
from quantpilot_market_data.services.caching import cache_response, read_cached_response
from quantpilot_market_data.services.kline_gateway import (
    get_kline_local_first,
    get_local_kline_if_ready,
)

CN_TZ = ZoneInfo("Asia/Shanghai")
INTRADAY_CACHE_EXPIRE_HOUR = 9
INTRADAY_PERIODS = {"minute1", "minute5", "minute15", "minute30", "minute60"}


async def resolve_symbol(
    client: SymbolResolverProvider,
    cache: MarketDataCache,
    *,
    query: str,
    count: int,
    ttl_seconds: int,
) -> SymbolResolveResponse:
    normalized_count = max(1, min(count, 20))
    # v2 invalidates legacy negative entries created before exact market aliases
    # were resolved locally. Empty suggest responses are deliberately not
    # cached: a transient upstream miss must not turn into repeated false
    # clarification requests in the long-running workspace flow.
    cache_key = cache.build_key("symbols-resolve-v2", {"query": query, "count": normalized_count})
    cached = read_cached_response(cache, cache_key, SymbolResolveResponse)
    if cached is not None:
        return cached

    results = await client.resolve_symbol(query, count=normalized_count)
    response = SymbolResolveResponse(results=results, fetched_at=datetime.now(UTC))
    if not results:
        return response
    return cache_response(cache, cache_key, ttl_seconds, response, SymbolResolveResponse)


async def get_realtime_quote(
    client: RealtimeQuoteProvider,
    cache: MarketDataCache,
    *,
    symbol: str,
    ttl_seconds: int,
) -> RealtimeQuote:
    cache_key = cache.build_key("quote-realtime", {"symbol": symbol})
    cached = read_cached_response(cache, cache_key, RealtimeQuote)
    if cached is not None:
        return cached

    quote = await client.get_realtime_quote(symbol)
    return cache_response(cache, cache_key, ttl_seconds, quote, RealtimeQuote)


async def get_realtime_quotes(
    client: RealtimeQuoteProvider,
    cache: MarketDataCache,
    *,
    symbols: list[str],
    ttl_seconds: int,
) -> BatchQuoteResponse:
    normalized_symbols = [symbol.strip() for symbol in symbols]
    cache_key = cache.build_key("quote-realtime-batch", {"symbols": normalized_symbols})
    cached = read_cached_response(cache, cache_key, BatchQuoteResponse)
    if cached is not None:
        return cached

    quotes = await client.get_realtime_quotes(normalized_symbols)
    response = BatchQuoteResponse(quotes=quotes)
    return cache_response(cache, cache_key, ttl_seconds, response, BatchQuoteResponse)


async def get_history_quote(
    client: HistoricalKlineProvider,
    cache: MarketDataCache,
    intraday_redis_cache: RedisJsonCache,
    *,
    symbol: str,
    period: KlinePeriod,
    adjustment: Adjustment,
    limit: int,
    end: str,
    refresh: bool,
    ttl_seconds: int,
) -> KlineResponse:
    normalized_limit = max(1, min(limit, 1000))
    if is_intraday_period(period):
        return await get_intraday_history_quote(
            client,
            intraday_redis_cache,
            symbol=symbol,
            period=period,
            limit=normalized_limit,
            end=end,
            refresh=refresh,
        )

    if not refresh:
        local = await get_local_kline_if_ready(
            symbol=symbol,
            period=period,
            adjustment=adjustment,
            limit=normalized_limit,
            end=end,
        )
        if local is not None:
            return local

    cache_key = cache.build_key(
        "quote-history",
        {
            "symbol": symbol,
            "period": period,
            "adjustment": adjustment,
            "limit": normalized_limit,
            "end": end,
        },
    )
    if not refresh:
        cached = read_cached_response(cache, cache_key, KlineResponse)
        if cached is not None:
            return cached

    response = await get_kline_local_first(
        client,
        symbol=symbol,
        period=period,
        adjustment=adjustment,
        limit=normalized_limit,
        end=end,
        bypass_local=True,
    )
    return cache_response(cache, cache_key, ttl_seconds, response, KlineResponse)


async def get_intraday_history_quote(
    client: HistoricalKlineProvider,
    intraday_redis_cache: RedisJsonCache,
    *,
    symbol: str,
    period: KlinePeriod,
    limit: int,
    end: str,
    refresh: bool,
) -> KlineResponse:
    effective_adjustment: Adjustment = "none"
    cache_date = intraday_cache_date()
    cache_key = intraday_redis_cache_key(
        symbol=symbol,
        period=period,
        cache_date=cache_date,
        limit=limit,
    )
    ttl_seconds = intraday_cache_ttl_seconds(cache_date)
    expires_at = intraday_cache_expires_at(cache_date).astimezone(UTC)
    cached_payload = await intraday_redis_cache.read(cache_key)
    if cached_payload is not None and not refresh:
        return intraday_cached_response(
            cached_payload,
            cache_key=cache_key,
            ttl_seconds=ttl_seconds,
            expires_at=expires_at,
        )

    try:
        response = await fetch_intraday_kline_with_retry(
            client,
            symbol=symbol,
            period=period,
            adjustment=effective_adjustment,
            limit=limit,
            end=end,
        )
    except EastMoneyError:
        if cached_payload is not None:
            return intraday_cached_response(
                cached_payload,
                cache_key=cache_key,
                ttl_seconds=ttl_seconds,
                expires_at=expires_at,
            )
        raise

    response_with_metadata = with_intraday_fetch_metadata(
        response,
        status="miss",
        cache_key=cache_key,
        ttl_seconds=ttl_seconds,
        expires_at=expires_at,
    )
    written = await intraday_redis_cache.write(
        cache_key,
        ttl_seconds=ttl_seconds,
        payload=response_with_metadata.model_dump(mode="json"),
    )
    if written:
        return response_with_metadata
    return with_intraday_fetch_metadata(
        response,
        status="disabled",
        cache_key=cache_key,
        ttl_seconds=ttl_seconds,
        expires_at=expires_at,
    )


def is_intraday_period(period: KlinePeriod | str) -> bool:
    return str(period) in INTRADAY_PERIODS


def intraday_cache_date(now: datetime | None = None) -> date:
    current = (now or datetime.now(CN_TZ)).astimezone(CN_TZ)
    if current.time() < dt_time(hour=INTRADAY_CACHE_EXPIRE_HOUR):
        return current.date() - timedelta(days=1)
    return current.date()


def intraday_cache_expires_at(cache_date: date) -> datetime:
    return datetime.combine(
        cache_date + timedelta(days=1),
        dt_time(hour=INTRADAY_CACHE_EXPIRE_HOUR),
        tzinfo=CN_TZ,
    )


def intraday_cache_ttl_seconds(cache_date: date, now: datetime | None = None) -> int:
    current = (now or datetime.now(CN_TZ)).astimezone(CN_TZ)
    expires_at = intraday_cache_expires_at(cache_date)
    return max(1, int((expires_at - current).total_seconds()))


def intraday_redis_cache_key(
    *,
    symbol: str,
    period: KlinePeriod | str,
    cache_date: date,
    limit: int,
) -> str:
    normalized_symbol = symbol.strip().upper()
    return f"intraday:eastmoney:{normalized_symbol}:{period}:{cache_date.isoformat()}:limit:{limit}"


def intraday_cached_response(
    payload: dict[str, object],
    *,
    cache_key: str,
    ttl_seconds: int,
    expires_at: datetime,
) -> KlineResponse:
    cached_response = KlineResponse.model_validate(payload)
    return cached_response.model_copy(
        update={
            "fetch": cached_response.fetch.model_copy(
                update={
                    "cache_status": "redis-hit",
                    "cache_key": cache_key,
                    "cache_ttl_seconds": ttl_seconds,
                    "expires_at": cached_response.fetch.expires_at or expires_at,
                }
            )
        }
    )


def with_intraday_fetch_metadata(
    response: KlineResponse,
    *,
    status: str,
    cache_key: str,
    ttl_seconds: int,
    cached_at: datetime | None = None,
    expires_at: datetime | None = None,
) -> KlineResponse:
    cached_at = cached_at or datetime.now(UTC)
    expires_at = expires_at or (cached_at + timedelta(seconds=ttl_seconds))
    return response.model_copy(
        update={
            "fetch": FetchMetadata(
                cache_status=status,  # type: ignore[arg-type]
                cache_key=cache_key,
                cache_ttl_seconds=ttl_seconds,
                cached_at=cached_at,
                expires_at=expires_at,
            )
        }
    )


async def fetch_intraday_kline_with_retry(
    client: HistoricalKlineProvider,
    *,
    symbol: str,
    period: KlinePeriod,
    adjustment: Adjustment,
    limit: int,
    end: str,
    attempts: int = 3,
) -> KlineResponse:
    last_error: EastMoneyError | None = None
    for attempt in range(max(1, attempts)):
        try:
            return await client.get_kline(
                symbol,
                period=period,
                adjustment=adjustment,
                limit=limit,
                end=end,
            )
        except EastMoneyError as error:
            last_error = error
            if attempt >= attempts - 1:
                break
            await asyncio.sleep(0.35 * (attempt + 1))
    if last_error is not None:
        raise last_error
    raise EastMoneyError("东方财富分时 K 线请求失败")
