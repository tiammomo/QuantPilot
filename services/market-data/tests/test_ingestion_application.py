from __future__ import annotations

import asyncio
from datetime import UTC, datetime
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi.testclient import TestClient

from quantpilot_market_data import api
from quantpilot_market_data.api import create_app
from quantpilot_market_data.contracts.ingestion import (
    HistoryAutoFillIngestionRequest,
    HistoryBatchIngestionRequest,
    HistoryIngestionRequest,
    IngestionPreflightCoverage,
    RealtimeSnapshotIngestionRequest,
)
from quantpilot_market_data.database_core import DatabaseError
from quantpilot_market_data.providers.akshare import AkShareError
from quantpilot_market_data.providers.baostock import BaoStockError
from quantpilot_market_data.providers.eastmoney import EastMoneyError
from quantpilot_market_data.services.ingestion import (
    autofill,
    autofill_run,
    batch,
    history,
    snapshots,
)
from quantpilot_market_data.services.ingestion.tasks import IngestionTaskGroup

WRITES = [
    ("eastmoney/history", history, "ingest_eastmoney_history"),
    ("akshare/history", history, "ingest_akshare_history"),
    ("baostock/history", history, "ingest_baostock_history"),
    ("baostock/history/batch", batch, "ingest_baostock_history_batch"),
    ("baostock/history/autofill", autofill, "start_baostock_history_autofill"),
    ("eastmoney/realtime-snapshot", snapshots, "ingest_eastmoney_realtime_snapshot"),
]


@pytest.mark.parametrize(("endpoint", "module", "function"), WRITES)
def test_write_routers_authenticate_before_starting_a_use_case(
    monkeypatch,
    endpoint,
    module,
    function,
) -> None:
    monkeypatch.setenv("QUANTPILOT_MARKET_ADMIN_TOKEN", "isolated-ingestion-test")
    operation = AsyncMock()
    monkeypatch.setattr(module, function, operation)
    with TestClient(create_app()) as client:
        response = client.post(f"/api/v1/ingestion/{endpoint}", json={"symbols": ["600519"]})
    assert response.status_code == 401
    operation.assert_not_awaited()


@pytest.mark.parametrize(("endpoint", "module", "function"), WRITES)
@pytest.mark.parametrize(
    ("error", "status"), [(ValueError("empty pool"), 400), (DatabaseError("unavailable"), 503)]
)
def test_write_routers_translate_domain_errors(
    monkeypatch, endpoint, module, function, error, status
):
    monkeypatch.setenv("QUANTPILOT_MARKET_ADMIN_TOKEN", "isolated-ingestion-test")
    operation = AsyncMock(side_effect=error)
    monkeypatch.setattr(module, function, operation)
    with TestClient(create_app()) as client:
        response = client.post(
            f"/api/v1/ingestion/{endpoint}",
            json={"symbols": ["600519"]},
            headers={"Authorization": "Bearer isolated-ingestion-test"},
        )
    assert response.status_code == status
    assert response.json()["detail"] == str(error)
    operation.assert_awaited_once()


def mock_writes(monkeypatch, module):
    created, finished = AsyncMock(), AsyncMock()
    monkeypatch.setattr(module, "create_ingestion_job", created)
    monkeypatch.setattr(module, "finish_ingestion_job", finished)
    return created, finished


def kline():
    return SimpleNamespace(
        symbol="600519", name="fixture", secid="1.600519", source="fixture", bars=[1]
    )


def ready_coverage(symbol):
    return IngestionPreflightCoverage(
        symbol=symbol,
        row_count=1,
        rows_since_cutoff=1,
        complete_rows_since_cutoff=1,
        amount_count=1,
        turnover_count=1,
        trade_status_count=1,
        is_st_count=1,
        limit_up_count=1,
        limit_down_count=1,
    )


@pytest.mark.parametrize(
    ("provider", "client_arg", "fetch_name", "failure"),
    [
        ("eastmoney", "client", "fetch_kline_for_ingestion", EastMoneyError("offline")),
        ("akshare", "akshare_client", "fetch_akshare_kline_for_ingestion", AkShareError("offline")),
        (
            "baostock",
            "baostock_client",
            "fetch_baostock_kline_for_ingestion",
            BaoStockError("offline"),
        ),
    ],
)
def test_history_preserves_per_symbol_partial_results(
    monkeypatch, provider, client_arg, fetch_name, failure
):
    created, finished = mock_writes(monkeypatch, history)
    monkeypatch.setattr(history, "get_history_ingestion_preflight", AsyncMock(return_value={}))
    fetch = AsyncMock(side_effect=[kline(), failure])
    monkeypatch.setattr(history, fetch_name, fetch)
    monkeypatch.setattr(
        history,
        "upsert_kline_response",
        AsyncMock(return_value=("600519", 1, "2026-01-01", "2026-01-01")),
    )
    request = HistoryIngestionRequest(symbols=["600519", "000001"], request_delay_seconds=0)
    result = asyncio.run(
        getattr(history, f"ingest_{provider}_history")(request, **{client_arg: object()})
    )
    assert result.status == "partial"
    assert (result.completed_symbols, result.failed_symbols, result.rows_upserted) == (1, 1, 1)
    assert [item.status for item in result.symbols] == ["success", "failed"]
    assert result.provider == provider
    assert created.await_args.kwargs["provider"] == provider
    finished.assert_awaited_once_with(result)


