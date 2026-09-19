from __future__ import annotations

import asyncio
from datetime import UTC, datetime
from uuid import uuid4

from quantpilot_market_data.contracts.ingestion import (
    HistoryIngestionResponse,
    HistoryIngestionSymbolResult,
    RealtimeSnapshotIngestionRequest,
)
from quantpilot_market_data.database_core import (
    DatabaseError,
    normalize_fetch_symbol,
)
from quantpilot_market_data.providers.eastmoney import EastMoneyClient, EastMoneyError
from quantpilot_market_data.repositories.ingestion import (
    create_ingestion_job,
    finish_ingestion_job,
)
from quantpilot_market_data.repositories.universes import get_universe_fetch_targets
from quantpilot_market_data.repositories.upserts import (
    upsert_realtime_quote_snapshot,
)


async def ingest_eastmoney_realtime_snapshot(
    request: RealtimeSnapshotIngestionRequest,
    *,
    client: EastMoneyClient,
) -> HistoryIngestionResponse:
    started_at = datetime.now(UTC)

    job_id = f"ingest-eastmoney-snapshot-{started_at.strftime('%Y%m%d%H%M%S')}-{uuid4().hex[:8]}"

    all_targets = [
        {"symbol": symbol, "query": normalize_fetch_symbol(symbol)}
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
            "source_strategy": "eastmoney-realtime-snapshot-isolated",
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
            "failed" if completed_symbols == 0 else "partial" if failed_symbols else "completed"
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
