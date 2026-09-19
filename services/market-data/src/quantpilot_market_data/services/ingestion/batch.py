from __future__ import annotations

import asyncio
from datetime import UTC, datetime
from uuid import uuid4

from quantpilot_market_data.contracts.ingestion import (
    HistoryBatchIngestionRequest,
    HistoryIngestionResponse,
    HistoryIngestionSymbolResult,
)
from quantpilot_market_data.database_core import (
    DatabaseError,
    normalize_fetch_symbol,
)
from quantpilot_market_data.providers.baostock import BaoStockClient, BaoStockError
from quantpilot_market_data.repositories.ingestion import (
    create_ingestion_job,
    finish_ingestion_job,
    get_history_ingestion_preflight,
)
from quantpilot_market_data.repositories.universes import get_universe_fetch_targets
from quantpilot_market_data.repositories.upserts import (
    upsert_kline_response,
)
from quantpilot_market_data.services.ingestion.support import (
    baostock_required_fields,
    fetch_baostock_kline_for_ingestion,
    ingestion_start_date,
    local_coverage_ready,
    required_fields_for_target,
    skipped_existing_result,
)


async def ingest_baostock_history_batch(
    request: HistoryBatchIngestionRequest,
    *,
    baostock_client: BaoStockClient,
) -> HistoryIngestionResponse:
    started_at = datetime.now(UTC)

    job_id = f"ingest-baostock-batch-{started_at.strftime('%Y%m%d%H%M%S')}-{uuid4().hex[:8]}"

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

    targets = all_targets[effective_offset : effective_offset + request.batch_size]

    next_offset = effective_offset + len(targets)

    if next_offset >= len(all_targets):
        next_offset = 0

    required_fields = baostock_required_fields(request)

    await create_ingestion_job(
        job_id=job_id,
        universe_id=request.universe_id,
        provider="baostock",
        timeframe=request.period,
        adjustment=request.adjustment,
        total_symbols=len(targets),
        metadata={
            "symbols": targets,
            "limit": request.limit,
            "lookback_years": request.lookback_years,
            "start": request.start,
            "effective_start": ingestion_start_date(request).isoformat(),
            "end": request.end,
            "request_delay_seconds": request.request_delay_seconds,
            "max_retries": request.max_retries,
            "include_valuation_factors": request.include_valuation_factors,
            "source_strategy": "baostock-low-frequency-batch-enrichment",
            "batch_offset": effective_offset,
            "batch_size": request.batch_size,
            "next_offset": next_offset,
            "universe_total_symbols": len(all_targets),
            "field_contract": required_fields,
            "preflight_enabled": True,
        },
    )

    symbol_results: list[HistoryIngestionSymbolResult] = []

    all_required_fields = required_fields

    coverage_by_symbol = await get_history_ingestion_preflight(
        targets=targets,
        timeframe=request.period,
        adjustment=request.adjustment,
        lookback_years=request.lookback_years,
        start=request.start,
        end=request.end,
        require_fields=all_required_fields,
    )

    for target_index, target in enumerate(targets):
        required_fields = required_fields_for_target(request, target)
        coverage = coverage_by_symbol.get(target["symbol"])
        is_local_ready, missing_fields = local_coverage_ready(
            coverage,
            require_fields=required_fields,
        )
        if is_local_ready:
            symbol_results.append(
                skipped_existing_result(
                    target=target,
                    coverage=coverage,
                    missing_fields=missing_fields,
                )
            )
            continue
        try:
            kline = await fetch_baostock_kline_for_ingestion(
                baostock_client,
                target["query"],
                request,
            )
            symbol, rows_upserted, first_date, last_date = await upsert_kline_response(
                kline,
                universe_id=request.universe_id,
                lookback_years=request.lookback_years,
                start=request.start,
                end=request.end,
            )
            symbol_results.append(
                HistoryIngestionSymbolResult(
                    symbol=symbol,
                    name=kline.name,
                    secid=kline.secid,
                    source=kline.source,
                    status="success" if rows_upserted else "skipped",
                    bars_received=len(kline.bars),
                    rows_upserted=rows_upserted,
                    first_date=first_date,
                    last_date=last_date,
                )
            )
        except (ValueError, BaoStockError, DatabaseError) as error:
            symbol_results.append(
                HistoryIngestionSymbolResult(
                    symbol=target["symbol"],
                    status="failed",
                    error=str(error),
                )
            )
        if target_index < len(targets) - 1 and request.request_delay_seconds:
            await asyncio.sleep(request.request_delay_seconds)

    completed_symbols = len(
        [item for item in symbol_results if item.status in {"success", "skipped"}]
    )

    failed_symbols = len([item for item in symbol_results if item.status == "failed"])

    response = HistoryIngestionResponse(
        job_id=job_id,
        provider="baostock",
        status=(
            "failed" if completed_symbols == 0 else "partial" if failed_symbols else "completed"
        ),
        universe_id=request.universe_id,
        period=request.period,
        adjustment=request.adjustment,
        lookback_years=request.lookback_years,
        total_symbols=len(targets),
        completed_symbols=completed_symbols,
        failed_symbols=failed_symbols,
        rows_received=sum(item.bars_received for item in symbol_results),
        rows_upserted=sum(item.rows_upserted for item in symbol_results),
        symbols=symbol_results,
        batch_offset=effective_offset,
        batch_size=request.batch_size,
        next_offset=next_offset,
        universe_total_symbols=len(all_targets),
        started_at=started_at,
        completed_at=datetime.now(UTC),
    )

    await finish_ingestion_job(response)

    return response
