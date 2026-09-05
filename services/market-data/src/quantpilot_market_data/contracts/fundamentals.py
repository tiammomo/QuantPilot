from __future__ import annotations

from datetime import UTC, datetime
from decimal import Decimal
from typing import Any, Self

from pydantic import BaseModel, Field, model_validator

from quantpilot_market_data.contracts.common import (
    AssetType,
    DataQuality,
    FetchMetadata,
    _merge_data_quality,
)


class DividendEvent(BaseModel):
    symbol: str
    name: str | None = None
    report_date: datetime | None = None
    plan_notice_date: datetime | None = None
    equity_record_date: datetime | None = None
    ex_dividend_date: datetime | None = None
    notice_date: datetime | None = None
    assign_progress: str | None = None
    plan_profile: str | None = None
    pretax_bonus_rmb: Decimal | None = None
    bonus_ratio: Decimal | None = None
    transfer_ratio: Decimal | None = None
    dividend_yield: Decimal | None = None


class DividendEventsResponse(BaseModel):
    symbol: str
    events: list[DividendEvent]
    source: str = "eastmoney"
    fetched_at: datetime = Field(default_factory=lambda: datetime.now(UTC))
    data_quality: DataQuality = Field(default_factory=DataQuality)

    @model_validator(mode="after")
    def fill_contract_fields(self) -> Self:
        if not self.events:
            self.data_quality = _merge_data_quality(
                self.data_quality,
                missing_fields=["events"],
                warnings=["未查询到该证券的分红送配事件。"],
                status="warning",
            )
        return self


class FinancialReportItem(BaseModel):
    symbol: str
    name: str | None = None
    secucode: str | None = None
    report_date: datetime | None = None
    data_type: str | None = None
    basic_eps: Decimal | None = None
    revenue: Decimal | None = Field(default=None, description="营业收入")
    parent_net_profit: Decimal | None = Field(default=None, description="归母净利润")
    weighted_roe: Decimal | None = Field(default=None, description="加权 ROE")
    gross_margin: Decimal | None = Field(default=None, description="销售毛利率")
    revenue_yoy: Decimal | None = Field(default=None, description="营业收入同比")
    net_profit_yoy: Decimal | None = Field(default=None, description="净利润同比")
    operating_cash_flow_per_share: Decimal | None = Field(
        default=None,
        description="每股经营活动现金流净额",
    )
    notice_date: datetime | None = None
    source: str = "eastmoney"
    raw: dict[str, Any] = Field(default_factory=dict)


class FinancialReportVintage(BaseModel):
    revision_id: str
    content_sha256: str
    observed_at: datetime
    available_at: datetime | None = None


class FinancialKnowledgeSnapshot(BaseModel):
    point_in_time: bool = False
    cutoff: datetime | None = None
    data_version: str | None = None
    vintages: list[FinancialReportVintage] = Field(default_factory=list)
    limitation: str = "最新源数据不保证历史时点可用；历史研究必须显式指定 as_of。"


class FinancialReportCaptureResponse(BaseModel):
    symbol: str
    provider: str
    received_reports: int
    inserted_versions: int
    unchanged_versions: int
    missing_report_dates: int
    missing_notice_dates: int
    snapshot: FinancialKnowledgeSnapshot


class FinancialReportsResponse(BaseModel):
    symbol: str
    asset_type: AssetType = "stock"
    source: str = "eastmoney"
    currency: str = "CNY"
    timezone: str = "Asia/Shanghai"
    reports: list[FinancialReportItem]
    knowledge: FinancialKnowledgeSnapshot = Field(default_factory=FinancialKnowledgeSnapshot)
    as_of: datetime | str | None = None
    fetched_at: datetime
    fetch: FetchMetadata = Field(default_factory=FetchMetadata)
    data_quality: DataQuality = Field(default_factory=DataQuality)

    @model_validator(mode="after")
    def fill_contract_fields(self) -> Self:
        if self.as_of is None:
            self.as_of = self.reports[0].report_date if self.reports else self.fetched_at

        missing = [] if self.reports else ["reports"]
        warnings = [] if self.reports else ["财务摘要未返回报告期数据。"]
        self.data_quality = _merge_data_quality(
            self.data_quality,
            missing_fields=missing,
            warnings=warnings,
            status="warning" if missing else None,
        )
        return self


