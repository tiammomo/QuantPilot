from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query

from quantpilot_market_data.database_core import DatabaseError
from quantpilot_market_data.models import (
    DataQualityScanRequest,
    DataQualityScanResponse,
    FactorDefinitionResponse,
    FoundationStatusResponse,
    TradingCalendarResponse,
)
from quantpilot_market_data.services.foundation import (
    get_factor_definitions,
    get_foundation_status,
    get_trading_calendar,
    scan_data_quality,
)

router = APIRouter(prefix="/api/v1/foundation", tags=["foundation"])


@router.get("/status", response_model=FoundationStatusResponse)
async def get_foundation_status_endpoint() -> FoundationStatusResponse:
    try:
        return await get_foundation_status()
    except DatabaseError as error:
        raise HTTPException(status_code=503, detail=str(error)) from error


@router.get("/factors", response_model=FactorDefinitionResponse)
async def get_factor_definitions_endpoint(
    category: str | None = None,
    status: str | None = None,
) -> FactorDefinitionResponse:
    try:
        return await get_factor_definitions(category=category, status=status)
    except DatabaseError as error:
        raise HTTPException(status_code=503, detail=str(error)) from error


@router.get("/trading-calendar", response_model=TradingCalendarResponse)
async def get_trading_calendar_endpoint(
    market: str = "CN-A",
    start: str | None = None,
    end: str | None = None,
    limit: int = Query(default=260, ge=1, le=5000),
) -> TradingCalendarResponse:
    try:
        return await get_trading_calendar(
            market=market,
            start=start,
            end=end,
            limit=limit,
        )
    except ValueError as error:
        raise HTTPException(status_code=400, detail=f"日期格式错误：{error}") from error
    except DatabaseError as error:
        raise HTTPException(status_code=503, detail=str(error)) from error


@router.post("/data-quality/scan", response_model=DataQualityScanResponse)
async def scan_data_quality_endpoint(
    request: DataQualityScanRequest,
) -> DataQualityScanResponse:
    try:
        return await scan_data_quality(request)
    except DatabaseError as error:
        raise HTTPException(status_code=503, detail=str(error)) from error
