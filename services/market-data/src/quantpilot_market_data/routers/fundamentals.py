from __future__ import annotations

from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Query

from quantpilot_market_data.cache import MarketDataCache
from quantpilot_market_data.contracts.fundamentals import (
    FinancialReportCaptureResponse,
    FinancialReportsResponse,
    FundamentalIndicatorsResponse,
)
from quantpilot_market_data.database_core import DatabaseError
from quantpilot_market_data.providers.base import FinancialReportProvider
from quantpilot_market_data.providers.eastmoney import EastMoneyError
from quantpilot_market_data.security import require_market_admin
from quantpilot_market_data.services.fundamentals import (
    capture_financial_reports,
    get_financial_reports,
    get_fundamental_indicators,
)


def create_fundamentals_router(
    *,
    client: FinancialReportProvider,
    cache: MarketDataCache,
    financial_cache_ttl_seconds: int,
) -> APIRouter:
    router = APIRouter(tags=["fundamentals"])

    @router.post(
        "/api/v1/fundamentals/financials/{symbol}/capture",
        response_model=FinancialReportCaptureResponse,
        dependencies=[Depends(require_market_admin)],
    )
    async def capture_financial_reports_endpoint(
        symbol: str,
        limit: int = Query(default=40, ge=1, le=40),
    ) -> FinancialReportCaptureResponse:
        try:
            return await capture_financial_reports(client, symbol=symbol, limit=limit)
        except ValueError as error:
            raise HTTPException(status_code=400, detail=str(error)) from error
        except DatabaseError as error:
            raise HTTPException(status_code=503, detail=str(error)) from error
        except EastMoneyError as error:
            raise HTTPException(status_code=502, detail=str(error)) from error

    @router.get(
        "/api/v1/fundamentals/financials/{symbol}",
        response_model=FinancialReportsResponse,
    )
    async def get_financial_reports_endpoint(
        symbol: str,
        limit: int = 8,
        as_of: datetime | None = None,
    ) -> FinancialReportsResponse:
        try:
            return await get_financial_reports(
                client,
                cache,
                symbol=symbol,
                limit=limit,
                ttl_seconds=financial_cache_ttl_seconds,
                as_of=as_of,
            )
        except ValueError as error:
            raise HTTPException(status_code=400, detail=str(error)) from error
        except DatabaseError as error:
            raise HTTPException(status_code=503, detail=str(error)) from error
        except EastMoneyError as error:
            raise HTTPException(status_code=502, detail=str(error)) from error

    @router.get(
        "/api/v1/indicators/fundamental/{symbol}",
        response_model=FundamentalIndicatorsResponse,
    )
    async def get_fundamental_indicators_endpoint(
        symbol: str,
        limit: int = 8,
        as_of: datetime | None = None,
    ) -> FundamentalIndicatorsResponse:
        try:
            return await get_fundamental_indicators(
                client,
                cache,
                symbol=symbol,
                limit=limit,
                ttl_seconds=financial_cache_ttl_seconds,
                as_of=as_of,
            )
        except ValueError as error:
            raise HTTPException(status_code=400, detail=str(error)) from error
        except DatabaseError as error:
            raise HTTPException(status_code=503, detail=str(error)) from error
        except EastMoneyError as error:
            raise HTTPException(status_code=502, detail=str(error)) from error

    return router
