from __future__ import annotations

import asyncio
from datetime import UTC, datetime
from uuid import uuid4

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware

from quantpilot_market_data.cache import MarketDataCache, RedisJsonCache, ttl_from_env
from quantpilot_market_data.database_core import (
    DatabaseError,
    normalize_fetch_symbol,
)
from quantpilot_market_data.models import (
    AutoFillIngestionStartResponse,
    HistoryAutoFillIngestionRequest,
    HistoryBatchIngestionRequest,
    HistoryIngestionRequest,
    HistoryIngestionResponse,
    HistoryIngestionSymbolResult,
    RealtimeSnapshotIngestionRequest,
)
from quantpilot_market_data.providers.akshare import AkShareClient, AkShareError
from quantpilot_market_data.providers.baostock import BaoStockClient, BaoStockError
from quantpilot_market_data.providers.eastmoney import EastMoneyClient, EastMoneyError
from quantpilot_market_data.repositories.ingestion import (
    create_ingestion_job,
    finish_ingestion_job,
    get_history_ingestion_preflight,
    update_ingestion_job_progress,
)
from quantpilot_market_data.repositories.universes import get_universe_fetch_targets
from quantpilot_market_data.repositories.upserts import (
    upsert_kline_response,
    upsert_realtime_quote_snapshot,
)
from quantpilot_market_data.routers.analytics import router as analytics_router
from quantpilot_market_data.routers.backtests import create_backtest_router
from quantpilot_market_data.routers.events import create_events_router
from quantpilot_market_data.routers.foundation import router as foundation_router
from quantpilot_market_data.routers.fundamentals import create_fundamentals_router
from quantpilot_market_data.routers.indicators import create_indicators_router
from quantpilot_market_data.routers.ingestion import router as ingestion_router
from quantpilot_market_data.routers.provider_candidates import (
    router as provider_candidates_router,
)
from quantpilot_market_data.routers.quotes import create_quotes_router
from quantpilot_market_data.routers.registry import create_registry_router
from quantpilot_market_data.routers.research import create_research_router
from quantpilot_market_data.services.ingestion_support import (
    baostock_required_fields,
    fetch_akshare_kline_for_ingestion,
    fetch_baostock_kline_for_ingestion,
    fetch_kline_for_ingestion,
    ingestion_result_counts,
    ingestion_start_date,
    local_coverage_ready,
    required_fields_for_target,
    skipped_existing_result,
    wait_for_autofill_control,
)
from quantpilot_market_data.services.registry import ProviderRegistryTtls

