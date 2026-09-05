from __future__ import annotations

from datetime import UTC, datetime
from decimal import Decimal
from typing import Any, Literal, Self

from pydantic import BaseModel, Field, model_validator

from quantpilot_market_data.contracts.common import (
    AssetType,
    DataQuality,
    FetchMetadata,
    MarketCode,
    _merge_data_quality,
    _missing_field_names,
)


class RealtimeQuote(BaseModel):
    """标准化后的实时行情快照。"""

    symbol: str = Field(description="证券代码，例如 600519")
    secid: str = Field(description="东方财富 secid，例如 1.600519")
    name: str | None = Field(default=None, description="证券名称")
    asset_type: AssetType = Field(default="stock", description="资产类型")
    market: MarketCode = Field(default="UNKNOWN", description="交易市场")
    source: str = Field(default="eastmoney", description="数据源")
    currency: str = Field(default="CNY", description="计价货币")
    timezone: str = Field(default="Asia/Shanghai", description="交易时区")

    price: Decimal | None = Field(default=None, description="最新价")
    open: Decimal | None = Field(default=None, description="开盘价")
    high: Decimal | None = Field(default=None, description="最高价")
    low: Decimal | None = Field(default=None, description="最低价")
    previous_close: Decimal | None = Field(default=None, description="昨收价")
    change_percent: Decimal | None = Field(default=None, description="涨跌幅，单位：%")
    change_amount: Decimal | None = Field(default=None, description="涨跌额")
    amplitude: Decimal | None = Field(default=None, description="振幅，单位：%")
    turnover: Decimal | None = Field(default=None, description="换手率，单位：%")

    volume: int | None = Field(default=None, description="成交量，单位按东方财富原始返回")
    amount: Decimal | None = Field(default=None, description="成交额")
    market_cap: Decimal | None = Field(default=None, description="总市值")
    float_market_cap: Decimal | None = Field(default=None, description="流通市值")
    pe_ttm: Decimal | None = Field(default=None, description="TTM 市盈率")
    pb_mrq: Decimal | None = Field(default=None, description="市净率 MRQ")
    industry: str | None = Field(default=None, description="行业板块")
    region: str | None = Field(default=None, description="地域板块")
    concepts: list[str] = Field(default_factory=list, description="概念板块")

    quote_time: datetime | None = Field(default=None, description="行情时间")
    as_of: datetime | str | None = Field(default=None, description="数据对应时间")
    fetched_at: datetime = Field(description="本服务获取时间")
    fetch: FetchMetadata = Field(default_factory=FetchMetadata, description="获取元信息")
    data_quality: DataQuality = Field(default_factory=DataQuality, description="数据质量摘要")

    @model_validator(mode="after")
    def fill_contract_fields(self) -> Self:
        if self.as_of is None:
            self.as_of = self.quote_time or self.fetched_at

        missing = _missing_field_names(
            {
                "symbol": self.symbol,
                "secid": self.secid,
                "price": self.price,
                "quote_time": self.quote_time,
                "fetched_at": self.fetched_at,
            }
        )
        self.data_quality = _merge_data_quality(self.data_quality, missing_fields=missing)
        return self


class BatchQuoteRequest(BaseModel):
    symbols: list[str] = Field(min_length=1, max_length=100, description="股票代码或东方财富 secid")


class BatchQuoteResponse(BaseModel):
    quotes: list[RealtimeQuote]
    asset_type: AssetType = "mixed"
    source: str = "eastmoney"
    currency: str = "CNY"
    timezone: str = "Asia/Shanghai"
    as_of: datetime | str | None = None
    fetched_at: datetime = Field(default_factory=lambda: datetime.now(UTC))
    fetch: FetchMetadata = Field(default_factory=FetchMetadata)
    data_quality: DataQuality = Field(default_factory=DataQuality)

    @model_validator(mode="after")
    def fill_contract_fields(self) -> Self:
        if self.as_of is None and self.quotes:
            self.as_of = self.quotes[0].as_of

        missing = [] if self.quotes else ["quotes"]
        warnings = [] if self.quotes else ["批量行情未返回任何证券数据。"]
        self.data_quality = _merge_data_quality(
            self.data_quality,
            missing_fields=missing,
            warnings=warnings,
            status="warning" if missing else None,
        )
        return self