def test_batch_skips_complete_local_data_and_wraps_the_last_offset(monkeypatch):
    created, finished = mock_writes(monkeypatch, batch)
    monkeypatch.setattr(
        batch,
        "get_history_ingestion_preflight",
        AsyncMock(return_value={"600519": ready_coverage("600519")}),
    )
    fetch = AsyncMock()
    monkeypatch.setattr(batch, "fetch_baostock_kline_for_ingestion", fetch)
    result = asyncio.run(
        batch.ingest_baostock_history_batch(
            HistoryBatchIngestionRequest(
                symbols=["000001", "600519"], offset=1, batch_size=1, request_delay_seconds=0
            ),
            baostock_client=object(),
        )
    )
    assert result.status == "completed"
    assert result.next_offset == 0
    assert result.batch_offset == 1
    assert result.symbols[0].skip_reason == "local_coverage_ready"
    assert created.await_args.kwargs["metadata"]["batch_offset"] == 1
    fetch.assert_not_awaited()
    finished.assert_awaited_once_with(result)


def test_snapshot_keeps_missing_quotes_as_partial_failure(monkeypatch):
    _, finished = mock_writes(monkeypatch, snapshots)
    monkeypatch.setattr(
        snapshots,
        "upsert_realtime_quote_snapshot",
        AsyncMock(return_value=("600519", 1, "2026-01-01", "2026-01-01")),
    )
    client = SimpleNamespace(get_realtime_quotes=AsyncMock(return_value=[kline()]))
    result = asyncio.run(
        snapshots.ingest_eastmoney_realtime_snapshot(
            RealtimeSnapshotIngestionRequest(symbols=["600519", "000001"], request_delay_seconds=0),
            client=client,
        )
    )
    assert result.status == "partial"
    assert result.failed_symbols == 1
    assert result.rows_upserted == 1
    finished.assert_awaited_once_with(result)


@pytest.mark.parametrize("stop", [False, True])
def test_autofill_advances_local_batches_or_honors_stop(monkeypatch, stop):
    _, finished = mock_writes(monkeypatch, autofill_run)
    progress = AsyncMock()
    monkeypatch.setattr(autofill_run, "update_ingestion_job_progress", progress)
    monkeypatch.setattr(
        autofill_run, "wait_for_autofill_control", AsyncMock(return_value="stop" if stop else "run")
    )
    symbols = ["600519", "000001"]
    monkeypatch.setattr(
        autofill_run,
        "get_history_ingestion_preflight",
        AsyncMock(return_value={symbol: ready_coverage(symbol) for symbol in symbols}),
    )
    fetch = AsyncMock()
    monkeypatch.setattr(autofill_run, "fetch_baostock_kline_for_ingestion", fetch)
    asyncio.run(
        autofill_run.run_baostock_history_autofill(
            parent_job_id="parent",
            request=HistoryAutoFillIngestionRequest(batch_size=1),
            all_targets=[{"symbol": s, "query": s, "asset_type": "stock"} for s in symbols],
            start_offset=0,
            max_batches=2,
            started_at=datetime.now(UTC),
            baostock_client=object(),
        )
    )
    assert finished.await_count == (0 if stop else 2)
    fetch.assert_not_awaited()
    final = progress.await_args.kwargs
    assert final["metadata"]["stop_reason"] == ("stopped" if stop else "completed")
    assert final["completed_symbols"] == (0 if stop else 2)


def test_shutdown_drains_tasks_and_records_parent_and_child_interruption(monkeypatch):
    mock_writes(monkeypatch, autofill_run)
    progress = AsyncMock()
    monkeypatch.setattr(autofill_run, "update_ingestion_job_progress", progress)
    monkeypatch.setattr(autofill_run, "wait_for_autofill_control", AsyncMock(return_value="run"))
    monkeypatch.setattr(autofill_run, "get_history_ingestion_preflight", AsyncMock(return_value={}))

    async def scenario():
        entered = asyncio.Event()

        async def blocked_fetch(*args):
            entered.set()
            await asyncio.Event().wait()

        monkeypatch.setattr(autofill_run, "fetch_baostock_kline_for_ingestion", blocked_fetch)
        group = IngestionTaskGroup()
        group.start(
            autofill_run.run_baostock_history_autofill(
                parent_job_id="parent",
                request=HistoryAutoFillIngestionRequest(),
                all_targets=[{"symbol": "600519", "query": "600519", "asset_type": "stock"}],
                start_offset=0,
                max_batches=1,
                started_at=datetime.now(UTC),
                baostock_client=object(),
            )
        )
        await asyncio.wait_for(entered.wait(), timeout=2)
        await asyncio.wait_for(group.close(), timeout=2)
        interrupted = [
            call.kwargs
            for call in progress.await_args_list
            if call.kwargs.get("status") == "failed"
        ]
        assert {item["job_id"] for item in interrupted} == {"parent", "parent-batch-0001"}
        assert all(item["metadata"]["stop_reason"] == "shutdown" for item in interrupted)
        with pytest.raises(RuntimeError, match="shutting down"):
            group.start(asyncio.sleep(0))

    asyncio.run(scenario())


def test_application_shutdown_only_drains_its_own_ingestion_tasks(monkeypatch):
    groups = [IngestionTaskGroup(), IngestionTaskGroup()]
    factory = iter(groups)
    monkeypatch.setattr(api, "IngestionTaskGroup", lambda: next(factory))
    first, second = create_app(), create_app()

    async def scenario():
        entered = [asyncio.Event(), asyncio.Event()]
        stopped = [asyncio.Event(), asyncio.Event()]

        async def operation(index):
            entered[index].set()
            try:
                await asyncio.Event().wait()
            finally:
                stopped[index].set()

        async with second.router.lifespan_context(second):
            async with first.router.lifespan_context(first):
                for index, group in enumerate(groups):
                    group.start(operation(index))
                await asyncio.wait_for(
                    asyncio.gather(*(event.wait() for event in entered)), timeout=2
                )
            assert stopped[0].is_set()
            assert not stopped[1].is_set()
        assert stopped[1].is_set()

    asyncio.run(scenario())
