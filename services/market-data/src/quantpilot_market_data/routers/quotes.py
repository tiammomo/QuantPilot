from __future__ import annotations

from fastapi import APIRouter, HTTPException

from quantpilot_market_data.cache import MarketDataCache, RedisJsonCache
from quantpilot_market_data.contracts.quotes import (
    Adjustment,
    BatchQuoteRequest,
    BatchQuoteResponse,
    KlinePeriod,
    KlineResponse,
    RealtimeQuote,
    SymbolResolveResponse,
)
from quantpilot_market_data.providers.base import (
    QuoteReadProvider,
)
from quantpilot_market_data.providers.eastmoney import EastMoneyError
from quantpilot_market_data.services.quotes import (
    get_history_quote,
    get_realtime_quote,
    get_realtime_quotes,
    resolve_symbol,
)


def create_quotes_router(
    *,
    client: QuoteReadProvider,
    cache: MarketDataCache,
    intraday_redis_cache: RedisJsonCache,
    symbol_cache_ttl_seconds: int,
    quote_cache_ttl_seconds: int,
    kline_cache_ttl_seconds: int,
) -> APIRouter:
    router = APIRouter(prefix="/api/v1", tags=["quotes"])

    @router.get("/symbols/resolve", response_model=SymbolResolveResponse)
    async def resolve_symbol_endpoint(
        query: str,
        count: int = 5,
    ) -> SymbolResolveResponse:
        try:
            return await resolve_symbol(
                client,
                cache,
                query=query,
                count=count,
                ttl_seconds=symbol_cache_ttl_seconds,
            )
        except ValueError as error:
            raise HTTPException(status_code=400, detail=str(error)) from error
        except EastMoneyError as error:
            raise HTTPException(status_code=502, detail=str(error)) from error

    @router.get("/quotes/realtime/{symbol}", response_model=RealtimeQuote)
    async def get_realtime_quote_endpoint(symbol: str) -> RealtimeQuote:
        try:
            return await get_realtime_quote(
                client,
                cache,
                symbol=symbol,
                ttl_seconds=quote_cache_ttl_seconds,
            )
        except ValueError as error:
            raise HTTPException(status_code=400, detail=str(error)) from error
        except EastMoneyError as error:
            raise HTTPException(status_code=502, detail=str(error)) from error

    @router.post("/quotes/realtime", response_model=BatchQuoteResponse)
    async def get_realtime_quotes_endpoint(
        request: BatchQuoteRequest,
    ) -> BatchQuoteResponse:
        try:
            return await get_realtime_quotes(
                client,
                cache,
                symbols=request.symbols,
                ttl_seconds=quote_cache_ttl_seconds,
            )
        except ValueError as error:
            raise HTTPException(status_code=400, detail=str(error)) from error
        except EastMoneyError as error:
            raise HTTPException(status_code=502, detail=str(error)) from error

    @router.get("/quotes/history/{symbol}", response_model=KlineResponse)
    async def get_history_quote_endpoint(
        symbol: str,
        period: KlinePeriod = "daily",
        adjustment: Adjustment = "qfq",
        limit: int = 120,
        end: str = "20500101",
        refresh: bool = False,
    ) -> KlineResponse:
        try:
            return await get_history_quote(
                client,
                cache,
                intraday_redis_cache,
                symbol=symbol,
                period=period,
                adjustment=adjustment,
                limit=limit,
                end=end,
                refresh=refresh,
                ttl_seconds=kline_cache_ttl_seconds,
            )
        except ValueError as error:
            raise HTTPException(status_code=400, detail=str(error)) from error
        except EastMoneyError as error:
            raise HTTPException(status_code=502, detail=str(error)) from error

    return router
