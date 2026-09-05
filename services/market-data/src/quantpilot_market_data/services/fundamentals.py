from __future__ import annotations

from datetime import UTC, datetime

from quantpilot_market_data.cache import MarketDataCache
from quantpilot_market_data.contracts.fundamentals import (
    FinancialReportCaptureResponse,
    FinancialReportsResponse,
    FundamentalIndicatorsResponse,
)
from quantpilot_market_data.fundamentals import build_fundamental_indicators
from quantpilot_market_data.providers.base import FinancialReportProvider
from quantpilot_market_data.providers.eastmoney import normalize_secid
from quantpilot_market_data.repositories.financial_history import (
    capture_financial_versions,
    read_financial_snapshot,
)
from quantpilot_market_data.services.caching import cache_response, read_cached_response

FINANCIAL_REPORTS_CACHE_NAMESPACE = "fundamental-financials-v3"
FUNDAMENTAL_INDICATORS_CACHE_NAMESPACE = "fundamental-indicators-v3"


async def get_financial_reports(
    client: FinancialReportProvider,
    cache: MarketDataCache,
    *,
    symbol: str,
    limit: int,
    ttl_seconds: int,
    as_of: datetime | None = None,
) -> FinancialReportsResponse:
    normalized_limit = max(1, min(limit, 40))
    if as_of is not None:
        # Historical reads never consult a latest-value cache or live provider.
        return await read_financial_snapshot(
            symbol=normalize_secid(symbol).split(".", 1)[1],
            provider=client.id,
            cutoff=as_of,
            limit=normalized_limit,
        )
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
    as_of: datetime | None = None,
) -> FundamentalIndicatorsResponse:
    normalized_limit = max(1, min(limit, 40))
    if as_of is not None:
        snapshot = await get_financial_reports(
            client,
            cache,
            symbol=symbol,
            limit=normalized_limit,
            ttl_seconds=ttl_seconds,
            as_of=as_of,
        )
        response = build_fundamental_indicators(symbol, snapshot.reports)
        response.knowledge = snapshot.knowledge
        response.as_of = as_of
        return response
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


async def capture_financial_reports(
    client: FinancialReportProvider, *, symbol: str, limit: int
) -> FinancialReportCaptureResponse:
    normalized_symbol = normalize_secid(symbol).split(".", 1)[1]
    reports = await client.get_financial_reports(normalized_symbol, limit=max(1, min(limit, 40)))
    for report in reports:
        if normalize_secid(report.symbol).split(".", 1)[1] != normalized_symbol:
            raise ValueError("财报来源返回了不同标的，拒绝写入历史版本。")
    return await capture_financial_versions(
        symbol=normalized_symbol,
        provider=client.id,
        reports=[report.model_copy(update={"symbol": normalized_symbol}) for report in reports],
    )
