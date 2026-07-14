from __future__ import annotations

from datetime import date

from fastapi import APIRouter, Depends, HTTPException, Query

from quantpilot_market_data.database_core import DatabaseError
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
)
from quantpilot_market_data.providers.base import ResearchUniverseProvider
from quantpilot_market_data.providers.eastmoney import EastMoneyError
from quantpilot_market_data.security import require_market_admin
from quantpilot_market_data.services.research import (
    add_research_universe_member,
    clean_research_universe_members,
    get_a_share_short_term_candidates,
    get_research_data_coverage,
    get_research_local_bars,
    get_research_sector_capital_flow,
    get_research_universe_members,
    get_research_universe_summary,
    get_research_universes,
    import_a_share_universe_batch,
    import_etf_universe_batch,
)


def create_research_router(client: ResearchUniverseProvider) -> APIRouter:
    router = APIRouter(prefix="/api/v1/research", tags=["research"])

    @router.get("/universes", response_model=ResearchUniverseResponse)
    async def get_research_universes_endpoint() -> ResearchUniverseResponse:
        try:
            return await get_research_universes()
        except DatabaseError as error:
            raise HTTPException(status_code=503, detail=str(error)) from error

    @router.get("/universes/summary", response_model=ResearchUniverseSummaryResponse)
    async def get_research_universe_summary_endpoint() -> ResearchUniverseSummaryResponse:
        try:
            return await get_research_universe_summary()
        except DatabaseError as error:
            raise HTTPException(status_code=503, detail=str(error)) from error

    @router.post(
        "/a-share/import-batch",
        response_model=AShareUniverseBatchImportResponse,
        dependencies=[Depends(require_market_admin)],
    )
    async def import_a_share_universe_batch_endpoint(
        request: AShareUniverseBatchImportRequest,
    ) -> AShareUniverseBatchImportResponse:
        try:
            return await import_a_share_universe_batch(client, request)
        except DatabaseError as error:
            raise HTTPException(status_code=503, detail=str(error)) from error
        except EastMoneyError as error:
            raise HTTPException(status_code=502, detail=str(error)) from error

    @router.post(
        "/etf/import-batch",
        response_model=ETFUniverseBatchImportResponse,
        dependencies=[Depends(require_market_admin)],
    )
    async def import_etf_universe_batch_endpoint(
        request: ETFUniverseBatchImportRequest,
    ) -> ETFUniverseBatchImportResponse:
        try:
            return await import_etf_universe_batch(client, request)
        except DatabaseError as error:
            raise HTTPException(status_code=503, detail=str(error)) from error
        except EastMoneyError as error:
            raise HTTPException(status_code=502, detail=str(error)) from error

    @router.get("/data-coverage", response_model=MarketDataCoverageResponse)
    async def get_research_data_coverage_endpoint(
        universe_id: str | None = "a-share-sample-research-pool",
        page: int = Query(default=1, ge=1),
        page_size: int = Query(default=100, ge=1, le=500),
        include_inactive: bool = Query(default=False),
    ) -> MarketDataCoverageResponse:
        try:
            return await get_research_data_coverage(
                universe_id,
                page=page,
                page_size=page_size,
                include_inactive=include_inactive,
            )
        except DatabaseError as error:
            raise HTTPException(status_code=503, detail=str(error)) from error

    @router.get("/sector-capital-flow", response_model=SectorCapitalFlowResponse)
    async def get_research_sector_capital_flow_endpoint(
        universe_id: str = "a-share-sample-research-pool",
        limit: int = Query(default=40, ge=1, le=120),
        sector: str | None = None,
        detail_days: int = Query(default=20, ge=5, le=60),
    ) -> SectorCapitalFlowResponse:
        try:
            return await get_research_sector_capital_flow(
                universe_id=universe_id,
                limit=limit,
                sector=sector,
                detail_days=detail_days,
            )
        except DatabaseError as error:
            raise HTTPException(status_code=503, detail=str(error)) from error

    @router.get(
        "/universes/{universe_id}/members",
        response_model=ResearchUniverseMembersPageResponse,
    )
    async def get_research_universe_members_endpoint(
        universe_id: str,
        page: int = Query(default=1, ge=1),
        page_size: int = Query(default=10, ge=1, le=100),
        keyword: str | None = Query(default=None, max_length=80),
        include_inactive: bool = Query(default=False),
    ) -> ResearchUniverseMembersPageResponse:
        try:
            return await get_research_universe_members(
                universe_id=universe_id,
                page=page,
                page_size=page_size,
                keyword=keyword,
                include_inactive=include_inactive,
            )
        except DatabaseError as error:
            raise HTTPException(status_code=503, detail=str(error)) from error

    @router.post(
        "/universes/{universe_id}/hygiene",
        response_model=ResearchUniverseHygieneResponse,
        dependencies=[Depends(require_market_admin)],
    )
    async def clean_research_universe_members_endpoint(
        universe_id: str,
        target_trade_date: date | None = None,
        dry_run: bool = Query(default=True),
        max_items: int = Query(default=500, ge=1, le=2_000),
    ) -> ResearchUniverseHygieneResponse:
        try:
            return await clean_research_universe_members(
                universe_id=universe_id,
                target_trade_date=target_trade_date,
                dry_run=dry_run,
                max_items=max_items,
            )
        except DatabaseError as error:
            raise HTTPException(status_code=503, detail=str(error)) from error

    @router.get("/bars/{symbol}", response_model=LocalKlineResponse)
    async def get_research_local_bars_endpoint(
        symbol: str,
        timeframe: KlinePeriod = "daily",
        adjustment: Adjustment = "qfq",
        provider: str | None = None,
        limit: int = 240,
        include_metadata: bool = False,
    ) -> LocalKlineResponse:
        try:
            return await get_research_local_bars(
                symbol=symbol,
                timeframe=timeframe,
                adjustment=adjustment,
                provider=provider,
                limit=limit,
                include_metadata=include_metadata,
            )
        except DatabaseError as error:
            raise HTTPException(status_code=503, detail=str(error)) from error

    @router.get(
        "/screeners/a-share/short-term-candidates",
        response_model=AShareScreenerResponse,
    )
    async def get_a_share_short_term_candidates_endpoint(
        universe_id: str = Query(default="a-share-sample-research-pool", min_length=1),
        trade_date: date | None = None,
        mode: ScreenerMode = "short_term",
        limit: int = Query(default=20, ge=1, le=100),
    ) -> AShareScreenerResponse:
        try:
            return await get_a_share_short_term_candidates(
                universe_id=universe_id,
                trade_date=trade_date,
                mode=mode,
                limit=limit,
            )
        except DatabaseError as error:
            raise HTTPException(status_code=503, detail=str(error)) from error

    @router.post(
        "/universes/{universe_id}/members",
        response_model=ResearchUniverseMemberCreateResponse,
        dependencies=[Depends(require_market_admin)],
    )
    async def add_research_universe_member_endpoint(
        universe_id: str,
        request: ResearchUniverseMemberCreateRequest,
    ) -> ResearchUniverseMemberCreateResponse:
        try:
            return await add_research_universe_member(
                client,
                universe_id=universe_id,
                request=request,
            )
        except ValueError as error:
            raise HTTPException(status_code=400, detail=str(error)) from error
        except DatabaseError as error:
            raise HTTPException(status_code=503, detail=str(error)) from error
        except EastMoneyError as error:
            raise HTTPException(status_code=502, detail=str(error)) from error

    return router
