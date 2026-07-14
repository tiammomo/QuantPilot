from __future__ import annotations

import asyncio
from datetime import UTC, date, datetime, timedelta
from zoneinfo import ZoneInfo

from quantpilot_market_data.models import (
    HistoryIngestionRequest,
    HistoryIngestionSymbolResult,
    KlineResponse,
)
from quantpilot_market_data.providers.akshare import AkShareClient
from quantpilot_market_data.providers.baostock import BaoStockClient
from quantpilot_market_data.providers.eastmoney import EastMoneyClient, EastMoneyError
from quantpilot_market_data.repositories.ingestion import (
    get_ingestion_job_control,
    update_ingestion_job_progress,
)

SHANGHAI_TZ = ZoneInfo("Asia/Shanghai")


def parse_bar_date(value: str):
    text = value.split(" ", 1)[0]
    try:
        return datetime.fromisoformat(text).date()
    except ValueError:
        return None


def parse_date_input(value: str | None) -> date | None:
    raw = (value or "").strip()
    if not raw:
        return None
    try:
        if len(raw) == 8 and raw.isdigit():
            return date(int(raw[:4]), int(raw[4:6]), int(raw[6:8]))
        return date.fromisoformat(raw[:10])
    except ValueError:
        return None


def lookback_cutoff_date(years: int):
    today = datetime.now(UTC).date()
    try:
        return today.replace(year=today.year - years)
    except ValueError:
        return today.replace(year=today.year - years, day=28)


def ingestion_start_date(request: HistoryIngestionRequest):
    start = parse_date_input(request.start)
    if start:
        return start
    return lookback_cutoff_date(request.lookback_years)


def ingestion_range_metadata(request: HistoryIngestionRequest) -> dict[str, str | int | None]:
    return {
        "start": ingestion_start_date(request).isoformat(),
        "end": None if request.end == "20500101" else request.end,
        "lookback_years": request.lookback_years,
    }


def provider_end_for_range(request: HistoryIngestionRequest) -> str:
    if request.end == "20500101":
        return request.end
    parsed = parse_date_input(request.end)
    return parsed.strftime("%Y%m%d") if parsed else request.end


def provider_start_for_ymd(request: HistoryIngestionRequest) -> str:
    return ingestion_start_date(request).strftime("%Y%m%d")


def provider_start_for_iso(request: HistoryIngestionRequest) -> str:
    return ingestion_start_date(request).isoformat()


def local_date_text(value: datetime | None) -> str | None:
    return value.astimezone(SHANGHAI_TZ).date().isoformat() if value else None


def baostock_required_fields(request: HistoryIngestionRequest) -> list[str]:
    fields = [
        "amount",
        "turnover",
        "trade_status",
        "is_st",
        "limit_up",
        "limit_down",
    ]
    if request.period == "daily" and request.include_valuation_factors:
        fields.extend(["pe_ttm", "pb_mrq", "ps_ttm", "pcf_ncf_ttm"])
    return fields


def required_fields_for_target(
    request: HistoryIngestionRequest,
    target: dict[str, str],
) -> list[str]:
    fields = baostock_required_fields(request)
    if (target.get("asset_type") or "stock") != "stock":
        return [
            field
            for field in fields
            if field not in {"pe_ttm", "pb_mrq", "ps_ttm", "pcf_ncf_ttm"}
        ]
    return fields


def missing_preflight_fields(
    coverage,
    *,
    require_fields: list[str],
) -> list[str]:
    missing: list[str] = []
    if coverage is None or coverage.rows_since_cutoff <= 0:
        return ["kline"]
    expected_rows = max(1, getattr(coverage, "expected_rows_since_cutoff", 0) or 0)
    observed_rows = coverage.rows_since_cutoff
    if (
        coverage.benchmark_last_ts is not None
        and (coverage.last_ts is None or coverage.last_ts < coverage.benchmark_last_ts)
    ):
        missing.append("latest_trade_date")
    if coverage.rows_since_cutoff < expected_rows:
        missing.append("kline")
    field_count_by_key = {
        "amount": getattr(coverage, "amount_count", 0),
        "turnover": getattr(coverage, "turnover_count", 0),
        "trade_status": getattr(coverage, "trade_status_count", 0),
        "is_st": getattr(coverage, "is_st_count", 0),
        "limit_up": getattr(coverage, "limit_up_count", 0),
        "limit_down": getattr(coverage, "limit_down_count", 0),
    }
    for key, count in field_count_by_key.items():
        if key in require_fields and count < observed_rows:
            missing.append(key)
    factor_count_by_key = {
        "pe_ttm": getattr(coverage, "pe_ttm_count", 0),
        "pb_mrq": getattr(coverage, "pb_mrq_count", 0),
        "ps_ttm": getattr(coverage, "ps_ttm_count", 0),
        "pcf_ncf_ttm": getattr(coverage, "pcf_ncf_ttm_count", 0),
    }
    for key, count in factor_count_by_key.items():
        if key in require_fields and count < observed_rows:
            missing.append(key)
    return list(dict.fromkeys(missing))


