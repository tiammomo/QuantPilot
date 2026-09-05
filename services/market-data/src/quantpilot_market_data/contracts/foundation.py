from __future__ import annotations

from datetime import UTC, date, datetime
from typing import Any, Literal, Self

from pydantic import BaseModel, Field, model_validator

from quantpilot_market_data.contracts.common import DataQuality, _merge_data_quality
from quantpilot_market_data.contracts.quotes import Adjustment, KlinePeriod


class DataProviderInfo(BaseModel):
    id: str = Field(description="数据源或能力编号")
    name: str = Field(description="中文名称")
    category: str = Field(description="能力分类")
    status: Literal["available", "planned", "degraded"] = Field(description="当前状态")
    description: str = Field(description="能力说明")
    endpoints: list[str] = Field(default_factory=list, description="相关 API 端点")
    cache_ttl_seconds: int | None = Field(default=None, description="默认本地缓存 TTL，单位秒")
    limitations: list[str] = Field(default_factory=list, description="数据限制或注意事项")


class DataRegistryResponse(BaseModel):
    providers: list[DataProviderInfo]


class ClickHouseHealthResponse(BaseModel):
    enabled: bool = False
    status: Literal["disabled", "ok", "error"] = "disabled"
    host: str | None = None
    port: int | None = None
    database: str | None = None
    server_version: str | None = None
    tables: dict[str, int] = Field(default_factory=dict)
    table_latest_trade_dates: dict[str, date | None] = Field(default_factory=dict)
    error: str | None = None
    checked_at: datetime = Field(default_factory=lambda: datetime.now(UTC))


class FoundationComponentStatus(BaseModel):
    id: str
    name: str
    status: Literal["ready", "partial", "missing"]
    count: int = 0
    detail: str | None = None


class FoundationStatusResponse(BaseModel):
    components: list[FoundationComponentStatus]
    fetched_at: datetime = Field(default_factory=lambda: datetime.now(UTC))


class TradingCalendarDay(BaseModel):
    market: str
    trade_date: date
    is_open: bool = True
    session: str = "regular"
    source: str = "local"
    metadata: dict[str, Any] = Field(default_factory=dict)


class TradingCalendarResponse(BaseModel):
    market: str
    start: date | None = None
    end: date | None = None
    days: list[TradingCalendarDay]
    open_count: int = 0
    source: str = "timescaledb"
    fetched_at: datetime = Field(default_factory=lambda: datetime.now(UTC))
    data_quality: DataQuality = Field(default_factory=DataQuality)

    @model_validator(mode="after")
    def fill_contract_fields(self) -> Self:
        self.open_count = len([item for item in self.days if item.is_open])
        if not self.days:
            self.data_quality = _merge_data_quality(
                self.data_quality,
                missing_fields=["days"],
                warnings=["本地交易日历为空，系统将回退到行情样本推断交易日。"],
                status="warning",
            )
        return self


class TradingCalendarRefreshRequest(BaseModel):
    start: date | None = Field(
        default=None,
        description="刷新起始日；为空时从结束日向前覆盖 5 年",
    )
    end: date | None = Field(
        default=None,
        description="刷新结束日；为空时使用上海时区今天",
    )

    @model_validator(mode="after")
    def validate_range(self) -> Self:
        if self.start is not None and self.end is not None and self.start > self.end:
            raise ValueError("start 不能晚于 end")
        return self


class TradingCalendarRefreshResponse(BaseModel):
    market: str = "CN-A"
    source: str = "baostock"
    start: date
    end: date
    requested_days: int = 0
    received_days: int = 0
    inserted_days: int = 0
    updated_days: int = 0
    unchanged_days: int = 0
    written_days: int = 0
    open_days: int = 0
    closed_days: int = 0
    first_date: date | None = None
    last_date: date | None = None
    refreshed_at: datetime = Field(default_factory=lambda: datetime.now(UTC))


