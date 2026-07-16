from __future__ import annotations

from typing import cast

from fastapi import APIRouter, HTTPException

from quantpilot_market_data.cache import MarketDataCache, RedisJsonCache
from quantpilot_market_data.models import (
    Adjustment,
    AnalysisContextResponse,
    AnalysisContextSectionName,
    KlinePeriod,
)
from quantpilot_market_data.providers.base import AnalysisContextProvider
from quantpilot_market_data.services.context import get_analysis_context

DEFAULT_SECTIONS: tuple[AnalysisContextSectionName, ...] = (
    "quote",
    "history",
    "technical",
    "financials",
    "fundamental",
    "announcements",
)


def _parse_sections(include: str | None) -> list[AnalysisContextSectionName]:
    if include is None or not include.strip():
        return list(DEFAULT_SECTIONS)
    requested = list(dict.fromkeys(part.strip() for part in include.split(",") if part.strip()))
    allowed = set(DEFAULT_SECTIONS)
    invalid = [part for part in requested if part not in allowed]
    if invalid:
        raise ValueError(f"未知 include 数据区块：{', '.join(invalid)}")
    if not requested:
        raise ValueError("include 至少需要一个数据区块")
    return cast(list[AnalysisContextSectionName], requested)


def create_context_router(
    *,
    client: AnalysisContextProvider,
    cache: MarketDataCache,
    intraday_redis_cache: RedisJsonCache,
    quote_cache_ttl_seconds: int,
    kline_cache_ttl_seconds: int,
    financial_cache_ttl_seconds: int,
    announcement_cache_ttl_seconds: int,
) -> APIRouter:
    router = APIRouter(prefix="/api/v1/analysis", tags=["analysis-context"])

    @router.get("/context/{symbol}", response_model=AnalysisContextResponse)
    async def get_analysis_context_endpoint(
        symbol: str,
        include: str | None = None,
        period: KlinePeriod = "daily",
        adjustment: Adjustment = "qfq",
        limit: int = 120,
        end: str = "20500101",
        financial_limit: int = 8,
        announcement_limit: int = 20,
    ) -> AnalysisContextResponse:
        try:
            sections = _parse_sections(include)
        except ValueError as error:
            raise HTTPException(status_code=400, detail=str(error)) from error
        return await get_analysis_context(
            client,
            cache,
            intraday_redis_cache,
            symbol=symbol,
            sections=sections,
            period=period,
            adjustment=adjustment,
            limit=limit,
            end=end,
            financial_limit=financial_limit,
            announcement_limit=announcement_limit,
            quote_ttl_seconds=quote_cache_ttl_seconds,
            kline_ttl_seconds=kline_cache_ttl_seconds,
            financial_ttl_seconds=financial_cache_ttl_seconds,
            announcement_ttl_seconds=announcement_cache_ttl_seconds,
        )

    return router
