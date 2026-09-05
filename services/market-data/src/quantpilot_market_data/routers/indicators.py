from __future__ import annotations

from fastapi import APIRouter, HTTPException

from quantpilot_market_data.cache import MarketDataCache
from quantpilot_market_data.contracts.quotes import (
    Adjustment,
    KlinePeriod,
    TechnicalIndicatorsResponse,
)
from quantpilot_market_data.providers.base import HistoricalKlineProvider
from quantpilot_market_data.providers.eastmoney import EastMoneyError
from quantpilot_market_data.services.indicators import get_technical_indicators


def create_indicators_router(
    *,
    client: HistoricalKlineProvider,
    cache: MarketDataCache,
    kline_cache_ttl_seconds: int,
) -> APIRouter:
    router = APIRouter(prefix="/api/v1/indicators", tags=["indicators"])

    @router.get("/technical/{symbol}", response_model=TechnicalIndicatorsResponse)
    async def get_technical_indicators_endpoint(
        symbol: str,
        period: KlinePeriod = "daily",
        adjustment: Adjustment = "qfq",
        limit: int = 120,
        end: str = "20500101",
    ) -> TechnicalIndicatorsResponse:
        try:
            return await get_technical_indicators(
                client,
                cache,
                symbol=symbol,
                period=period,
                adjustment=adjustment,
                limit=limit,
                end=end,
                ttl_seconds=kline_cache_ttl_seconds,
            )
        except ValueError as error:
            raise HTTPException(status_code=400, detail=str(error)) from error
        except EastMoneyError as error:
            raise HTTPException(status_code=502, detail=str(error)) from error

    return router