class FactorDefinition(BaseModel):
    factor_key: str
    name: str
    category: str
    frequency: str = "daily"
    value_type: str = "number"
    unit: str | None = None
    description: str = ""
    formula: str | None = None
    dependencies: list[str] = Field(default_factory=list)
    status: str = "active"
    provider: str = "quantpilot"
    metadata: dict[str, Any] = Field(default_factory=dict)
    updated_at: datetime | None = None


class FactorDefinitionResponse(BaseModel):
    factors: list[FactorDefinition]
    categories: list[str] = Field(default_factory=list)
    fetched_at: datetime = Field(default_factory=lambda: datetime.now(UTC))

    @model_validator(mode="after")
    def fill_contract_fields(self) -> Self:
        self.categories = sorted({item.category for item in self.factors})
        return self


class DataQualityIssue(BaseModel):
    symbol: str | None = None
    name: str | None = None
    severity: Literal["ok", "warning", "error"] = "warning"
    issue_type: str
    message: str
    metrics: dict[str, Any] = Field(default_factory=dict)


class DataQualityScanRequest(BaseModel):
    universe_id: str = Field(default="a-share-sample-research-pool")
    symbols: list[str] | None = Field(default=None, min_length=1, max_length=500)
    timeframe: KlinePeriod = "daily"
    adjustment: Adjustment = "qfq"
    lookback_years: int = Field(default=5, ge=1, le=30)
    required_fields: list[str] = Field(
        default_factory=lambda: [
            "amount",
            "turnover",
            "trade_status",
            "is_st",
            "limit_up",
            "limit_down",
        ],
        description="需要检查完整覆盖的字段。",
    )
    persist: bool = Field(default=True, description="是否写入 quant.data_quality_scans。")


class DataQualityScanResponse(BaseModel):
    id: str
    universe_id: str | None = None
    symbol: str | None = None
    scope: Literal["universe", "symbols", "symbol"] = "universe"
    timeframe: str = "daily"
    adjustment: str = "qfq"
    status: Literal["completed", "failed"] = "completed"
    severity: Literal["ok", "warning", "error"] = "ok"
    checked_symbols: int = 0
    passed_symbols: int = 0
    warning_symbols: int = 0
    failed_symbols: int = 0
    checked_rows: int = 0
    issue_count: int = 0
    issues: list[DataQualityIssue] = Field(default_factory=list)
    metrics: dict[str, Any] = Field(default_factory=dict)
    started_at: datetime
    completed_at: datetime
    fetched_at: datetime = Field(default_factory=lambda: datetime.now(UTC))


class MarketDataCoverageItem(BaseModel):
    symbol: str
    name: str | None = None
    timeframe: KlinePeriod | str = "daily"
    adjustment: Adjustment | str = "qfq"
    provider: str = "eastmoney"
    first_ts: datetime | None = None
    last_ts: datetime | None = None
    row_count: int = 0
    data_status: Literal["ready", "missing", "stale"] = "missing"


class MarketDataCoverageSummary(BaseModel):
    total: int = 0
    ready: int = 0
    missing: int = 0
    stale: int = 0
    ready_ratio: float = 0
    latest_ts: datetime | None = None
    total_rows: int = 0


class MarketDataCoverageResponse(BaseModel):
    universe_id: str | None = None
    page: int = Field(default=1, ge=1)
    page_size: int = Field(default=100, ge=1)
    total: int = 0
    total_pages: int = 1
    include_inactive: bool = False
    summary: MarketDataCoverageSummary = Field(default_factory=MarketDataCoverageSummary)
    items: list[MarketDataCoverageItem]
    fetched_at: datetime = Field(default_factory=lambda: datetime.now(UTC))
    data_quality: DataQuality = Field(default_factory=DataQuality)

    @model_validator(mode="after")
    def fill_contract_fields(self) -> Self:
        if self.total <= 0:
            self.data_quality = _merge_data_quality(
                self.data_quality,
                missing_fields=["items"],
                warnings=["未查询到任何本地行情覆盖数据。"],
                status="warning",
            )
        elif not self.items:
            self.data_quality = _merge_data_quality(
                self.data_quality,
                warnings=["当前页没有覆盖数据，请检查 page 是否超过 total_pages。"],
                status="warning",
            )
        return self
