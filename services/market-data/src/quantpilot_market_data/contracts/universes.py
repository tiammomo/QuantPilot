from __future__ import annotations

from datetime import UTC, date, datetime
from decimal import Decimal
from typing import Literal, Self

from pydantic import BaseModel, Field, model_validator

from quantpilot_market_data.contracts.common import (
    AssetType,
    DataQuality,
    MarketCode,
    _merge_data_quality,
)
from quantpilot_market_data.contracts.quotes import Adjustment, KlinePeriod, SymbolResolveResult


class ResearchUniverseMember(BaseModel):
    symbol: str = Field(description="规范化证券代码，例如 002156.SZ")
    code: str = Field(description="交易所原始代码，例如 002156")
    name: str | None = Field(default=None, description="证券名称")
    industry: str | None = Field(default=None, description="所属行业")
    region: str | None = Field(default=None, description="地域板块")
    concepts: list[str] = Field(default_factory=list, description="概念板块")
    sector_hint: str | None = Field(default=None, description="种子数据板块提示")
    sector_tags: list[str] = Field(default_factory=list, description="前端展示用板块标签")
    exchange: MarketCode = Field(default="UNKNOWN", description="交易所")
    asset_type: AssetType = Field(default="stock", description="资产类型")
    currency: str = Field(default="CNY", description="计价货币")
    timezone: str = Field(default="Asia/Shanghai", description="交易时区")
    secid: str | None = Field(default=None, description="东方财富 secid")
    provider: str = Field(default="eastmoney", description="主数据来源")
    security_status: str = Field(default="active", description="证券状态")
    role: str = Field(default="member", description="股票池角色")
    weight: Decimal | None = Field(default=None, description="默认权重")
    row_count: int = Field(default=0, description="已入库 K 线条数")
    first_ts: datetime | None = Field(default=None, description="最早入库时间")
    last_ts: datetime | None = Field(default=None, description="最新入库时间")
    data_provider: str | None = Field(default=None, description="当前覆盖数据来源")
    latest_close: Decimal | None = Field(default=None, description="最新收盘价")
    latest_change_pct: Decimal | None = Field(default=None, description="最近一日涨跌幅，单位：%")
    latest_amount: Decimal | None = Field(default=None, description="最近一日成交额")
    latest_turnover: Decimal | None = Field(default=None, description="最近一日换手率，单位：%")
    strength_20d_pct: Decimal | None = Field(
        default=None,
        description="近 20 个交易日涨跌幅，单位：%",
    )
    strength_60d_pct: Decimal | None = Field(
        default=None,
        description="近 60 个交易日涨跌幅，单位：%",
    )
    ma20: Decimal | None = Field(default=None, description="最近 20 日均线")
    ma60: Decimal | None = Field(default=None, description="最近 60 日均线")
    trend_status: Literal["bullish", "bearish", "sideways", "insufficient"] = Field(
        default="insufficient",
        description="基于收盘价、MA20 和 MA60 推导的趋势状态",
    )
    avg_amount_20d: Decimal | None = Field(default=None, description="近 20 日平均成交额")
    avg_volume_20d: Decimal | None = Field(default=None, description="近 20 日平均成交量")
    avg_turnover_20d: Decimal | None = Field(default=None, description="近 20 日平均换手率")
    trade_status: str | None = Field(default=None, description="最近一日交易状态")
    is_st: bool | None = Field(default=None, description="最近一日是否 ST")
    limit_up: bool | None = Field(default=None, description="最近一日是否涨停")
    limit_down: bool | None = Field(default=None, description="最近一日是否跌停")
    pe_ttm: Decimal | None = Field(default=None, description="TTM 市盈率")
    pb_mrq: Decimal | None = Field(default=None, description="市净率 MRQ")
    ps_ttm: Decimal | None = Field(default=None, description="TTM 市销率")
    pcf_ncf_ttm: Decimal | None = Field(default=None, description="TTM 市现率")
    data_status: Literal["ready", "missing", "stale"] = Field(
        default="missing",
        description="本地数据状态",
    )


class ResearchUniverse(BaseModel):
    id: str
    name: str
    description: str | None = None
    status: str = "active"
    source: str = "manual"
    tags: list[str] = Field(default_factory=list)
    default_timeframe: KlinePeriod = "daily"
    default_adjustment: Adjustment = "qfq"
    provider: str = "eastmoney"
    members: list[ResearchUniverseMember] = Field(default_factory=list)
    member_count: int = Field(default=0, description="股票池成员总数")
    stock_count: int = Field(default=0, description="股票成员数量")
    etf_count: int = Field(default=0, description="ETF 成员数量")
    index_count: int = Field(default=0, description="指数成员数量")
    fund_count: int = Field(default=0, description="基金成员数量")
    ready_count: int = Field(default=0, description="已完成行情覆盖的成员数量")
    bar_count: int = Field(default=0, description="已入库 K 线样本总数")
    latest_ts: datetime | None = Field(default=None, description="股票池内最新行情日期")
    created_at: datetime | None = None
    updated_at: datetime | None = None