class FundamentalIndicatorPoint(BaseModel):
    report_date: datetime | None = None
    data_type: str | None = None
    revenue: Decimal | None = None
    parent_net_profit: Decimal | None = None
    revenue_yoy: Decimal | None = None
    net_profit_yoy: Decimal | None = None
    operating_cash_flow_per_share: Decimal | None = None
    operating_cash_flow_per_share_yoy: Decimal | None = Field(
        default=None,
        description="每股经营活动现金流净额同比，单位：%",
    )
    gross_margin: Decimal | None = None
    weighted_roe: Decimal | None = None
    net_margin: Decimal | None = Field(default=None, description="归母净利率，单位：%")


class FundamentalIndicatorSummary(BaseModel):
    latest_report_date: datetime | None = None
    latest_revenue: Decimal | None = None
    latest_parent_net_profit: Decimal | None = None
    latest_revenue_yoy: Decimal | None = None
    latest_net_profit_yoy: Decimal | None = None
    latest_operating_cash_flow_per_share: Decimal | None = None
    latest_operating_cash_flow_per_share_yoy: Decimal | None = None
    latest_gross_margin: Decimal | None = None
    latest_weighted_roe: Decimal | None = None
    latest_net_margin: Decimal | None = None
    avg_roe: Decimal | None = None
    avg_gross_margin: Decimal | None = None
    avg_net_margin: Decimal | None = None
    report_count: int = 0


class FundamentalIndicatorsResponse(BaseModel):
    symbol: str
    asset_type: AssetType = "stock"
    source: str = "eastmoney"
    currency: str = "CNY"
    timezone: str = "Asia/Shanghai"
    points: list[FundamentalIndicatorPoint]
    summary: FundamentalIndicatorSummary
    knowledge: FinancialKnowledgeSnapshot = Field(default_factory=FinancialKnowledgeSnapshot)
    as_of: datetime | str | None = None
    fetched_at: datetime
    fetch: FetchMetadata = Field(default_factory=FetchMetadata)
    data_quality: DataQuality = Field(default_factory=DataQuality)

    @model_validator(mode="after")
    def fill_contract_fields(self) -> Self:
        if self.as_of is None:
            self.as_of = self.points[0].report_date if self.points else self.fetched_at

        missing = [] if self.points else ["points"]
        warnings = [] if len(self.points) >= 4 else ["财务指标样本少于 4 期，趋势解释需谨慎。"]
        self.data_quality = _merge_data_quality(
            self.data_quality,
            missing_fields=missing,
            warnings=warnings,
            status="warning" if missing or warnings else None,
        )
        return self


class AnnouncementItem(BaseModel):
    art_code: str
    title: str
    symbol: str | None = None
    name: str | None = None
    notice_date: datetime | None = None
    display_time: datetime | None = None
    columns: list[str] = Field(default_factory=list)
    url: str | None = Field(default=None, description="公告详情 URL")
    pdf_url: str | None = Field(default=None, description="公告 PDF URL")
    source: str = "eastmoney"
    raw: dict[str, Any] = Field(default_factory=dict)


class AnnouncementResponse(BaseModel):
    symbol: str
    asset_type: AssetType = "stock"
    source: str = "eastmoney"
    timezone: str = "Asia/Shanghai"
    announcements: list[AnnouncementItem]
    as_of: datetime | str | None = None
    fetched_at: datetime
    fetch: FetchMetadata = Field(default_factory=FetchMetadata)
    data_quality: DataQuality = Field(default_factory=DataQuality)

    @model_validator(mode="after")
    def fill_contract_fields(self) -> Self:
        if self.as_of is None:
            first = self.announcements[0] if self.announcements else None
            self.as_of = first.notice_date or first.display_time if first else self.fetched_at

        missing = [] if self.announcements else ["announcements"]
        warnings = [] if self.announcements else ["公告接口未返回近期公告。"]
        self.data_quality = _merge_data_quality(
            self.data_quality,
            missing_fields=missing,
            warnings=warnings,
            status="warning" if missing else None,
        )
        return self
