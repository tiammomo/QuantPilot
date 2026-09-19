from __future__ import annotations

from collections.abc import Awaitable

from fastapi import APIRouter, Depends, HTTPException

from quantpilot_market_data.contracts.ingestion import (
    AutoFillIngestionStartResponse,
    HistoryAutoFillIngestionRequest,
    HistoryBatchIngestionRequest,
    HistoryIngestionRequest,
    HistoryIngestionResponse,
    RealtimeSnapshotIngestionRequest,
)
from quantpilot_market_data.database_core import DatabaseError
from quantpilot_market_data.providers.akshare import AkShareClient
from quantpilot_market_data.providers.baostock import BaoStockClient
from quantpilot_market_data.providers.eastmoney import EastMoneyClient
from quantpilot_market_data.security import require_market_admin
from quantpilot_market_data.services.ingestion import autofill, batch, history, snapshots
from quantpilot_market_data.services.ingestion.tasks import IngestionTaskGroup


async def _response[T](operation: Awaitable[T]) -> T:
    try:
        return await operation
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    except DatabaseError as error:
        raise HTTPException(status_code=503, detail=str(error)) from error


def create_ingestion_write_router(
    *,
    client: EastMoneyClient,
    akshare_client: AkShareClient,
    baostock_client: BaoStockClient,
    tasks: IngestionTaskGroup,
) -> APIRouter:
    router = APIRouter(
        prefix="/api/v1/ingestion",
        dependencies=[Depends(require_market_admin)],
    )

    @router.post("/eastmoney/history", response_model=HistoryIngestionResponse)
    async def ingest_eastmoney_history(
        request: HistoryIngestionRequest,
    ) -> HistoryIngestionResponse:
        return await _response(history.ingest_eastmoney_history(request, client=client))

    @router.post("/akshare/history", response_model=HistoryIngestionResponse)
    async def ingest_akshare_history(request: HistoryIngestionRequest) -> HistoryIngestionResponse:
        return await _response(
            history.ingest_akshare_history(request, akshare_client=akshare_client)
        )

    @router.post("/baostock/history", response_model=HistoryIngestionResponse)
    async def ingest_baostock_history(request: HistoryIngestionRequest) -> HistoryIngestionResponse:
        return await _response(
            history.ingest_baostock_history(request, baostock_client=baostock_client)
        )

    @router.post("/baostock/history/batch", response_model=HistoryIngestionResponse)
    async def ingest_baostock_history_batch(
        request: HistoryBatchIngestionRequest,
    ) -> HistoryIngestionResponse:
        return await _response(
            batch.ingest_baostock_history_batch(request, baostock_client=baostock_client)
        )

    @router.post("/baostock/history/autofill", response_model=AutoFillIngestionStartResponse)
    async def start_baostock_history_autofill(
        request: HistoryAutoFillIngestionRequest,
    ) -> AutoFillIngestionStartResponse:
        return await _response(
            autofill.start_baostock_history_autofill(
                request, baostock_client=baostock_client, tasks=tasks
            )
        )

    @router.post("/eastmoney/realtime-snapshot", response_model=HistoryIngestionResponse)
    async def ingest_eastmoney_realtime_snapshot(
        request: RealtimeSnapshotIngestionRequest,
    ) -> HistoryIngestionResponse:
        return await _response(snapshots.ingest_eastmoney_realtime_snapshot(request, client=client))

    return router
