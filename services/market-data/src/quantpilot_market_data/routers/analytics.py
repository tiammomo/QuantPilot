from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException

from quantpilot_market_data.clickhouse import ClickHouseError
from quantpilot_market_data.database_core import DatabaseError
from quantpilot_market_data.models import (
    ClickHouseHealthResponse,
    ClickHouseSyncRequest,
    ClickHouseSyncResponse,
)
from quantpilot_market_data.security import require_market_admin
from quantpilot_market_data.services.analytics import (
    get_clickhouse_analytics_health,
    initialize_clickhouse_analytics,
    sync_clickhouse_analytics,
)

router = APIRouter(prefix="/api/v1/analytics", tags=["analytics"])


@router.get(
    "/clickhouse/health",
    response_model=ClickHouseHealthResponse,
)
async def get_clickhouse_health_endpoint() -> ClickHouseHealthResponse:
    return await get_clickhouse_analytics_health()


@router.post(
    "/clickhouse/init",
    response_model=ClickHouseHealthResponse,
    dependencies=[Depends(require_market_admin)],
)
async def initialize_clickhouse_endpoint() -> ClickHouseHealthResponse:
    try:
        return await initialize_clickhouse_analytics()
    except ClickHouseError as error:
        raise HTTPException(status_code=503, detail=str(error)) from error


@router.post(
    "/clickhouse/sync",
    response_model=ClickHouseSyncResponse,
    dependencies=[Depends(require_market_admin)],
)
async def sync_clickhouse_endpoint(
    request: ClickHouseSyncRequest,
) -> ClickHouseSyncResponse:
    try:
        return await sync_clickhouse_analytics(request)
    except DatabaseError as error:
        raise HTTPException(status_code=503, detail=str(error)) from error
