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
)
from quantpilot_market_data.contracts.experiments import BacktestExperiment
from quantpilot_market_data.contracts.quotes import Adjustment, KlinePeriod

AnalysisContextSectionName = Literal[
    "quote",
    "history",
    "technical",
    "financials",
    "fundamental",
    "announcements",
]


AnalysisContextSectionStatus = Literal["ok", "warning", "error"]


class AnalysisContextSectionError(BaseModel):
    """A stable, machine-readable error attached to one context section."""

    code: str
    message: str
    retryable: bool = False


class AnalysisContextSectionResult(BaseModel):
    """One independently usable section in the aggregate analysis context."""

    status: AnalysisContextSectionStatus
    duration_ms: int = Field(ge=0)
    data: dict[str, Any] | None = None
    data_quality: DataQuality
    error: AnalysisContextSectionError | None = None


class AnalysisContextResponse(BaseModel):
    """Versioned, partial-success contract used by Skills before analysis."""

    schema_version: Literal[1] = 1
    symbol: str
    status: Literal["ready", "partial", "unavailable"]
    requested_sections: list[AnalysisContextSectionName]
    sections: dict[AnalysisContextSectionName, AnalysisContextSectionResult]
    duration_ms: int = Field(ge=0)
    fetched_at: datetime = Field(default_factory=lambda: datetime.now(UTC))
    data_quality: DataQuality = Field(default_factory=DataQuality)


StrategySide = Literal["long", "flat"]


class BacktestEquityPoint(BaseModel):
    date: str = Field(description="交易日期")
    close: Decimal | None = Field(default=None, description="收盘价")
    fast_ma: Decimal | None = Field(default=None, description="快线均线")
    slow_ma: Decimal | None = Field(default=None, description="慢线均线")
    position: int = Field(default=0, description="持仓状态，1 为持有，0 为空仓")
    daily_return_pct: Decimal | None = Field(default=None, description="当日标的收益率，单位：%")
    strategy_return_pct: Decimal | None = Field(default=None, description="当日策略收益率，单位：%")
    equity: Decimal = Field(description="策略净值")
    drawdown_pct: Decimal | None = Field(default=None, description="策略净值回撤，单位：%")


class BacktestTrade(BaseModel):
    entry_date: str
    entry_price: Decimal
    exit_date: str | None = None
    exit_price: Decimal | None = None
    return_pct: Decimal | None = Field(default=None, description="单笔交易收益率，单位：%")
    holding_days: int = 0
    status: Literal["open", "closed"] = "open"


class BacktestSummary(BaseModel):
    start_date: str | None = None
    end_date: str | None = None
    sample_count: int = 0
    initial_cash: Decimal
    final_equity: Decimal
    total_return_pct: Decimal | None = None
    benchmark_return_pct: Decimal | None = None
    excess_return_pct: Decimal | None = None
    max_drawdown_pct: Decimal | None = None
    annualized_return_pct: Decimal | None = None
    volatility_annualized_pct: Decimal | None = None
    sharpe: Decimal | None = None
    trade_count: int = 0
    win_rate_pct: Decimal | None = None
    exposure_pct: Decimal | None = None


class BacktestResponse(BaseModel):
    experiment: BacktestExperiment | None = None
    symbol: str
    name: str | None = None
    secid: str
    asset_type: AssetType = "stock"
    market: MarketCode = "UNKNOWN"
    source: str = "eastmoney"
    currency: str = "CNY"
    timezone: str = "Asia/Shanghai"
    strategy_id: str = "ma_crossover"
    strategy_name: str = "均线突破"
    fast_window: int
    slow_window: int
    fee_bps: Decimal
    parameters: dict[str, Any] = Field(default_factory=dict, description="策略参数快照")
    period: KlinePeriod
    adjustment: Adjustment
    side: StrategySide = "long"
    equity_curve: list[BacktestEquityPoint]
    trades: list[BacktestTrade]
    summary: BacktestSummary
    as_of: datetime | str | None = None
    fetched_at: datetime
    metadata: dict[str, Any] = Field(default_factory=dict, description="回测行情口径与新鲜度元信息")
    fetch: FetchMetadata = Field(default_factory=FetchMetadata)
    data_quality: DataQuality = Field(default_factory=DataQuality)

    @model_validator(mode="after")
    def fill_contract_fields(self) -> Self:
        if self.as_of is None:
            self.as_of = self.equity_curve[-1].date if self.equity_curve else self.fetched_at

        missing = [] if self.equity_curve else ["equity_curve"]
        warnings: list[str] = []
        if len(self.equity_curve) < self.slow_window + 5:
            warnings.append("回测样本偏少，均线策略指标解释需谨慎。")
        if not self.trades:
            warnings.append("样本区间内未产生完整交易。")
        self.data_quality = _merge_data_quality(
            self.data_quality,
            missing_fields=missing,
            warnings=warnings,
            status="warning" if missing or warnings else None,
        )
        return self
