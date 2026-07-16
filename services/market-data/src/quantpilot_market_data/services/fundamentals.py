from __future__ import annotations

from datetime import UTC, datetime

from quantpilot_market_data.cache import MarketDataCache
from quantpilot_market_data.fundamentals import build_fundamental_indicators
from quantpilot_market_data.models import (
    FinancialReportsResponse,
    FundamentalIndicatorsResponse,
)
from quantpilot_market_data.providers.base import FinancialReportProvider
from quantpilot_market_data.services.caching import cache_response, read_cached_response

FINANCIAL_REPORTS_CACHE_NAMESPACE = "fundamental-financials-v2"
FUNDAMENTAL_INDICATORS_CACHE_NAMESPACE = "fundamental-indicators-v2"


async def get_financial_reports(
    client: FinancialReportProvider,
    cache: MarketDataCache,
    *,
    symbol: str,
    limit: int,
    ttl_seconds: int,
) -> FinancialReportsResponse:
    normalized_limit = max(1, min(limit, 40))
    cache_key = cache.build_key(
        FINANCIAL_REPORTS_CACHE_NAMESPACE,
        {"symbol": symbol, "limit": normalized_limit},
    )
    cached = read_cached_response(cache, cache_key, FinancialReportsResponse)
    if cached is not None:
        return cached

    reports = await client.get_financial_reports(symbol, limit=normalized_limit)
    response = FinancialReportsResponse(
        symbol=symbol,
        reports=reports,
        fetched_at=datetime.now(UTC),
    )
    return cache_response(cache, cache_key, ttl_seconds, response, FinancialReportsResponse)


async def get_fundamental_indicators(
    client: FinancialReportProvider,
    cache: MarketDataCache,
    *,
    symbol: str,
    limit: int,
    ttl_seconds: int,
) -> FundamentalIndicatorsResponse:
    normalized_limit = max(1, min(limit, 40))
    cache_key = cache.build_key(
        FUNDAMENTAL_INDICATORS_CACHE_NAMESPACE,
        {"symbol": symbol, "limit": normalized_limit},
    )
    cached = read_cached_response(cache, cache_key, FundamentalIndicatorsResponse)
    if cached is not None:
        return cached

    reports = await client.get_financial_reports(symbol, limit=normalized_limit)
    response = build_fundamental_indicators(symbol, reports)
    return cache_response(cache, cache_key, ttl_seconds, response, FundamentalIndicatorsResponse)