class SymbolResolveResult(BaseModel):
    query: str = Field(description="原始查询")
    symbol: str = Field(description="证券代码")
    name: str | None = Field(default=None, description="证券名称")
    asset_type: AssetType = Field(default="stock", description="资产类型")
    market: MarketCode = Field(default="UNKNOWN", description="市场")
    secid: str = Field(description="东方财富 secid")
    source: str = Field(default="eastmoney", description="数据源")
    raw: dict[str, Any] = Field(default_factory=dict, description="原始字段")


class SymbolResolveResponse(BaseModel):
    results: list[SymbolResolveResult]
    asset_type: AssetType = "mixed"
    source: str = "eastmoney"
    timezone: str = "Asia/Shanghai"
    as_of: datetime | str | None = None
    fetched_at: datetime = Field(description="获取时间")
    fetch: FetchMetadata = Field(default_factory=FetchMetadata, description="获取元信息")
    data_quality: DataQuality = Field(default_factory=DataQuality)

    @model_validator(mode="after")
    def fill_contract_fields(self) -> Self:
        if self.as_of is None:
            self.as_of = self.fetched_at
        missing = [] if self.results else ["results"]
        warnings = [] if self.results else ["证券解析未返回匹配结果。"]
        self.data_quality = _merge_data_quality(
            self.data_quality,
            missing_fields=missing,
            warnings=warnings,
            status="warning" if missing else None,
        )
        return self


KlinePeriod = Literal[
    "daily",
    "weekly",
    "monthly",
    "minute1",
    "minute5",
    "minute15",
    "minute30",
    "minute60",
]


Adjustment = Literal["none", "qfq", "hfq"]


class KlineBar(BaseModel):
    date: str = Field(description="交易日期或时间")
    open: Decimal | None = None
    close: Decimal | None = None
    high: Decimal | None = None
    low: Decimal | None = None
    previous_close: Decimal | None = Field(default=None, description="前收盘价")
    volume: int | None = Field(default=None, description="成交量")
    amount: Decimal | None = Field(default=None, description="成交额")
    amplitude: Decimal | None = Field(default=None, description="振幅，单位：%")
    change_percent: Decimal | None = Field(default=None, description="涨跌幅，单位：%")
    change_amount: Decimal | None = Field(default=None, description="涨跌额")
    turnover: Decimal | None = Field(default=None, description="换手率，单位：%")
    trade_status: str | None = Field(default=None, description="交易状态，数据源原始枚举")
    is_st: bool | None = Field(default=None, description="是否 ST")
    limit_up: bool | None = Field(default=None, description="是否涨停")
    limit_down: bool | None = Field(default=None, description="是否跌停")
    metadata: dict[str, Any] = Field(default_factory=dict, description="数据源原始字段与补充信息")


class KlineResponse(BaseModel):
    symbol: str
    name: str | None = None
    secid: str
    asset_type: AssetType = "stock"
    market: MarketCode = "UNKNOWN"
    source: str = "eastmoney"
    currency: str = "CNY"
    timezone: str = "Asia/Shanghai"
    period: KlinePeriod
    adjustment: Adjustment
    bars: list[KlineBar]
    as_of: datetime | str | None = None
    fetched_at: datetime
    metadata: dict[str, Any] = Field(default_factory=dict, description="数据源响应元信息")
    fetch: FetchMetadata = Field(default_factory=FetchMetadata)
    data_quality: DataQuality = Field(default_factory=DataQuality)

    @model_validator(mode="after")
    def fill_contract_fields(self) -> Self:
        if self.as_of is None:
            self.as_of = self.bars[-1].date if self.bars else self.fetched_at

        missing = _missing_field_names(
            {
                "symbol": self.symbol,
                "secid": self.secid,
                "bars": self.bars,
                "fetched_at": self.fetched_at,
            }
        )
        warnings = [] if self.bars else ["历史 K 线未返回样本。"]
        self.data_quality = _merge_data_quality(
            self.data_quality,
            missing_fields=missing,
            warnings=warnings,
            status="warning" if missing else None,
        )
        return self


