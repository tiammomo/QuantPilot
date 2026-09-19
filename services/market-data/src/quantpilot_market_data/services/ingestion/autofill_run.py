from __future__ import annotations

import asyncio
import logging
from datetime import UTC, datetime

from quantpilot_market_data.contracts.ingestion import (
    HistoryAutoFillIngestionRequest,
    HistoryIngestionResponse,
    HistoryIngestionSymbolResult,
)
from quantpilot_market_data.database_core import (
    DatabaseError,
)
from quantpilot_market_data.providers.baostock import BaoStockClient, BaoStockError
from quantpilot_market_data.repositories.ingestion import (
    create_ingestion_job,
    finish_ingestion_job,
    get_history_ingestion_preflight,
    update_ingestion_job_progress,
)
from quantpilot_market_data.repositories.upserts import (
    upsert_kline_response,
)
from quantpilot_market_data.services.ingestion.support import (
    baostock_required_fields,
    fetch_baostock_kline_for_ingestion,
    ingestion_result_counts,
    ingestion_start_date,
    local_coverage_ready,
    required_fields_for_target,
    skipped_existing_result,
    wait_for_autofill_control,
)


async def run_baostock_history_autofill(
    *,
    parent_job_id: str,
    request: HistoryAutoFillIngestionRequest,
    all_targets: list[dict[str, str]],
    start_offset: int,
    max_batches: int,
    started_at: datetime,
    baostock_client: BaoStockClient,
) -> None:
    active_child_job_id: str | None = None
    current_offset = start_offset

    completed_batches = 0

    completed_total = 0

    failed_total = 0

    rows_received_total = 0

    rows_upserted_total = 0

    child_job_ids: list[str] = []

    final_next_offset = current_offset

    stop_reason = "completed"

    autofill_required_fields = baostock_required_fields(request)

    total_batches = max(
        1,
        ((len(all_targets) - start_offset) + request.batch_size - 1) // request.batch_size,
    )

    try:
        while completed_batches < max_batches:
            effective_offset = current_offset if current_offset < len(all_targets) else 0
            targets = all_targets[effective_offset : effective_offset + request.batch_size]
            if not targets:
                final_next_offset = 0
                stop_reason = "no_targets"
                break

            control = await wait_for_autofill_control(
                parent_job_id=parent_job_id,
                child_job_id=None,
                current_symbol=None,
                effective_offset=effective_offset,
                next_offset=effective_offset,
                completed_batches=completed_batches,
                total_batches=total_batches,
                completed_symbols=completed_total,
                failed_symbols=failed_total,
                rows_received=rows_received_total,
                rows_upserted=rows_upserted_total,
                all_target_count=len(all_targets),
            )
            if control == "stop":
                final_next_offset = effective_offset
                stop_reason = "stopped"
                break

            next_offset = effective_offset + len(targets)
            if next_offset >= len(all_targets):
                next_offset = 0
            child_job_id = f"{parent_job_id}-batch-{completed_batches + 1:04d}"
            child_job_ids.append(child_job_id)
            active_child_job_id = child_job_id
            coverage_by_symbol = await get_history_ingestion_preflight(
                targets=targets,
                timeframe=request.period,
                adjustment=request.adjustment,
                lookback_years=request.lookback_years,
                start=request.start,
                end=request.end,
                require_fields=autofill_required_fields,
            )
            await create_ingestion_job(
                job_id=child_job_id,
                universe_id=request.universe_id,
                provider="baostock",
                timeframe=request.period,
                adjustment=request.adjustment,
                total_symbols=len(targets),
                metadata={
                    "parent_job_id": parent_job_id,
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
                    "autofill": True,
                    "field_contract": autofill_required_fields,
                    "preflight_enabled": True,
                },
            )
            await update_ingestion_job_progress(
                job_id=parent_job_id,
                status="running",
                completed_symbols=completed_total,
                failed_symbols=failed_total,
                rows_received=rows_received_total,
                rows_upserted=rows_upserted_total,
                metadata={
                    "completed_batches": completed_batches,
                    "total_batches": total_batches,
                    "active_child_job_id": child_job_id,
                    "latest_child_job_id": child_job_id,
                    "child_job_ids": child_job_ids[-100:],
                    "batch_offset": effective_offset,
                    "batch_size": request.batch_size,
                    "next_offset": effective_offset,
                    "universe_total_symbols": len(all_targets),
                    "current_batch_symbol_total": len(targets),
                    "current_batch_completed_symbols": 0,
                    "current_symbol": targets[0]["symbol"] if targets else None,
                    "current_symbol_index": effective_offset,
                    "last_heartbeat_at": datetime.now(UTC).isoformat(),
                },
            )

            symbol_results: list[HistoryIngestionSymbolResult] = []
            local_ready_results: list[HistoryIngestionSymbolResult] = []
            for target in targets:
                required_fields = required_fields_for_target(request, target)
                coverage = coverage_by_symbol.get(target["symbol"])
                is_local_ready, missing_fields = local_coverage_ready(
                    coverage,
                    require_fields=required_fields,
                )
                if not is_local_ready:
                    break
                local_ready_results.append(
                    skipped_existing_result(
                        target=target,
                        coverage=coverage,
                        missing_fields=missing_fields,
                    )
                )
            if len(local_ready_results) == len(targets):
                symbol_results = local_ready_results
                child_response = HistoryIngestionResponse(
                    job_id=child_job_id,
                    provider="baostock",
                    status="completed",
                    universe_id=request.universe_id,
                    period=request.period,
                    adjustment=request.adjustment,
                    lookback_years=request.lookback_years,
                    total_symbols=len(targets),
                    completed_symbols=len(symbol_results),
                    failed_symbols=0,
                    rows_received=0,
                    rows_upserted=0,
                    symbols=symbol_results,
                    batch_offset=effective_offset,
                    batch_size=request.batch_size,
                    next_offset=next_offset,
                    universe_total_symbols=len(all_targets),
                    started_at=datetime.now(UTC),
                    completed_at=datetime.now(UTC),
                )
                await finish_ingestion_job(child_response)
                active_child_job_id = None
                completed_batches += 1
                completed_total += child_response.completed_symbols
                final_next_offset = next_offset
                await update_ingestion_job_progress(
                    job_id=parent_job_id,
                    status="running",
                    completed_symbols=completed_total,
                    failed_symbols=failed_total,
                    rows_received=rows_received_total,
                    rows_upserted=rows_upserted_total,
                    metadata={
                        "completed_batches": completed_batches,
                        "total_batches": total_batches,
                        "latest_child_job_id": child_job_id,
                        "active_child_job_id": None,
                        "child_job_ids": child_job_ids[-100:],
                        "batch_offset": effective_offset,
                        "next_offset": next_offset,
                        "universe_total_symbols": len(all_targets),
                        "latest_batch_status": child_response.status,
                        "current_batch_completed_symbols": len(targets),
                        "preflight_skipped_symbols": len(symbol_results),
                        "last_heartbeat_at": datetime.now(UTC).isoformat(),
                    },
                )
                if next_offset == 0:
                    stop_reason = "completed"
                    break
                current_offset = next_offset
                continue
            for target_index, target in enumerate(targets):
                absolute_index = effective_offset + target_index
                completed_so_far, failed_so_far, received_so_far, upserted_so_far = (
                    ingestion_result_counts(symbol_results)
                )
                await update_ingestion_job_progress(
                    job_id=parent_job_id,
                    status="running",
                    completed_symbols=completed_total + completed_so_far,
                    failed_symbols=failed_total + failed_so_far,
                    rows_received=rows_received_total + received_so_far,
                    rows_upserted=rows_upserted_total + upserted_so_far,
                    metadata={
                        "completed_batches": completed_batches,
                        "total_batches": total_batches,
                        "active_child_job_id": child_job_id,
                        "latest_child_job_id": child_job_id,
                        "batch_offset": effective_offset,
                        "batch_size": request.batch_size,
                        "next_offset": effective_offset,
                        "universe_total_symbols": len(all_targets),
                        "current_batch_symbol_total": len(targets),
                        "current_batch_completed_symbols": target_index,
                        "current_symbol": target["symbol"],
                        "current_symbol_index": absolute_index,
                        "last_heartbeat_at": datetime.now(UTC).isoformat(),
                    },
                )
                control = await wait_for_autofill_control(
                    parent_job_id=parent_job_id,
                    child_job_id=child_job_id,
                    current_symbol=target["symbol"],
                    effective_offset=effective_offset,
                    next_offset=effective_offset + target_index,
                    completed_batches=completed_batches,
                    total_batches=total_batches,
                    completed_symbols=completed_total + completed_so_far,
                    failed_symbols=failed_total + failed_so_far,
                    rows_received=rows_received_total + received_so_far,
                    rows_upserted=rows_upserted_total + upserted_so_far,
                    all_target_count=len(all_targets),
                )
                if control == "stop":
                    final_next_offset = absolute_index
                    stop_reason = "stopped"
                    break

                coverage = coverage_by_symbol.get(target["symbol"])
                required_fields = required_fields_for_target(request, target)
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
                else:
                    try:
                        kline = await fetch_baostock_kline_for_ingestion(
                            baostock_client,
                            target["query"],
                            request,
                        )
                        (
                            symbol,
                            rows_upserted,
                            first_date,
                            last_date,
                        ) = await upsert_kline_response(
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
                                missing_fields=missing_fields,
                            )
                        )
                    except (ValueError, BaoStockError, DatabaseError) as error:
                        symbol_results.append(
                            HistoryIngestionSymbolResult(
                                symbol=target["symbol"],
                                status="failed",
                                error=str(error),
                                missing_fields=missing_fields,
                            )
                        )

                if (
                    target_index < len(targets) - 1
                    and request.request_delay_seconds
                    and symbol_results[-1].source != "local"
                ):
                    await asyncio.sleep(request.request_delay_seconds)
                completed_so_far, failed_so_far, received_so_far, upserted_so_far = (
                    ingestion_result_counts(symbol_results)
                )
                skipped_existing = len(
                    [item for item in symbol_results if item.skip_reason == "local_coverage_ready"]
                )
                await update_ingestion_job_progress(
                    job_id=parent_job_id,
                    status="running",
                    completed_symbols=completed_total + completed_so_far,
                    failed_symbols=failed_total + failed_so_far,
                    rows_received=rows_received_total + received_so_far,
                    rows_upserted=rows_upserted_total + upserted_so_far,
                    metadata={
                        "completed_batches": completed_batches,
                        "total_batches": total_batches,
                        "active_child_job_id": child_job_id,
                        "latest_child_job_id": child_job_id,
                        "batch_offset": effective_offset,
                        "batch_size": request.batch_size,
                        "next_offset": (
                            final_next_offset if stop_reason == "stopped" else effective_offset
                        ),
                        "universe_total_symbols": len(all_targets),
                        "current_batch_symbol_total": len(targets),
                        "current_batch_completed_symbols": (
                            target_index if stop_reason == "stopped" else target_index + 1
                        ),
                        "current_symbol": target["symbol"],
                        "current_symbol_index": absolute_index,
                        "last_completed_symbol": (
                            None if stop_reason == "stopped" else target["symbol"]
                        ),
                        "preflight_skipped_symbols": skipped_existing,
                        "stop_reason": stop_reason if stop_reason == "stopped" else None,
                        "last_heartbeat_at": datetime.now(UTC).isoformat(),
                    },
                )
            if stop_reason == "stopped":
                if symbol_results:
                    partial_completed, partial_failed, _, _ = ingestion_result_counts(
                        symbol_results
                    )
                    child_response = HistoryIngestionResponse(
                        job_id=child_job_id,
                        provider="baostock",
                        status=(
                            "failed" if partial_completed == 0 and partial_failed > 0 else "partial"
                        ),
                        universe_id=request.universe_id,
                        period=request.period,
                        adjustment=request.adjustment,
                        lookback_years=request.lookback_years,
                        total_symbols=len(targets),
                        completed_symbols=partial_completed,
                        failed_symbols=partial_failed,
                        rows_received=sum(item.bars_received for item in symbol_results),
                        rows_upserted=sum(item.rows_upserted for item in symbol_results),
                        symbols=symbol_results,
                        batch_offset=effective_offset,
                        batch_size=request.batch_size,
                        next_offset=final_next_offset,
                        universe_total_symbols=len(all_targets),
                        started_at=datetime.now(UTC),
                        completed_at=datetime.now(UTC),
                    )
                    await finish_ingestion_job(child_response)
                    active_child_job_id = None
                    completed_total += child_response.completed_symbols
                    failed_total += child_response.failed_symbols
                    rows_received_total += child_response.rows_received
                    rows_upserted_total += child_response.rows_upserted
                break

            completed_symbols = len(
                [item for item in symbol_results if item.status in {"success", "skipped"}]
            )
            failed_symbols = len([item for item in symbol_results if item.status == "failed"])
            child_response = HistoryIngestionResponse(
                job_id=child_job_id,
                provider="baostock",
                status=(
                    "failed"
                    if completed_symbols == 0
                    else "partial"
                    if failed_symbols
                    else "completed"
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
                started_at=datetime.now(UTC),
                completed_at=datetime.now(UTC),
            )
            await finish_ingestion_job(child_response)
            active_child_job_id = None

            completed_batches += 1
            completed_total += child_response.completed_symbols
            failed_total += child_response.failed_symbols
            rows_received_total += child_response.rows_received
            rows_upserted_total += child_response.rows_upserted
            final_next_offset = next_offset
            await update_ingestion_job_progress(
                job_id=parent_job_id,
                status="running",
                completed_symbols=completed_total,
                failed_symbols=failed_total,
                rows_received=rows_received_total,
                rows_upserted=rows_upserted_total,
                metadata={
                    "completed_batches": completed_batches,
                    "total_batches": total_batches,
                    "latest_child_job_id": child_job_id,
                    "active_child_job_id": None,
                    "child_job_ids": child_job_ids[-100:],
                    "batch_offset": effective_offset,
                    "next_offset": next_offset,
                    "universe_total_symbols": len(all_targets),
                    "latest_batch_status": child_response.status,
                    "current_batch_completed_symbols": len(targets),
                    "last_heartbeat_at": datetime.now(UTC).isoformat(),
                },
            )

            if next_offset == 0:
                stop_reason = "completed"
                break
            current_offset = next_offset
            if request.batch_delay_seconds:
                slept = 0.0
                while slept < request.batch_delay_seconds:
                    control = await wait_for_autofill_control(
                        parent_job_id=parent_job_id,
                        child_job_id=None,
                        current_symbol=None,
                        effective_offset=next_offset,
                        next_offset=next_offset,
                        completed_batches=completed_batches,
                        total_batches=total_batches,
                        completed_symbols=completed_total,
                        failed_symbols=failed_total,
                        rows_received=rows_received_total,
                        rows_upserted=rows_upserted_total,
                        all_target_count=len(all_targets),
                    )
                    if control == "stop":
                        stop_reason = "stopped"
                        break
                    step = min(1.0, request.batch_delay_seconds - slept)
                    await asyncio.sleep(step)
                    slept += step
                if stop_reason == "stopped":
                    break

        if stop_reason != "stopped" and final_next_offset != 0 and completed_batches >= max_batches:
            stop_reason = "max_batches"
        final_status = (
            "failed"
            if completed_total == 0 and failed_total > 0
            else "partial"
            if failed_total or final_next_offset != 0
            else "completed"
        )
        completed_at = datetime.now(UTC)
        await update_ingestion_job_progress(
            job_id=parent_job_id,
            status=final_status,
            completed_symbols=completed_total,
            failed_symbols=failed_total,
            rows_received=rows_received_total,
            rows_upserted=rows_upserted_total,
            error=(
                f"自动补齐未跑完整，停止原因：{stop_reason}，下批 offset={final_next_offset}"
                if final_status == "partial" and final_next_offset != 0
                else None
            ),
            metadata={
                "completed_batches": completed_batches,
                "total_batches": total_batches,
                "active_child_job_id": None,
                "child_job_ids": child_job_ids[-100:],
                "next_offset": final_next_offset,
                "control": "idle",
                "universe_total_symbols": len(all_targets),
                "stop_reason": stop_reason,
                "started_at": started_at.isoformat(),
                "completed_at": completed_at.isoformat(),
            },
            completed_at=completed_at,
        )
    except asyncio.CancelledError:
        # The application owns these tasks. Graceful shutdown must not leave
        # their durable parent/child records looking as though work is running.
        for interrupted_job in filter(None, [active_child_job_id, parent_job_id]):
            try:
                await update_ingestion_job_progress(
                    job_id=interrupted_job,
                    status="failed",
                    error="服务退出，补数任务已中断；请检查已保存进度后重新发起。",
                    metadata={"control": "idle", "stop_reason": "shutdown"},
                    completed_at=datetime.now(UTC),
                )
            except Exception:
                logging.getLogger(__name__).exception("Failed to record interrupted ingestion")
        raise
    except Exception as error:
        completed_at = datetime.now(UTC)
        await update_ingestion_job_progress(
            job_id=parent_job_id,
            status="failed",
            completed_symbols=completed_total,
            failed_symbols=failed_total,
            rows_received=rows_received_total,
            rows_upserted=rows_upserted_total,
            error=str(error),
            metadata={
                "completed_batches": completed_batches,
                "child_job_ids": child_job_ids[-100:],
                "next_offset": final_next_offset,
                "control": "idle",
                "stop_reason": "error",
                "completed_at": completed_at.isoformat(),
            },
            completed_at=completed_at,
        )
