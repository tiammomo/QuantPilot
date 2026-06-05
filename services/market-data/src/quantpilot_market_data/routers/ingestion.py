from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query

from quantpilot_market_data.database_core import DatabaseError
from quantpilot_market_data.models import (
    IngestionJobControlRequest,
    IngestionJobControlResponse,
    IngestionJobsResponse,
)
from quantpilot_market_data.services.ingestion_jobs import (
    control_market_data_ingestion_job,
    get_market_data_ingestion_jobs,
)

router = APIRouter(prefix="/api/v1/ingestion", tags=["ingestion"])


@router.get("/jobs", response_model=IngestionJobsResponse)
async def get_market_data_ingestion_jobs_endpoint(
    universe_id: str | None = None,
    limit: int = Query(default=20, ge=1, le=100),
) -> IngestionJobsResponse:
    try:
        return await get_market_data_ingestion_jobs(
            universe_id=universe_id,
            limit=limit,
        )
    except DatabaseError as error:
        raise HTTPException(status_code=503, detail=str(error)) from error


@router.post("/jobs/{job_id}/control", response_model=IngestionJobControlResponse)
async def control_market_data_ingestion_job_endpoint(
    job_id: str,
    request: IngestionJobControlRequest,
) -> IngestionJobControlResponse:
    try:
        return await control_market_data_ingestion_job(job_id=job_id, request=request)
    except DatabaseError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error
