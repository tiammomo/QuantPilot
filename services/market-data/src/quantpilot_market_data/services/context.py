from __future__ import annotations

import asyncio
from collections.abc import Awaitable
from datetime import UTC, datetime
from time import perf_counter

from pydantic import BaseModel

from quantpilot_market_data.cache import MarketDataCache, RedisJsonCache
from quantpilot_market_data.fundamentals import build_fundamental_indicators
from quantpilot_market_data.indicators import build_technical_indicators
from quantpilot_market_data.models import (
    Adjustment,
    AnalysisContextResponse,
    AnalysisContextSectionError,
    AnalysisContextSectionName,
    AnalysisContextSectionResult,
    DataQuality,
    FinancialReportsResponse,
    KlinePeriod,
    KlineResponse,
)
from quantpilot_market_data.providers.base import AnalysisContextProvider
from quantpilot_market_data.services.events import get_announcements
from quantpilot_market_data.services.fundamentals import get_financial_reports
from quantpilot_market_data.services.quotes import get_history_quote, get_realtime_quote


class _CapturedResult:
    def __init__(self, *, value: BaseModel | None, error: Exception | None, duration_ms: int):
        self.value = value
        self.error = error
        self.duration_ms = duration_ms


async def _capture(awaitable: Awaitable[BaseModel]) -> _CapturedResult:
    started = perf_counter()
    try:
        return _CapturedResult(
            value=await awaitable,
            error=None,
            duration_ms=max(0, round((perf_counter() - started) * 1000)),
        )
    except Exception as error:  # noqa: BLE001 - each section must fail independently
        return _CapturedResult(
            value=None,
            error=error,
            duration_ms=max(0, round((perf_counter() - started) * 1000)),
        )


def _section_error(error: Exception, duration_ms: int) -> AnalysisContextSectionResult:
    invalid_request = isinstance(error, ValueError)
    return AnalysisContextSectionResult(
        status="error",
        duration_ms=duration_ms,
        data_quality=DataQuality(
            status="error",
            missing_fields=["data"],
            warnings=[str(error)],
        ),
        error=AnalysisContextSectionError(
            code="INVALID_REQUEST" if invalid_request else "UPSTREAM_UNAVAILABLE",
            message=str(error),
            retryable=not invalid_request,
        ),
    )


def _dependency_error(
    dependency: str,
    captured: _CapturedResult,
) -> AnalysisContextSectionResult:
    detail = str(captured.error) if captured.error is not None else f"{dependency} 未返回数据"
    return AnalysisContextSectionResult(
        status="error",
        duration_ms=captured.duration_ms,
        data_quality=DataQuality(
            status="error",
            missing_fields=["data"],
            warnings=[f"依赖 {dependency} 不可用：{detail}"],
        ),
        error=AnalysisContextSectionError(
            code="DEPENDENCY_UNAVAILABLE",
            message=f"依赖 {dependency} 不可用：{detail}",
            retryable=not isinstance(captured.error, ValueError),
        ),
    )


def _section_success(value: BaseModel, duration_ms: int) -> AnalysisContextSectionResult:
    quality = getattr(value, "data_quality", DataQuality())
    return AnalysisContextSectionResult(
        status=quality.status,
        duration_ms=duration_ms,
        data=value.model_dump(mode="json"),
        data_quality=quality,
    )


def _aggregate_quality(
    sections: dict[AnalysisContextSectionName, AnalysisContextSectionResult],
) -> tuple[str, DataQuality]:
    failed = [name for name, section in sections.items() if section.status == "error"]
    warned = [name for name, section in sections.items() if section.status == "warning"]
    if failed and len(failed) == len(sections):
        return (
            "unavailable",
            DataQuality(
                status="error",
                missing_fields=failed,
                warnings=["所有请求的数据区块均不可用。"],
            ),
        )
    if failed or warned:
        warnings = []
        if failed:
            warnings.append(f"部分数据区块不可用：{', '.join(failed)}")
        if warned:
            warnings.append(f"部分数据区块存在质量警告：{', '.join(warned)}")
        return (
            "partial",
            DataQuality(status="warning", missing_fields=failed, warnings=warnings),
        )
    return "ready", DataQuality(status="ok")