class ResearchUniverseSummary(BaseModel):
    id: str
    name: str
    description: str | None = None
    status: str = "active"
    source: str = "manual"
    tags: list[str] = Field(default_factory=list)
    default_timeframe: KlinePeriod = "daily"
    default_adjustment: Adjustment = "qfq"
    provider: str = "eastmoney"
    member_count: int = 0
    stock_count: int = 0
    etf_count: int = 0
    index_count: int = 0
    fund_count: int = 0
    ready_count: int = 0
    bar_count: int = 0
    latest_ts: datetime | None = None
    created_at: datetime | None = None
    updated_at: datetime | None = None


class ResearchUniverseResponse(BaseModel):
    universes: list[ResearchUniverse]
    fetched_at: datetime = Field(default_factory=lambda: datetime.now(UTC))
    data_quality: DataQuality = Field(default_factory=DataQuality)

    @model_validator(mode="after")
    def fill_contract_fields(self) -> Self:
        if not self.universes:
            self.data_quality = _merge_data_quality(
                self.data_quality,
                missing_fields=["universes"],
                warnings=["数据库中尚未配置策略研究股票池。"],
                status="warning",
            )
        return self


class ResearchUniverseSummaryResponse(BaseModel):
    universes: list[ResearchUniverseSummary]
    fetched_at: datetime = Field(default_factory=lambda: datetime.now(UTC))
    data_quality: DataQuality = Field(default_factory=DataQuality)

    @model_validator(mode="after")
    def fill_contract_fields(self) -> Self:
        if not self.universes:
            self.data_quality = _merge_data_quality(
                self.data_quality,
                missing_fields=["universes"],
                warnings=["数据库中尚未配置策略研究股票池。"],
                status="warning",
            )
        return self


class ResearchUniverseMembersPageResponse(BaseModel):
    universe_id: str
    page: int = Field(ge=1)
    page_size: int = Field(ge=1)
    total: int = 0
    total_pages: int = 1
    keyword: str | None = None
    include_inactive: bool = False
    members: list[ResearchUniverseMember] = Field(default_factory=list)
    fetched_at: datetime = Field(default_factory=lambda: datetime.now(UTC))


class ResearchUniverseMemberCreateRequest(BaseModel):
    query: str = Field(min_length=1, max_length=80, description="股票代码、简称或中文名称")
    role: str = Field(default="member", max_length=40, description="股票池角色")
    weight: Decimal | None = Field(default=None, ge=0, le=1, description="默认权重")


class ResearchUniverseMemberCreateResponse(BaseModel):
    universe_id: str
    member: ResearchUniverseMember
    candidates: list[SymbolResolveResult] = Field(default_factory=list)
    created_at: datetime = Field(default_factory=lambda: datetime.now(UTC))


class ResearchUniverseHygieneItem(BaseModel):
    symbol: str
    name: str | None = None
    previous_role: str | None = None
    new_role: str
    previous_status: str | None = None
    new_status: str
    last_ts: datetime | None = None
    last_trade_date: date | None = None
    reason: str
    action: Literal["mark_inactive", "mark_active", "keep"]


class ResearchUniverseHygieneResponse(BaseModel):
    universe_id: str
    dry_run: bool = True
    target_trade_date: date | None = None
    inspected_count: int = 0
    changed_count: int = 0
    active_count: int = 0
    inactive_count: int = 0
    items: list[ResearchUniverseHygieneItem] = Field(default_factory=list)
    updated_at: datetime = Field(default_factory=lambda: datetime.now(UTC))


class AShareUniverseBatchImportRequest(BaseModel):
    universe_id: str = Field(
        default="a-share-sample-research-pool",
        description="目标股票池 ID。",
    )
    page: int = Field(default=1, ge=1, description="东方财富沪深京 A 股列表页码。")
    page_size: int = Field(default=100, ge=1, le=100, description="每批导入证券数量。")
    role: str = Field(default="member", max_length=40, description="股票池成员角色。")


class AShareUniverseBatchImportResponse(BaseModel):
    universe_id: str
    page: int
    page_size: int
    total_available: int
    total_pages: int
    next_page: int | None = None
    imported_count: int
    members: list[ResearchUniverseMember] = Field(default_factory=list)
    source: str = "eastmoney"
    fetched_at: datetime = Field(default_factory=lambda: datetime.now(UTC))


class ETFUniverseBatchImportRequest(AShareUniverseBatchImportRequest):
    universe_id: str = Field(
        default="etf-index-pool",
        description="目标 ETF/指数池 ID。",
    )
    page: int = Field(default=1, ge=1, description="东方财富 ETF 列表页码。")
    page_size: int = Field(default=100, ge=1, le=100, description="每批导入 ETF 数量。")


class ETFUniverseBatchImportResponse(AShareUniverseBatchImportResponse):
    pass
