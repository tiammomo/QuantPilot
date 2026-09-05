from __future__ import annotations

import asyncio
import os
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from pathlib import Path
from uuid import uuid4

import psycopg
import pytest
from psycopg.types.json import Jsonb

from quantpilot_market_data.contracts.fundamentals import FinancialReportItem
from quantpilot_market_data.database_core import DatabaseError
from quantpilot_market_data.repositories import financial_history as history

TEST_URL = os.getenv("MARKET_TEST_DATABASE_URL", "")
pytestmark = pytest.mark.skipif(not TEST_URL, reason="requires isolated MARKET_TEST_DATABASE_URL")


@pytest.fixture(autouse=True)
def isolated_database(monkeypatch: pytest.MonkeyPatch):
    with psycopg.connect(TEST_URL) as connection:
        if not connection.info.dbname.endswith("_test"):
            pytest.fail(
                "Financial history integration requires a disposable database ending in _test"
            )
        connection.execute(
            (
                Path(__file__).resolve().parents[3] / "sqls/010-financial-report-versions.sql"
            ).read_text(),
        )

    async def connect():
        return await psycopg.AsyncConnection.connect(TEST_URL)

    monkeypatch.setattr(history, "connect", connect)


def report(symbol: str, revenue: int, *, notice: datetime | None = None) -> FinancialReportItem:
    return FinancialReportItem(
        symbol=symbol,
        report_date=datetime(2020, 12, 31, tzinfo=UTC),
        notice_date=notice,
        revenue=Decimal(revenue),
        raw={"source_record": "fixture"},
    )


def test_revisions_are_frozen_deduplicated_and_preserve_reversions() -> None:
    async def scenario():
        symbol = f"fixture-{uuid4()}"
        a = report(symbol, 100, notice=datetime(2021, 4, 1, tzinfo=UTC))
        b = a.model_copy(update={"revenue": Decimal(200)})
        before = datetime.now(UTC) - timedelta(seconds=1)
        first = await history.capture_financial_versions(
            symbol=symbol, provider="fixture", reports=[a]
        )
        duplicate = await history.capture_financial_versions(
            symbol=symbol,
            provider="fixture",
            reports=[a],
        )
        assert duplicate.inserted_versions == 0
        assert duplicate.unchanged_versions == 1
        assert duplicate.snapshot.data_version == first.snapshot.data_version
        await history.capture_financial_versions(symbol=symbol, provider="fixture", reports=[b])
        frozen = await history.read_financial_snapshot(
            symbol=symbol,
            provider="fixture",
            cutoff=first.snapshot.cutoff,
            limit=8,
        )
        assert frozen.reports[0].revenue == 100
        assert frozen.knowledge.data_version == first.snapshot.data_version
        latest = await history.read_financial_snapshot(
            symbol=symbol,
            provider="fixture",
            cutoff=datetime.now(UTC),
            limit=8,
        )
        assert latest.reports[0].revenue == 200
        reverted = await history.capture_financial_versions(
            symbol=symbol,
            provider="fixture",
            reports=[a],
        )
        assert reverted.inserted_versions == 1
        assert reverted.snapshot.vintages[0].revision_id != first.snapshot.vintages[0].revision_id
        reverted_read = await history.read_financial_snapshot(
            symbol=symbol,
            provider="fixture",
            cutoff=datetime.now(UTC),
            limit=8,
        )
        assert reverted_read.reports[0].revenue == 100
        too_early = await history.read_financial_snapshot(
            symbol=symbol,
            provider="fixture",
            cutoff=before,
            limit=8,
        )
        assert too_early.reports == []
        assert too_early.knowledge.point_in_time is True
        assert too_early.data_quality.status == "warning"

    asyncio.run(scenario())


def test_missing_notice_future_notice_and_future_period_are_excluded() -> None:
    async def scenario():
        for index, item in enumerate(
            [
                report("unused", 100),
                report("unused", 100, notice=datetime.now(UTC) + timedelta(days=1)),
                report("unused", 100, notice=datetime(2021, 1, 1, tzinfo=UTC)).model_copy(
                    update={"report_date": datetime.now(UTC) + timedelta(days=30)},
                ),
            ]
        ):
            symbol = f"unavailable-{index}-{uuid4()}"
            await history.capture_financial_versions(
                symbol=symbol, provider="fixture", reports=[item]
            )
            result = await history.read_financial_snapshot(
                symbol=symbol,
                provider="fixture",
                cutoff=datetime.now(UTC),
                limit=8,
            )
            assert result.reports == []

    asyncio.run(scenario())


def test_concurrent_capture_is_idempotent_and_immutable_in_postgres() -> None:
    async def scenario():
        symbol = f"concurrent-{uuid4()}"
        item = report(symbol, 100, notice=datetime(2021, 4, 1, tzinfo=UTC))
        captures = await asyncio.gather(
            *[
                history.capture_financial_versions(
                    symbol=symbol, provider="fixture", reports=[item]
                )
                for _ in range(2)
            ]
        )
        assert sum(capture.inserted_versions for capture in captures) == 1
        assert sum(capture.unchanged_versions for capture in captures) == 1
        assert captures[0].snapshot.data_version == captures[1].snapshot.data_version
        revision_id = captures[0].snapshot.vintages[0].revision_id
        for statement, params in [
            ("DELETE FROM quant.financial_report_versions WHERE revision_id = %s", (revision_id,)),
            (
                "UPDATE quant.financial_report_versions SET payload = '{}' WHERE revision_id = %s",
                (revision_id,),
            ),
            ("TRUNCATE quant.financial_report_versions", ()),
        ]:
            with (
                pytest.raises(psycopg.errors.RaiseException, match="immutable"),
                psycopg.connect(TEST_URL) as connection,
            ):
                connection.execute(statement, params)

    asyncio.run(scenario())


def test_corrupted_content_stops_reading_instead_of_returning_unverified_data() -> None:
    async def scenario():
        symbol = f"corrupt-{uuid4()}"
        with psycopg.connect(TEST_URL) as connection:
            connection.execute(
                """INSERT INTO quant.financial_report_versions
                   (revision_id, symbol, provider, report_date, notice_at,
                    observed_at, available_at, content_sha256, payload)
                   VALUES (%s, %s, 'fixture', '2020-12-31', '2021-04-01',
                           '2021-04-02', '2021-04-02', %s, %s)""",
                (uuid4(), symbol, "0" * 64, Jsonb({"symbol": symbol, "revenue": "999"})),
            )
        with pytest.raises(DatabaseError, match="校验失败"):
            await history.read_financial_snapshot(
                symbol=symbol,
                provider="fixture",
                cutoff=datetime.now(UTC),
                limit=8,
            )

    asyncio.run(scenario())
