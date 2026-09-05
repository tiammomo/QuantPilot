from __future__ import annotations

from datetime import UTC, date, datetime
from decimal import Decimal
from typing import Literal, Self

from pydantic import BaseModel, Field, model_validator

from quantpilot_market_data.contracts.common import (
    CacheStatus,
    DataQuality,
    MarketCode,
    _merge_data_quality,
)
from quantpilot_market_data.contracts.quotes import Adjustment, KlinePeriod


class SectorCapitalFlowItem(BaseModel):
    sector: str
    member_count: int = 0
    covered_count: int = 0
    rising_count: int = 0
    falling_count: int = 0
    limit_up_count: int = 0
    limit_down_count: int = 0
    rising_ratio: Decimal | None = None
    latest_amount: Decimal | None = None
    avg_amount_20d: Decimal | None = None
    amount_ratio_20d: Decimal | None = None
    avg_turnover_20d: Decimal | None = None
    strength_20d_pct: Decimal | None = None
    strength_5d_pct: Decimal | None = None
    contribution_ratio: Decimal | None = None
    net_amount_ratio: Decimal | None = None
    proxy_net_amount: Decimal | None = None
    signal: Literal["warming", "cooling", "neutral", "insufficient"] = "insufficient"
    top_symbols: list[str] = Field(default_factory=list)
    data_basis: str = "stock_bars_proxy"


class SectorCapitalFlowMarketSummary(BaseModel):
    sector_count: int = 0
    warming_count: int = 0
    cooling_count: int = 0
    neutral_count: int = 0
    insufficient_count: int = 0
    covered_symbol_count: int = 0
    total_latest_amount: Decimal | None = None
    proxy_net_amount: Decimal | None = None
    rising_ratio: Decimal | None = None
    amount_ratio_20d: Decimal | None = None
    avg_turnover_20d: Decimal | None = None
    strongest_sectors: list[str] = Field(default_factory=list)
    weakest_sectors: list[str] = Field(default_factory=list)
    analysis: list[str] = Field(default_factory=list)


class SectorCapitalFlowTrendPoint(BaseModel):
    trade_date: date
    latest_amount: Decimal | None = None
    proxy_net_amount: Decimal | None = None
    rising_ratio: Decimal | None = None
    amount_ratio_20d: Decimal | None = None
    limit_up_count: int = 0


class SectorCapitalFlowMember(BaseModel):
    symbol: str
    name: str | None = None
    latest_amount: Decimal | None = None
    proxy_net_amount: Decimal | None = None
    latest_change_percent: Decimal | None = None
    strength_20d_pct: Decimal | None = None
    turnover: Decimal | None = None
    limit_up: bool | None = None


class SectorCapitalFlowDetail(BaseModel):
    sector: str
    item: SectorCapitalFlowItem
    trend: list[SectorCapitalFlowTrendPoint] = Field(default_factory=list)
    top_members: list[SectorCapitalFlowMember] = Field(default_factory=list)
    analysis: list[str] = Field(default_factory=list)


class SectorCapitalFlowResponse(BaseModel):
    universe_id: str
    items: list[SectorCapitalFlowItem]
    market_summary: SectorCapitalFlowMarketSummary | None = None
    detail: SectorCapitalFlowDetail | None = None
    source: str = "timescaledb"
    proxy_note: str = (
        "当前为成交额、换手、上涨占比和20日强弱聚合出的资金热度代理，"
        "不是 DDE/主力净流入真实字段。"
    )
    cache_status: CacheStatus = "bypass"
    cache_ttl_seconds: int | None = None
    fetched_at: datetime = Field(default_factory=lambda: datetime.now(UTC))
    data_quality: DataQuality = Field(default_factory=DataQuality)

    @model_validator(mode="after")
    def fill_contract_fields(self) -> Self:
        if not self.items:
            self.data_quality = _merge_data_quality(
                self.data_quality,
                missing_fields=["items"],
                warnings=["未查询到可用于板块资金代理的本地行情数据。"],
                status="warning",
            )
        return self


ScreenerMode = Literal["short_term", "limit_up_relay", "trend_liquidity"]


