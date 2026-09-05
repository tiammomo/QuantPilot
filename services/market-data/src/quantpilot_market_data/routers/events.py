from __future__ import annotations

from fastapi import APIRouter, HTTPException

from quantpilot_market_data.cache import MarketDataCache
from quantpilot_market_data.contracts.fundamentals import (
    AnnouncementResponse,
    DividendEventsResponse,
)
from quantpilot_market_data.providers.base import AnnouncementProvider, DividendEventProvider
from quantpilot_market_data.providers.eastmoney import EastMoneyError
from quantpilot_market_data.services.events import get_announcements, get_dividend_events


def create_events_router(
    *,
    announcement_client: AnnouncementProvider,
    dividend_client: DividendEventProvider,
    cache: MarketDataCache,
    announcement_cache_ttl_seconds: int,
    financial_cache_ttl_seconds: int,
) -> APIRouter:
    router = APIRouter(prefix="/api/v1/events", tags=["events"])

    @router.get("/announcements/{symbol}", response_model=AnnouncementResponse)
    async def get_announcements_endpoint(
        symbol: str,
        limit: int = 20,
    ) -> AnnouncementResponse:
        try:
            return await get_announcements(
                announcement_client,
                cache,
                symbol=symbol,
                limit=limit,
                ttl_seconds=announcement_cache_ttl_seconds,
            )
        except ValueError as error:
            raise HTTPException(status_code=400, detail=str(error)) from error
        except EastMoneyError as error:
            raise HTTPException(status_code=502, detail=str(error)) from error

    @router.get("/dividends/{symbol}", response_model=DividendEventsResponse)
    async def get_dividend_events_endpoint(
        symbol: str,
        limit: int = 20,
    ) -> DividendEventsResponse:
        try:
            return await get_dividend_events(
                dividend_client,
                cache,
                symbol=symbol,
                limit=limit,
                ttl_seconds=financial_cache_ttl_seconds,
            )
        except ValueError as error:
            raise HTTPException(status_code=400, detail=str(error)) from error
        except EastMoneyError as error:
            raise HTTPException(status_code=502, detail=str(error)) from error

    return router
