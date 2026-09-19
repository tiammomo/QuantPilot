from __future__ import annotations

from quantpilot_market_data.contracts.ingestion import (
    IngestionJobControlRequest,
    IngestionJobControlResponse,
    IngestionJobsResponse,
)
from quantpilot_market_data.repositories.ingestion import (
    control_ingestion_job,
    list_ingestion_jobs,
)


async def get_market_data_ingestion_jobs(
    *,
    universe_id: str | None = None,
    limit: int,
) -> IngestionJobsResponse:
    return IngestionJobsResponse(
        jobs=await list_ingestion_jobs(universe_id=universe_id, limit=limit)
    )


async def control_market_data_ingestion_job(
    *,
    job_id: str,
    request: IngestionJobControlRequest,
) -> IngestionJobControlResponse:
    control = {
        "pause": "pause",
        "resume": "resume",
        "stop": "stop",
    }[request.action]
    job = await control_ingestion_job(
        job_id=job_id,
        control=control,
        reason=request.reason,
    )
    return IngestionJobControlResponse(
        job_id=job.id,
        action=request.action,
        status=job.status,
        control=str(job.metadata.get("control") or control),
    )
