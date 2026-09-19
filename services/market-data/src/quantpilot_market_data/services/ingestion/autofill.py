from __future__ import annotations

from datetime import UTC, datetime
from uuid import uuid4

from quantpilot_market_data.contracts.ingestion import (
    AutoFillIngestionStartResponse,
    HistoryAutoFillIngestionRequest,
)
from quantpilot_market_data.database_core import (
    normalize_fetch_symbol,
)
from quantpilot_market_data.providers.baostock import BaoStockClient
from quantpilot_market_data.repositories.ingestion import (
    create_ingestion_job,
)
from quantpilot_market_data.repositories.universes import get_universe_fetch_targets
from quantpilot_market_data.services.ingestion.autofill_run import run_baostock_history_autofill
from quantpilot_market_data.services.ingestion.support import (
    baostock_required_fields,
    ingestion_start_date,
)
from quantpilot_market_data.services.ingestion.tasks import IngestionTaskGroup


async def start_baostock_history_autofill(
    request: HistoryAutoFillIngestionRequest,
    *,
    baostock_client: BaoStockClient,
    tasks: IngestionTaskGroup,
) -> AutoFillIngestionStartResponse:
    started_at = datetime.now(UTC)

    job_id = f"ingest-baostock-autofill-{started_at.strftime('%Y%m%d%H%M%S')}-{uuid4().hex[:8]}"

    all_targets = [
        {
            "symbol": symbol,
            "query": normalize_fetch_symbol(symbol),
            "asset_type": "stock",
        }
        for symbol in (request.symbols or [])
    ]

    if not all_targets and request.universe_id:
        all_targets = await get_universe_fetch_targets(request.universe_id)

    if not all_targets:
        raise ValueError("未指定 symbols，且股票池没有成员。")

    effective_offset = request.offset if request.offset < len(all_targets) else 0

    calculated_batches = max(
        1,
        ((len(all_targets) - effective_offset) + request.batch_size - 1) // request.batch_size,
    )

    max_batches = request.max_batches or calculated_batches

    required_fields = baostock_required_fields(request)

    await create_ingestion_job(
        job_id=job_id,
        universe_id=request.universe_id,
        provider="baostock-autofill",
        timeframe=request.period,
        adjustment=request.adjustment,
        total_symbols=len(all_targets),
        metadata={
            "symbols": all_targets[: min(len(all_targets), 200)],
            "limit": request.limit,
            "lookback_years": request.lookback_years,
            "start": request.start,
            "effective_start": ingestion_start_date(request).isoformat(),
            "end": request.end,
            "request_delay_seconds": request.request_delay_seconds,
            "batch_delay_seconds": request.batch_delay_seconds,
            "max_retries": request.max_retries,
            "include_valuation_factors": request.include_valuation_factors,
            "source_strategy": "baostock-low-frequency-autofill",
            "batch_offset": effective_offset,
            "batch_size": request.batch_size,
            "next_offset": effective_offset,
            "universe_total_symbols": len(all_targets),
            "max_batches": max_batches,
            "completed_batches": 0,
            "child_job_ids": [],
            "field_contract": required_fields,
            "preflight_enabled": True,
            "control": "run",
        },
    )

    tasks.start(
        run_baostock_history_autofill(
            baostock_client=baostock_client,
            parent_job_id=job_id,
            request=request,
            all_targets=all_targets,
            start_offset=effective_offset,
            max_batches=max_batches,
            started_at=started_at,
        )
    )

    return AutoFillIngestionStartResponse(
        job_id=job_id,
        universe_id=request.universe_id,
        period=request.period,
        adjustment=request.adjustment,
        batch_size=request.batch_size,
        next_offset=effective_offset,
        universe_total_symbols=len(all_targets),
        started_at=started_at,
        metadata={
            "max_batches": max_batches,
            "lookback_years": request.lookback_years,
            "start": request.start,
            "effective_start": ingestion_start_date(request).isoformat(),
            "end": request.end,
            "limit": request.limit,
        },
    )
