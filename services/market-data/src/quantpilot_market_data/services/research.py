from __future__ import annotations

from datetime import date

from quantpilot_market_data.models import (
    Adjustment,
    AShareScreenerResponse,
    AShareUniverseBatchImportRequest,
    AShareUniverseBatchImportResponse,
    ETFUniverseBatchImportRequest,
    ETFUniverseBatchImportResponse,
    KlinePeriod,
    LocalKlineResponse,
    MarketDataCoverageResponse,
    ResearchUniverseHygieneResponse,
    ResearchUniverseMemberCreateRequest,
    ResearchUniverseMemberCreateResponse,
    ResearchUniverseMembersPageResponse,
    ResearchUniverseResponse,
    ResearchUniverseSummaryResponse,
    ScreenerMode,
    SectorCapitalFlowResponse,
    SymbolResolveResult,
)
from quantpilot_market_data.providers.base import ResearchUniverseProvider
from quantpilot_market_data.repositories.research import (
    add_securities_to_universe,
    add_security_to_universe,
    clean_research_universe_tradable_members,
    get_local_kline,
    get_market_data_coverage_page,
    list_research_universe_members_page,
    list_research_universe_summaries,
    list_research_universes,
    list_sector_capital_flow,
    screen_a_share_short_term_candidates,
)


async def get_research_universes() -> ResearchUniverseResponse:
    return ResearchUniverseResponse(universes=await list_research_universes())


async def get_research_universe_summary() -> ResearchUniverseSummaryResponse:
    return ResearchUniverseSummaryResponse(universes=await list_research_universe_summaries())


async def import_a_share_universe_batch(
    client: ResearchUniverseProvider,
    request: AShareUniverseBatchImportRequest,
) -> AShareUniverseBatchImportResponse:
    total_available, securities = await client.list_a_share_symbols(
        page=request.page,
        page_size=request.page_size,
    )
    stock_securities = [security for security in securities if security.asset_type == "stock"]
    members = await add_securities_to_universe(
        universe_id=request.universe_id,
        securities=stock_securities,
        role=request.role,
    )
    total_pages = (total_available + request.page_size - 1) // request.page_size
    next_page = request.page + 1 if request.page < total_pages else None
    return AShareUniverseBatchImportResponse(
        universe_id=request.universe_id,
        page=request.page,
        page_size=request.page_size,
        total_available=total_available,
        total_pages=total_pages,
        next_page=next_page,
        imported_count=len(members),
        members=members,
    )


async def import_etf_universe_batch(
    client: ResearchUniverseProvider,
    request: ETFUniverseBatchImportRequest,
) -> ETFUniverseBatchImportResponse:
    total_available, securities = await client.list_etf_symbols(
        page=request.page,
        page_size=request.page_size,
    )
    members = await add_securities_to_universe(
        universe_id=request.universe_id,
        securities=securities,
        role=request.role,
        added_source="etf-batch-import",
    )
    total_pages = (total_available + request.page_size - 1) // request.page_size
    next_page = request.page + 1 if request.page < total_pages else None
    return ETFUniverseBatchImportResponse(
        universe_id=request.universe_id,
        page=request.page,
        page_size=request.page_size,
        total_available=total_available,
        total_pages=total_pages,
        next_page=next_page,
        imported_count=len(members),
        members=members,
    )


async def get_research_data_coverage(
    universe_id: str | None,
    *,
    page: int,
    page_size: int,
    include_inactive: bool = False,
) -> MarketDataCoverageResponse:
    coverage_page = await get_market_data_coverage_page(
        universe_id=universe_id,
        page=page,
        page_size=page_size,
        include_inactive=include_inactive,
    )
    return MarketDataCoverageResponse(
        universe_id=universe_id,
        page=page,
        page_size=page_size,
        include_inactive=include_inactive,
        total=coverage_page.total,
        total_pages=coverage_page.total_pages,
        summary=coverage_page.summary,
        items=coverage_page.items,
    )