QUOTE_CACHE_TTL_SECONDS = ttl_from_env("QUANTPILOT_QUOTE_CACHE_TTL_SECONDS", 5)
SYMBOL_CACHE_TTL_SECONDS = ttl_from_env("QUANTPILOT_SYMBOL_CACHE_TTL_SECONDS", 86400)
KLINE_CACHE_TTL_SECONDS = ttl_from_env("QUANTPILOT_KLINE_CACHE_TTL_SECONDS", 1800)
FINANCIAL_CACHE_TTL_SECONDS = ttl_from_env("QUANTPILOT_FINANCIAL_CACHE_TTL_SECONDS", 21600)
ANNOUNCEMENT_CACHE_TTL_SECONDS = ttl_from_env("QUANTPILOT_ANNOUNCEMENT_CACHE_TTL_SECONDS", 600)
SCREENER_CACHE_TTL_SECONDS = ttl_from_env("QUANTPILOT_SCREENER_CACHE_TTL_SECONDS", 60)
def create_app() -> FastAPI:
    app = FastAPI(
        title="QuantPilot Market Data API",
        description="QuantPilot 量化分析 Agent 的市场数据后端",
        version="0.1.0",
    )
    app.add_middleware(
        CORSMiddleware,
        allow_origin_regex=r"^https?://(localhost|127\.0\.0\.1):\d+$",
        allow_credentials=False,
        allow_methods=["GET", "POST", "OPTIONS"],
        allow_headers=["*"],
    )
    client = EastMoneyClient()
    akshare_client = AkShareClient()
    baostock_client = BaoStockClient()
    cache = MarketDataCache()
    intraday_redis_cache = RedisJsonCache()
    auto_fill_tasks: set[asyncio.Task[None]] = set()

    app.include_router(analytics_router)
    app.include_router(foundation_router)
    app.include_router(ingestion_router)
    app.include_router(provider_candidates_router)
    app.include_router(
        create_backtest_router(
            client=client,
            cache=cache,
            kline_cache_ttl_seconds=KLINE_CACHE_TTL_SECONDS,
        )
    )
    app.include_router(
        create_events_router(
            announcement_client=client,
            dividend_client=client,
            cache=cache,
            announcement_cache_ttl_seconds=ANNOUNCEMENT_CACHE_TTL_SECONDS,
            financial_cache_ttl_seconds=FINANCIAL_CACHE_TTL_SECONDS,
        )
    )
    app.include_router(
        create_fundamentals_router(
            client=client,
            cache=cache,
            financial_cache_ttl_seconds=FINANCIAL_CACHE_TTL_SECONDS,
        )
    )
    app.include_router(
        create_indicators_router(
            client=client,
            cache=cache,
            kline_cache_ttl_seconds=KLINE_CACHE_TTL_SECONDS,
        )
    )
    app.include_router(
        create_quotes_router(
            client=client,
            cache=cache,
            intraday_redis_cache=intraday_redis_cache,
            symbol_cache_ttl_seconds=SYMBOL_CACHE_TTL_SECONDS,
            quote_cache_ttl_seconds=QUOTE_CACHE_TTL_SECONDS,
            kline_cache_ttl_seconds=KLINE_CACHE_TTL_SECONDS,
        )
    )
    app.include_router(create_research_router(client))
    app.include_router(
        create_registry_router(
            ProviderRegistryTtls(
                quote=QUOTE_CACHE_TTL_SECONDS,
                symbol=SYMBOL_CACHE_TTL_SECONDS,
                kline=KLINE_CACHE_TTL_SECONDS,
                financial=FINANCIAL_CACHE_TTL_SECONDS,
                announcement=ANNOUNCEMENT_CACHE_TTL_SECONDS,
                screener=SCREENER_CACHE_TTL_SECONDS,
            )
        )
    )

    @app.get("/health")
    async def health() -> dict[str, str]:
        return {"status": "ok"}

    @app.post("/api/v1/ingestion/eastmoney/history", response_model=HistoryIngestionResponse)
    async def ingest_eastmoney_history(
        request: HistoryIngestionRequest,
    ) -> HistoryIngestionResponse:
        started_at = datetime.now(UTC)
        job_id = f"ingest-{started_at.strftime('%Y%m%d%H%M%S')}-{uuid4().hex[:8]}"
        try:
            targets = [
                {
                    "symbol": symbol,
                    "query": normalize_fetch_symbol(symbol),
                    "asset_type": "stock",
                }
                for symbol in (request.symbols or [])
            ]
            if not targets and request.universe_id:
                targets = await get_universe_fetch_targets(request.universe_id)
            if not targets:
                raise HTTPException(status_code=400, detail="未指定 symbols，且股票池没有成员。")

            await create_ingestion_job(
                job_id=job_id,
                universe_id=request.universe_id,
                provider="eastmoney",
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
                    "allow_fallback": request.allow_fallback,
                    "request_delay_seconds": request.request_delay_seconds,
                    "max_retries": request.max_retries,
                    "include_valuation_factors": request.include_valuation_factors,
                },
            )

            symbol_results: list[HistoryIngestionSymbolResult] = []
            for target_index, target in enumerate(targets):
                try:
                    kline = await fetch_kline_for_ingestion(client, target["query"], request)
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
                except (ValueError, EastMoneyError, DatabaseError) as error:
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
                provider="eastmoney",
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
                started_at=started_at,
                completed_at=datetime.now(UTC),
            )
            await finish_ingestion_job(response)
            return response
        except DatabaseError as error:
            raise HTTPException(status_code=503, detail=str(error)) from error

    @app.post("/api/v1/ingestion/akshare/history", response_model=HistoryIngestionResponse)
    async def ingest_akshare_history(
        request: HistoryIngestionRequest,
    ) -> HistoryIngestionResponse:
        started_at = datetime.now(UTC)
        job_id = f"ingest-akshare-{started_at.strftime('%Y%m%d%H%M%S')}-{uuid4().hex[:8]}"
        try:
            targets = [
                {
                    "symbol": symbol,
                    "query": normalize_fetch_symbol(symbol),
                    "asset_type": "stock",
                }
                for symbol in (request.symbols or [])
            ]
            if not targets and request.universe_id:
                targets = await get_universe_fetch_targets(request.universe_id)
            if not targets:
                raise HTTPException(status_code=400, detail="未指定 symbols，且股票池没有成员。")

            await create_ingestion_job(
                job_id=job_id,
                universe_id=request.universe_id,
                provider="akshare",
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
                    "source_strategy": "akshare-field-enrichment",
                    "field_contract": [
                        "amount",
                        "amplitude",
                        "change_percent",
                        "change_amount",
                        "turnover",
                    ],
                },
            )

            symbol_results: list[HistoryIngestionSymbolResult] = []
            for target_index, target in enumerate(targets):
                try:
                    kline = await fetch_akshare_kline_for_ingestion(
                        akshare_client,
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
                except (ValueError, AkShareError, DatabaseError) as error:
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
                provider="akshare",
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
                started_at=started_at,
                completed_at=datetime.now(UTC),
            )
            await finish_ingestion_job(response)
            return response
        except DatabaseError as error:
            raise HTTPException(status_code=503, detail=str(error)) from error

    @app.post("/api/v1/ingestion/baostock/history", response_model=HistoryIngestionResponse)
    async def ingest_baostock_history(
        request: HistoryIngestionRequest,
    ) -> HistoryIngestionResponse:
        started_at = datetime.now(UTC)
        job_id = f"ingest-baostock-{started_at.strftime('%Y%m%d%H%M%S')}-{uuid4().hex[:8]}"
        try:
            targets = [
                {
                    "symbol": symbol,
                    "query": normalize_fetch_symbol(symbol),
                    "asset_type": "stock",
                }
                for symbol in (request.symbols or [])
            ]
            if not targets and request.universe_id:
                targets = await get_universe_fetch_targets(request.universe_id)
            if not targets:
                raise HTTPException(status_code=400, detail="未指定 symbols，且股票池没有成员。")
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
                    "source_strategy": "baostock-field-enrichment",
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
                started_at=started_at,
                completed_at=datetime.now(UTC),
            )
            await finish_ingestion_job(response)
            return response
        except DatabaseError as error:
            raise HTTPException(status_code=503, detail=str(error)) from error

    @app.post(
        "/api/v1/ingestion/baostock/history/batch",
        response_model=HistoryIngestionResponse,
    )
    async def ingest_baostock_history_batch(
        request: HistoryBatchIngestionRequest,
    ) -> HistoryIngestionResponse:
        started_at = datetime.now(UTC)
        job_id = f"ingest-baostock-batch-{started_at.strftime('%Y%m%d%H%M%S')}-{uuid4().hex[:8]}"
        try:
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
                raise HTTPException(status_code=400, detail="未指定 symbols，且股票池没有成员。")

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
                started_at=started_at,
                completed_at=datetime.now(UTC),
            )
            await finish_ingestion_job(response)
            return response
        except DatabaseError as error:
            raise HTTPException(status_code=503, detail=str(error)) from error

    async def run_baostock_history_autofill(
        *,
        parent_job_id: str,
        request: HistoryAutoFillIngestionRequest,
        all_targets: list[dict[str, str]],
        start_offset: int,
        max_batches: int,
        started_at: datetime,
    ) -> None:
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
            ((len(all_targets) - start_offset) + request.batch_size - 1)
            // request.batch_size,
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
                        [
                            item
                            for item in symbol_results
                            if item.skip_reason == "local_coverage_ready"
                        ]
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
                                final_next_offset
                                if stop_reason == "stopped"
                                else effective_offset
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
                                "failed"
                                if partial_completed == 0 and partial_failed > 0
                                else "partial"
                            ),
                            universe_id=request.universe_id,
                            period=request.period,
                            adjustment=request.adjustment,
                            lookback_years=request.lookback_years,
                            total_symbols=len(targets),
                            completed_symbols=partial_completed,
                            failed_symbols=partial_failed,
                            rows_received=sum(
                                item.bars_received for item in symbol_results
                            ),
                            rows_upserted=sum(
                                item.rows_upserted for item in symbol_results
                            ),
                            symbols=symbol_results,
                            batch_offset=effective_offset,
                            batch_size=request.batch_size,
                            next_offset=final_next_offset,
                            universe_total_symbols=len(all_targets),
                            started_at=datetime.now(UTC),
                            completed_at=datetime.now(UTC),
                        )
                        await finish_ingestion_job(child_response)
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

            if (
                stop_reason != "stopped"
                and final_next_offset != 0
                and completed_batches >= max_batches
            ):
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

    @app.post(
        "/api/v1/ingestion/baostock/history/autofill",
        response_model=AutoFillIngestionStartResponse,
    )
    async def start_baostock_history_autofill(
        request: HistoryAutoFillIngestionRequest,
    ) -> AutoFillIngestionStartResponse:
        started_at = datetime.now(UTC)
        job_id = f"ingest-baostock-autofill-{started_at.strftime('%Y%m%d%H%M%S')}-{uuid4().hex[:8]}"
        try:
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
                raise HTTPException(status_code=400, detail="未指定 symbols，且股票池没有成员。")

            effective_offset = request.offset if request.offset < len(all_targets) else 0
            calculated_batches = max(
                1,
                ((len(all_targets) - effective_offset) + request.batch_size - 1)
                // request.batch_size,
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

            task = asyncio.create_task(
                run_baostock_history_autofill(
                    parent_job_id=job_id,
                    request=request,
                    all_targets=all_targets,
                    start_offset=effective_offset,
                    max_batches=max_batches,
                    started_at=started_at,
                )
            )
            auto_fill_tasks.add(task)
            task.add_done_callback(auto_fill_tasks.discard)
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
        except DatabaseError as error:
            raise HTTPException(status_code=503, detail=str(error)) from error

    @app.post(
        "/api/v1/ingestion/eastmoney/realtime-snapshot",
        response_model=HistoryIngestionResponse,
    )
    async def ingest_eastmoney_realtime_snapshot(
        request: RealtimeSnapshotIngestionRequest,
    ) -> HistoryIngestionResponse:
        started_at = datetime.now(UTC)
        job_id = (
            f"ingest-eastmoney-snapshot-{started_at.strftime('%Y%m%d%H%M%S')}-"
            f"{uuid4().hex[:8]}"
        )
        try:
            all_targets = [
                {"symbol": symbol, "query": normalize_fetch_symbol(symbol)}
                for symbol in (request.symbols or [])
            ]
            if not all_targets and request.universe_id:
                all_targets = await get_universe_fetch_targets(request.universe_id)
            if not all_targets:
                raise HTTPException(status_code=400, detail="未指定 symbols，且股票池没有成员。")

            effective_offset = request.offset if request.offset < len(all_targets) else 0
            targets = all_targets[effective_offset : effective_offset + request.batch_size]
            next_offset = effective_offset + len(targets)
            if next_offset >= len(all_targets):
                next_offset = 0

            await create_ingestion_job(
                job_id=job_id,
                universe_id=request.universe_id,
                provider="eastmoney-realtime",
                timeframe="daily",
                adjustment=request.adjustment,
                total_symbols=len(targets),
                metadata={
                    "symbols": targets,
                    "trade_date": request.trade_date,
                    "batch_offset": effective_offset,
                    "batch_size": request.batch_size,
                    "next_offset": next_offset,
                    "universe_total_symbols": len(all_targets),
                    "source_strategy": "eastmoney-realtime-snapshot-daily-bar",
                    "field_contract": [
                        "open",
                        "high",
                        "low",
                        "close",
                        "previous_close",
                        "volume",
                        "amount",
                        "amplitude",
                        "change_percent",
                        "change_amount",
                        "turnover",
                    ],
                },
            )

            symbol_results: list[HistoryIngestionSymbolResult] = []
            try:
                quotes = await client.get_realtime_quotes([target["query"] for target in targets])
            except EastMoneyError as error:
                quotes = []
                symbol_results.extend(
                    HistoryIngestionSymbolResult(
                        symbol=target["symbol"],
                        status="failed",
                        error=str(error),
                    )
                    for target in targets
                )
            quotes_by_code = {quote.symbol: quote for quote in quotes}
            if quotes:
                for target in targets:
                    symbol = str(target["symbol"])
                    code = symbol.split(".", 1)[0]
                    quote = quotes_by_code.get(code)
                    if quote is None:
                        symbol_results.append(
                            HistoryIngestionSymbolResult(
                                symbol=symbol,
                                status="failed",
                                error="东方财富实时行情未返回该标的。",
                            )
                        )
                        continue
                    try:
                        (
                            canonical,
                            rows_upserted,
                            first_date,
                            last_date,
                        ) = await upsert_realtime_quote_snapshot(
                            quote,
                            universe_id=request.universe_id,
                            trade_date=request.trade_date,
                            adjustment=request.adjustment,
                        )
                        symbol_results.append(
                            HistoryIngestionSymbolResult(
                                symbol=canonical,
                                name=quote.name,
                                secid=quote.secid,
                                source=quote.source,
                                status="success" if rows_upserted else "skipped",
                                bars_received=1,
                                rows_upserted=rows_upserted,
                                first_date=first_date,
                                last_date=last_date,
                            )
                        )
                    except (ValueError, DatabaseError) as error:
                        symbol_results.append(
                            HistoryIngestionSymbolResult(
                                symbol=symbol,
                                status="failed",
                                error=str(error),
                            )
                        )
            if request.request_delay_seconds:
                await asyncio.sleep(request.request_delay_seconds)

            completed_symbols = len(
                [item for item in symbol_results if item.status in {"success", "skipped"}]
            )
            failed_symbols = len([item for item in symbol_results if item.status == "failed"])
            response = HistoryIngestionResponse(
                job_id=job_id,
                provider="eastmoney-realtime",
                status=(
                    "failed"
                    if completed_symbols == 0
                    else "partial"
                    if failed_symbols
                    else "completed"
                ),
                universe_id=request.universe_id,
                period="daily",
                adjustment=request.adjustment,
                lookback_years=1,
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
        except DatabaseError as error:
            raise HTTPException(status_code=503, detail=str(error)) from error

    return app


app = create_app()