async def get_analysis_context(
    client: AnalysisContextProvider,
    cache: MarketDataCache,
    intraday_redis_cache: RedisJsonCache,
    *,
    symbol: str,
    sections: list[AnalysisContextSectionName],
    period: KlinePeriod,
    adjustment: Adjustment,
    limit: int,
    end: str,
    financial_limit: int,
    announcement_limit: int,
    quote_ttl_seconds: int,
    kline_ttl_seconds: int,
    financial_ttl_seconds: int,
    announcement_ttl_seconds: int,
) -> AnalysisContextResponse:
    """Fetch shared dependencies once and isolate failures by response section."""

    started = perf_counter()
    requested = list(dict.fromkeys(sections))
    tasks: dict[str, Awaitable[BaseModel]] = {}
    if "quote" in requested:
        tasks["quote"] = get_realtime_quote(
            client,
            cache,
            symbol=symbol,
            ttl_seconds=quote_ttl_seconds,
        )
    if "history" in requested or "technical" in requested:
        tasks["history"] = get_history_quote(
            client,
            cache,
            intraday_redis_cache,
            symbol=symbol,
            period=period,
            adjustment=adjustment,
            limit=limit,
            end=end,
            refresh=False,
            ttl_seconds=kline_ttl_seconds,
        )
    if "financials" in requested or "fundamental" in requested:
        tasks["financials"] = get_financial_reports(
            client,
            cache,
            symbol=symbol,
            limit=financial_limit,
            ttl_seconds=financial_ttl_seconds,
        )
    if "announcements" in requested:
        tasks["announcements"] = get_announcements(
            client,
            cache,
            symbol=symbol,
            limit=announcement_limit,
            ttl_seconds=announcement_ttl_seconds,
        )

    names = list(tasks)
    captured_values = await asyncio.gather(*(_capture(tasks[name]) for name in names))
    captured = dict(zip(names, captured_values, strict=True))
    output: dict[AnalysisContextSectionName, AnalysisContextSectionResult] = {}

    for name in requested:
        if name == "technical":
            dependency = captured["history"]
            if isinstance(dependency.value, KlineResponse):
                derived_started = perf_counter()
                technical = build_technical_indicators(dependency.value)
                technical.fetch = dependency.value.fetch
                technical.fetched_at = dependency.value.fetched_at
                duration_ms = dependency.duration_ms + max(
                    0,
                    round((perf_counter() - derived_started) * 1000),
                )
                output[name] = _section_success(technical, duration_ms)
            else:
                output[name] = _dependency_error("history", dependency)
            continue

        if name == "fundamental":
            dependency = captured["financials"]
            if isinstance(dependency.value, FinancialReportsResponse):
                derived_started = perf_counter()
                fundamental = build_fundamental_indicators(
                    symbol,
                    dependency.value.reports,
                )
                fundamental.asset_type = dependency.value.asset_type
                fundamental.source = dependency.value.source
                fundamental.currency = dependency.value.currency
                fundamental.timezone = dependency.value.timezone
                fundamental.fetched_at = dependency.value.fetched_at
                fundamental.fetch = dependency.value.fetch
                duration_ms = dependency.duration_ms + max(
                    0,
                    round((perf_counter() - derived_started) * 1000),
                )
                output[name] = _section_success(fundamental, duration_ms)
            else:
                output[name] = _dependency_error("financials", dependency)
            continue

        result = captured[name]
        output[name] = (
            _section_success(result.value, result.duration_ms)
            if result.value is not None
            else _section_error(
                result.error or RuntimeError(f"{name} 未返回数据"),
                result.duration_ms,
            )
        )

    status, quality = _aggregate_quality(output)
    return AnalysisContextResponse(
        symbol=symbol,
        status=status,
        requested_sections=requested,
        sections=output,
        duration_ms=max(0, round((perf_counter() - started) * 1000)),
        fetched_at=datetime.now(UTC),
        data_quality=quality,
    )