def skipped_existing_result(
    *,
    target: dict[str, str],
    coverage,
    missing_fields: list[str],
) -> HistoryIngestionSymbolResult:
    return HistoryIngestionSymbolResult(
        symbol=target["symbol"],
        source="local",
        status="skipped",
        skip_reason="local_coverage_ready",
        coverage_row_count=coverage.row_count if coverage else 0,
        coverage_first_date=coverage.first_ts.astimezone(SHANGHAI_TZ).date()
        if coverage and coverage.first_ts
        else None,
        coverage_last_date=coverage.last_ts.astimezone(SHANGHAI_TZ).date()
        if coverage and coverage.last_ts
        else None,
        first_date=local_date_text(coverage.first_ts if coverage else None),
        last_date=local_date_text(coverage.last_ts if coverage else None),
        missing_fields=missing_fields,
    )


def local_coverage_ready(
    coverage,
    *,
    require_fields: list[str],
) -> tuple[bool, list[str]]:
    missing_fields = missing_preflight_fields(
        coverage,
        require_fields=require_fields,
    )
    return bool(coverage and coverage.rows_since_cutoff > 0 and not missing_fields), missing_fields


def ingestion_result_counts(
    results: list[HistoryIngestionSymbolResult],
) -> tuple[int, int, int, int]:
    completed = len([item for item in results if item.status in {"success", "skipped"}])
    failed = len([item for item in results if item.status == "failed"])
    rows_received = sum(item.bars_received for item in results)
    rows_upserted = sum(item.rows_upserted for item in results)
    return completed, failed, rows_received, rows_upserted


async def wait_for_autofill_control(
    *,
    parent_job_id: str,
    child_job_id: str | None,
    current_symbol: str | None,
    effective_offset: int,
    next_offset: int,
    completed_batches: int,
    total_batches: int,
    completed_symbols: int,
    failed_symbols: int,
    rows_received: int,
    rows_upserted: int,
    all_target_count: int,
) -> str | None:
    while True:
        control = await get_ingestion_job_control(parent_job_id)
        if control == "stop":
            return "stop"
        if control != "pause":
            return None
        await update_ingestion_job_progress(
            job_id=parent_job_id,
            status="running",
            completed_symbols=completed_symbols,
            failed_symbols=failed_symbols,
            rows_received=rows_received,
            rows_upserted=rows_upserted,
            metadata={
                "control": "pause",
                "paused_at": datetime.now(UTC).isoformat(),
                "completed_batches": completed_batches,
                "total_batches": total_batches,
                "active_child_job_id": child_job_id,
                "batch_offset": effective_offset,
                "next_offset": next_offset,
                "universe_total_symbols": all_target_count,
                "current_symbol": current_symbol,
                "last_heartbeat_at": datetime.now(UTC).isoformat(),
            },
        )
        await asyncio.sleep(1)


def merge_kline_responses(current: KlineResponse, earlier: KlineResponse) -> KlineResponse:
    bars_by_date = {bar.date: bar for bar in current.bars}
    bars_by_date.update({bar.date: bar for bar in earlier.bars})
    bars = sorted(bars_by_date.values(), key=lambda bar: bar.date)
    return current.model_copy(update={"bars": bars, "source": current.source or earlier.source})


async def fetch_kline_for_ingestion(
    client: EastMoneyClient,
    symbol_or_secid: str,
    request: HistoryIngestionRequest,
) -> KlineResponse:
    async def fetch_segment(end: str) -> KlineResponse:
        last_error: EastMoneyError | None = None
        for attempt in range(1, request.max_retries + 1):
            try:
                return await client.get_kline(
                    symbol_or_secid,
                    period=request.period,
                    adjustment=request.adjustment,
                    limit=request.limit,
                    end=end,
                    allow_fallback=request.allow_fallback,
                )
            except EastMoneyError as error:
                last_error = error
                if attempt >= request.max_retries:
                    break
                await asyncio.sleep(request.request_delay_seconds * attempt)
        assert last_error is not None
        raise last_error

    kline = await fetch_segment(provider_end_for_range(request))
    await asyncio.sleep(request.request_delay_seconds)
    cutoff = ingestion_start_date(request)

    for _ in range(6):
        first_bar = kline.bars[0] if kline.bars else None
        first_date = parse_bar_date(first_bar.date) if first_bar else None
        if first_date is None or first_date <= cutoff:
            break

        earlier_end = (first_date - timedelta(days=1)).strftime("%Y%m%d")
        earlier = await fetch_segment(earlier_end)
        await asyncio.sleep(request.request_delay_seconds)
        if not earlier.bars:
            break

        previous_count = len(kline.bars)
        kline = merge_kline_responses(kline, earlier)
        if len(kline.bars) <= previous_count:
            break

    return kline


async def fetch_akshare_kline_for_ingestion(
    client: AkShareClient,
    symbol_or_secid: str,
    request: HistoryIngestionRequest,
) -> KlineResponse:
    start_date = provider_start_for_ymd(request)
    return await client.get_kline_range(
        symbol_or_secid,
        period=request.period,
        adjustment=request.adjustment,
        start_date=start_date,
        end_date=provider_end_for_range(request),
        limit=request.limit,
    )


async def fetch_baostock_kline_for_ingestion(
    client: BaoStockClient,
    symbol_or_secid: str,
    request: HistoryIngestionRequest,
) -> KlineResponse:
    start_date = provider_start_for_iso(request)
    return await client.get_kline_range(
        symbol_or_secid,
        period=request.period,
        adjustment=request.adjustment,
        start_date=start_date,
        end_date=provider_end_for_range(request),
        limit=request.limit,
    )