async def get_research_sector_capital_flow(
    *,
    universe_id: str,
    limit: int,
    sector: str | None,
    detail_days: int,
) -> SectorCapitalFlowResponse:
    flow = await list_sector_capital_flow(
        universe_id=universe_id,
        limit=limit,
        sector=sector,
        detail_days=detail_days,
    )
    return SectorCapitalFlowResponse(
        universe_id=universe_id,
        items=flow["items"],
        market_summary=flow.get("market_summary"),
        detail=flow.get("detail"),
        cache_status=flow.get("cache_status", "bypass"),
        cache_ttl_seconds=flow.get("cache_ttl_seconds"),
    )


async def get_research_universe_members(
    *,
    universe_id: str,
    page: int,
    page_size: int,
    keyword: str | None,
    include_inactive: bool = False,
) -> ResearchUniverseMembersPageResponse:
    members, total, current_page, total_pages = await list_research_universe_members_page(
        universe_id=universe_id,
        page=page,
        page_size=page_size,
        keyword=keyword,
        include_inactive=include_inactive,
    )
    return ResearchUniverseMembersPageResponse(
        universe_id=universe_id,
        page=current_page,
        page_size=page_size,
        total=total,
        total_pages=total_pages,
        keyword=keyword.strip() if keyword else None,
        include_inactive=include_inactive,
        members=members,
    )


async def clean_research_universe_members(
    *,
    universe_id: str,
    target_trade_date: date | None,
    dry_run: bool,
    max_items: int,
) -> ResearchUniverseHygieneResponse:
    return await clean_research_universe_tradable_members(
        universe_id=universe_id,
        target_trade_date=target_trade_date,
        dry_run=dry_run,
        max_items=max_items,
    )


async def get_research_local_bars(
    *,
    symbol: str,
    timeframe: KlinePeriod,
    adjustment: Adjustment,
    provider: str | None,
    limit: int,
    include_metadata: bool,
) -> LocalKlineResponse:
    return await get_local_kline(
        symbol=symbol.strip().upper(),
        timeframe=timeframe,
        adjustment=adjustment,
        provider=provider.strip() if provider and provider.strip() else None,
        limit=limit,
        include_metadata=include_metadata,
    )


async def get_a_share_short_term_candidates(
    *,
    universe_id: str,
    trade_date,
    mode: ScreenerMode,
    limit: int,
) -> AShareScreenerResponse:
    return await screen_a_share_short_term_candidates(
        universe_id=universe_id.strip(),
        trade_date=trade_date,
        mode=mode,
        limit=limit,
    )


async def add_research_universe_member(
    client: ResearchUniverseProvider,
    *,
    universe_id: str,
    request: ResearchUniverseMemberCreateRequest,
) -> ResearchUniverseMemberCreateResponse:
    security, candidates = await resolve_research_security(client, request.query.strip())
    member = await add_security_to_universe(
        universe_id=universe_id,
        security=security,
        role=request.role,
        weight=request.weight,
    )
    return ResearchUniverseMemberCreateResponse(
        universe_id=universe_id,
        member=member,
        candidates=candidates,
    )


async def resolve_research_security(
    client: ResearchUniverseProvider,
    query: str,
) -> tuple[SymbolResolveResult, list[SymbolResolveResult]]:
    candidates = await client.resolve_symbol(query, count=8)
    preferred = next(
        (
            item
            for item in candidates
            if item.asset_type == "stock"
            and item.market in {"SH", "SZ", "BJ"}
            and item.symbol.isdigit()
            and len(item.symbol) == 6
        ),
        None,
    )
    if preferred is None:
        preferred = next((item for item in candidates if item.asset_type == "stock"), None)
    if preferred is None and candidates:
        preferred = candidates[0]
    if preferred is not None:
        return preferred, candidates

    quote = await client.get_realtime_quote(query)
    resolved = SymbolResolveResult(
        query=query,
        symbol=quote.symbol,
        name=quote.name,
        asset_type=quote.asset_type,
        market=quote.market,
        secid=quote.secid,
        source=quote.source,
        raw={},
    )
    return resolved, [resolved]
