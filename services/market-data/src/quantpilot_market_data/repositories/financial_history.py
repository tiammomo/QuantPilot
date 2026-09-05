from __future__ import annotations

import hashlib
import json
from datetime import UTC, datetime
from uuid import uuid4

import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb

from quantpilot_market_data.contracts.fundamentals import (
    FinancialKnowledgeSnapshot,
    FinancialReportCaptureResponse,
    FinancialReportItem,
    FinancialReportsResponse,
    FinancialReportVintage,
)
from quantpilot_market_data.database_core import DatabaseError, connect

HISTORY_LIMITATION = (
    "仅使用本平台在截止时点前已观测且已公告的财报版本；"
    "首次采集前的历史、缺少公告时间的记录不会回填为当时已知数据。"
)


def content_hash(payload: dict) -> str:
    encoded = json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def knowledge_snapshot(
    vintages: list[FinancialReportVintage], *, cutoff: datetime, point_in_time: bool
) -> FinancialKnowledgeSnapshot:
    # Query ordering is deterministic, so a frozen cutoff yields the same version.
    version = content_hash(
        {
            "schema_version": 1,
            "vintages": [(item.revision_id, item.content_sha256) for item in vintages],
        }
    )
    return FinancialKnowledgeSnapshot(
        point_in_time=point_in_time,
        cutoff=cutoff,
        data_version=version,
        vintages=vintages,
        limitation=HISTORY_LIMITATION,
    )


def _vintage(row: dict) -> FinancialReportVintage:
    return FinancialReportVintage(
        revision_id=str(row["revision_id"]),
        content_sha256=row["content_sha256"],
        observed_at=row["observed_at"],
        available_at=row["available_at"],
    )


async def capture_financial_versions(
    *, symbol: str, provider: str, reports: list[FinancialReportItem]
) -> FinancialReportCaptureResponse:
    inserted = 0
    unchanged = 0
    missing_periods = 0
    missing_notices = 0
    vintages: list[FinancialReportVintage] = []
    try:
        async with (
            await connect() as connection,
            connection.cursor(row_factory=dict_row) as cursor,
        ):
            # Serialize captures for one provider/security, including A -> B -> A
            # revisions. Global content deduplication would lose that reversion.
            await cursor.execute(
                "SELECT pg_advisory_xact_lock(hashtextextended(%s, 0))",
                (f"financial-history:{provider}:{symbol}",),
            )
            await cursor.execute("SELECT clock_timestamp() AS observed_at")
            observed_at = (await cursor.fetchone())["observed_at"]
            periods = set()
            for report in sorted(
                reports,
                key=lambda item: (
                    item.report_date.isoformat() if item.report_date else "",
                    item.notice_date.isoformat() if item.notice_date else "",
                ),
                reverse=True,
            ):
                if report.report_date is None:
                    missing_periods += 1
                    continue
                period = report.report_date.date()
                if period in periods:
                    raise ValueError("同次采集包含同一报告期的多个版本，必须先核实源数据。")
                periods.add(period)
                notice_at = report.notice_date
                if notice_at is not None and notice_at.tzinfo is None:
                    raise ValueError("财报公告时间必须携带时区。")
                if notice_at is None:
                    missing_notices += 1
                payload = report.model_dump(mode="json")
                digest = content_hash(payload)
                await cursor.execute(
                    """SELECT revision_id, content_sha256, observed_at, available_at
                       FROM quant.financial_report_versions
                       WHERE symbol = %s AND provider = %s AND report_date = %s
                       ORDER BY observed_at DESC, revision_id DESC LIMIT 1""",
                    (symbol, provider, period),
                )
                previous = await cursor.fetchone()
                if previous and previous["content_sha256"] == digest:
                    unchanged += 1
                    vintages.append(_vintage(previous))
                    continue
                available_at = max(observed_at, notice_at) if notice_at else None
                await cursor.execute(
                    """INSERT INTO quant.financial_report_versions
                       (revision_id, symbol, provider, report_date, notice_at,
                        observed_at, available_at, content_sha256, payload)
                       VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
                       RETURNING revision_id, content_sha256, observed_at, available_at""",
                    (
                        uuid4(),
                        symbol,
                        provider,
                        period,
                        notice_at,
                        observed_at,
                        available_at,
                        digest,
                        Jsonb(payload),
                    ),
                )
                vintages.append(_vintage(await cursor.fetchone()))
                inserted += 1
    except psycopg.Error as error:
        raise DatabaseError("财报历史版本存储不可用，请检查数据库与 010 号 SQL。") from error
    return FinancialReportCaptureResponse(
        symbol=symbol,
        provider=provider,
        received_reports=len(reports),
        inserted_versions=inserted,
        unchanged_versions=unchanged,
        missing_report_dates=missing_periods,
        missing_notice_dates=missing_notices,
        snapshot=knowledge_snapshot(vintages, cutoff=observed_at, point_in_time=False),
    )


async def read_financial_snapshot(
    *, symbol: str, provider: str, cutoff: datetime, limit: int
) -> FinancialReportsResponse:
    if cutoff.tzinfo is None:
        raise ValueError("as_of 必须包含时区，例如 2026-09-06T00:00:00+08:00。")
    if cutoff > datetime.now(UTC):
        raise ValueError("as_of 不能晚于当前时刻。")
    try:
        async with (
            await connect() as connection,
            connection.cursor(row_factory=dict_row) as cursor,
        ):
            await cursor.execute(
                """SELECT * FROM (
                     SELECT DISTINCT ON (report_date)
                       report_date, revision_id, content_sha256, observed_at,
                       available_at, payload
                     FROM quant.financial_report_versions
                     WHERE symbol = %s AND provider = %s
                       AND available_at <= %s AND observed_at <= %s
                       AND report_date <= (%s::timestamptz AT TIME ZONE 'Asia/Shanghai')::date
                     ORDER BY report_date DESC, observed_at DESC, revision_id DESC
                   ) versions ORDER BY report_date DESC LIMIT %s""",
                (symbol, provider, cutoff, cutoff, cutoff, limit),
            )
            rows = await cursor.fetchall()
    except psycopg.Error as error:
        raise DatabaseError("财报历史版本不可用；禁止回退到最新财报。") from error
    for row in rows:
        if content_hash(row["payload"]) != row["content_sha256"]:
            raise DatabaseError("财报版本内容校验失败，停止历史查询。")
    return FinancialReportsResponse(
        symbol=symbol,
        source=provider,
        reports=[FinancialReportItem.model_validate(row["payload"]) for row in rows],
        as_of=cutoff,
        fetched_at=datetime.now(UTC),
        knowledge=knowledge_snapshot(
            [_vintage(row) for row in rows], cutoff=cutoff, point_in_time=True
        ),
    )