class LocalKlineBar(BaseModel):
    ts: datetime
    open: Decimal
    high: Decimal
    low: Decimal
    close: Decimal
    previous_close: Decimal | None = None
    volume: Decimal
    amount: Decimal | None = None
    amplitude: Decimal | None = None
    change_percent: Decimal | None = None
    change_amount: Decimal | None = None
    turnover: Decimal | None = None
    trade_status: str | None = None
    is_st: bool | None = None
    limit_up: bool | None = None
    limit_down: bool | None = None
    provider: str
    metadata: dict[str, Any] = Field(default_factory=dict)


class LocalKlineSummary(BaseModel):
    row_count: int = 0
    first_ts: datetime | None = None
    last_ts: datetime | None = None
    latest_close: Decimal | None = None
    previous_close: Decimal | None = None
    return_pct: Decimal | None = None
    high: Decimal | None = None
    low: Decimal | None = None
    total_volume: Decimal | None = None
    total_amount: Decimal | None = None


class LocalKlineResponse(BaseModel):
    symbol: str
    code: str | None = None
    name: str | None = None
    exchange: MarketCode = "UNKNOWN"
    asset_type: AssetType = "stock"
    currency: str = "CNY"
    timezone: str = "Asia/Shanghai"
    secid: str | None = None
    provider: str | None = None
    timeframe: KlinePeriod | str = "daily"
    adjustment: Adjustment | str = "qfq"
    bars: list[LocalKlineBar]
    summary: LocalKlineSummary
    fetched_at: datetime = Field(default_factory=lambda: datetime.now(UTC))
    data_quality: DataQuality = Field(default_factory=DataQuality)

    @model_validator(mode="after")
    def fill_contract_fields(self) -> Self:
        if not self.bars:
            self.data_quality = _merge_data_quality(
                self.data_quality,
                missing_fields=["bars"],
                warnings=["本地数据库未查询到该证券的 K 线。"],
                status="warning",
            )
        return self


class TechnicalIndicatorPoint(BaseModel):
    date: str = Field(description="交易日期或时间")
    close: Decimal | None = None
    volume: int | None = None
    ma5: Decimal | None = None
    ma10: Decimal | None = None
    ma20: Decimal | None = None
    ma30: Decimal | None = None
    ma60: Decimal | None = None
    return_pct: Decimal | None = Field(default=None, description="相对上一根 K 线收益率，单位：%")
    drawdown_pct: Decimal | None = Field(
        default=None,
        description="相对历史最高收盘价回撤，单位：%",
    )


class TechnicalIndicatorSummary(BaseModel):
    latest_close: Decimal | None = None
    period_return_pct: Decimal | None = None
    max_drawdown_pct: Decimal | None = None
    volatility_annualized_pct: Decimal | None = None
    avg_volume20: Decimal | None = None
    ma5: Decimal | None = None
    ma10: Decimal | None = None
    ma20: Decimal | None = None
    ma30: Decimal | None = None
    ma60: Decimal | None = None


class TechnicalIndicatorsResponse(BaseModel):
    symbol: str
    name: str | None = None
    secid: str
    asset_type: AssetType = "stock"
    market: MarketCode = "UNKNOWN"
    source: str = "eastmoney"
    currency: str = "CNY"
    timezone: str = "Asia/Shanghai"
    period: KlinePeriod
    adjustment: Adjustment
    points: list[TechnicalIndicatorPoint]
    summary: TechnicalIndicatorSummary
    as_of: datetime | str | None = None
    fetched_at: datetime
    metadata: dict[str, Any] = Field(default_factory=dict, description="行情口径与新鲜度元信息")
    fetch: FetchMetadata = Field(default_factory=FetchMetadata)
    data_quality: DataQuality = Field(default_factory=DataQuality)

    @model_validator(mode="after")
    def fill_contract_fields(self) -> Self:
        if self.as_of is None:
            self.as_of = self.points[-1].date if self.points else self.fetched_at

        missing = [] if self.points else ["points"]
        warnings = (
            []
            if len(self.points) >= 20
            else ["技术指标样本少于 20 条，MA20 或波动率解释需谨慎。"]
        )
        self.data_quality = _merge_data_quality(
            self.data_quality,
            missing_fields=missing,
            warnings=warnings,
            status="warning" if missing or warnings else None,
        )
        return self