class AShareScreenerCandidate(BaseModel):
    symbol: str
    code: str
    name: str | None = None
    exchange: MarketCode = "UNKNOWN"
    sector_tags: list[str] = Field(default_factory=list)
    trade_date: date
    close: Decimal | None = None
    open: Decimal | None = None
    high: Decimal | None = None
    low: Decimal | None = None
    previous_close: Decimal | None = None
    change_percent: Decimal | None = None
    amount: Decimal | None = None
    turnover: Decimal | None = None
    ma5: Decimal | None = None
    ma10: Decimal | None = None
    ma20: Decimal | None = None
    ma30: Decimal | None = None
    ma60: Decimal | None = None
    strength_20d_pct: Decimal | None = None
    amount_ratio_20d: Decimal | None = None
    limit_up_count_4d: int = 0
    limit_up_count_10d: int = 0
    latest_limit_up_date: date | None = None
    is_limit_up: bool | None = None
    is_limit_down: bool | None = None
    is_st: bool | None = None
    trade_status: str | None = None
    sample_count: int = 0
    score: Decimal | None = None
    signals: list[str] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)
    missing_fields: list[str] = Field(default_factory=list)


class AnalyticsExecutionMetadata(BaseModel):
    engine: Literal["clickhouse", "timescaledb"] = "timescaledb"
    status: Literal["hit", "fallback", "disabled", "error"] = "disabled"
    basis: str = "timescaledb.canonical_stock_bars"
    target_trade_date: date | None = None
    clickhouse_trade_date: date | None = None
    auto_sync_status: Literal["not_needed", "synced", "skipped", "error"] = "not_needed"
    auto_sync_rows_written: int = 0
    message: str | None = None


class AShareScreenerResponse(BaseModel):
    universe_id: str
    mode: ScreenerMode = "short_term"
    trade_date: date | None = None
    timeframe: KlinePeriod | str = "daily"
    adjustment: Adjustment | str = "qfq"
    scanned_symbols: int = Field(default=0, description="目标股票池实际扫描的活跃股票总数")
    total_symbols: int = Field(default=0, description="目标股票池活跃股票总数")
    eligible_symbols: int = Field(default=0, description="满足数据与交易安全门槛的标的数")
    excluded_symbols: int = Field(default=0, description="未满足筛选资格门槛的标的数")
    excluded_reasons: dict[str, int] = Field(
        default_factory=dict,
        description="排除原因计数；同一标的可能命中多个原因",
    )
    safety_complete_symbols: int = Field(
        default=0,
        description="最新日线具备全部交易安全字段的标的数",
    )
    safety_coverage_pct: float = Field(
        default=0,
        ge=0,
        le=100,
        description="交易安全字段完整覆盖率",
    )
    coverage_warning: str | None = Field(
        default=None,
        description="覆盖不足时的可执行告警",
    )
    total_candidates: int = 0
    limit: int = 20
    candidates: list[AShareScreenerCandidate] = Field(default_factory=list)
    data_basis: str = "timescaledb.canonical_stock_bars"
    analytics: AnalyticsExecutionMetadata = Field(default_factory=AnalyticsExecutionMetadata)
    source: str = "quantpilot-market-api"
    notes: list[str] = Field(default_factory=list)
    cache_status: CacheStatus = "bypass"
    cache_ttl_seconds: int | None = None
    fetched_at: datetime = Field(default_factory=lambda: datetime.now(UTC))
    data_quality: DataQuality = Field(default_factory=DataQuality)

    @model_validator(mode="after")
    def fill_contract_fields(self) -> Self:
        self.total_candidates = len(self.candidates)
        self.total_symbols = max(self.total_symbols, self.scanned_symbols)
        self.scanned_symbols = self.total_symbols
        self.excluded_symbols = max(0, self.total_symbols - self.eligible_symbols)
        if self.coverage_warning:
            self.data_quality = _merge_data_quality(
                self.data_quality,
                warnings=[self.coverage_warning],
                status="warning",
            )
        if not self.candidates:
            self.data_quality = _merge_data_quality(
                self.data_quality,
                missing_fields=["candidates"],
                warnings=["本地筛选接口未返回候选股票，可能是条件过严或最新交易日覆盖不足。"],
                status="warning",
            )
        return self


class ClickHouseSyncRequest(BaseModel):
    universe_id: str = Field(default="a-share-sample-research-pool", min_length=1)
    start: date | None = None
    end: date | None = None
    timeframe: KlinePeriod | str = "daily"
    adjustment: Adjustment | str = "qfq"
    limit: int | None = Field(default=None, ge=1, le=2_000_000)


class ClickHouseSyncResponse(BaseModel):
    enabled: bool = True
    status: Literal["ok", "disabled", "error"] = "ok"
    universe_id: str
    timeframe: KlinePeriod | str = "daily"
    adjustment: Adjustment | str = "qfq"
    start: date | None = None
    end: date | None = None
    rows_read: int = 0
    rows_written: int = 0
    table: str = "quant_bars_daily"
    message: str | None = None
    synced_at: datetime = Field(default_factory=lambda: datetime.now(UTC))
