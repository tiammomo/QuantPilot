from __future__ import annotations

from datetime import UTC, date, datetime
from typing import Any, Literal, Self

from pydantic import BaseModel, Field, model_validator

from quantpilot_market_data.contracts.common import DataQuality, _merge_data_quality
from quantpilot_market_data.contracts.quotes import Adjustment, KlinePeriod


class HistoryIngestionRequest(BaseModel):
    universe_id: str | None = Field(
        default="a-share-sample-research-pool",
        description="股票池 ID；为空时仅使用 symbols。",
    )
    symbols: list[str] | None = Field(
        default=None,
        min_length=1,
        max_length=100,
        description="股票代码、东方财富 secid 或规范化代码。",
    )
    period: KlinePeriod = Field(default="daily", description="K 线周期")
    adjustment: Adjustment = Field(default="qfq", description="复权方式")
    limit: int = Field(default=1260, ge=1, le=20000, description="每只证券最多拉取条数")
    lookback_years: int = Field(default=5, ge=1, le=30, description="本地保留的最近年份数")
    start: str | None = Field(
        default=None,
        description="自定义补数开始日期，支持 YYYY-MM-DD 或 YYYYMMDD。",
    )
    end: str = Field(default="20500101", description="东方财富 end 参数，默认远期代表取最新")
    allow_fallback: bool = Field(
        default=False,
        description="东方财富不可用时是否允许降级到腾讯 K 线；严格东方财富同步默认关闭。",
    )
    request_delay_seconds: float = Field(
        default=2.0,
        ge=0,
        le=60,
        description="每次东方财富 K 线请求之间的最小等待时间，降低被限流概率。",
    )
    max_retries: int = Field(
        default=3,
        ge=1,
        le=10,
        description="每段 K 线请求失败后的低频重试次数。",
    )
    include_valuation_factors: bool = Field(
        default=False,
        description=(
            "是否把 pe_ttm/pb_mrq/ps_ttm/pcf_ncf_ttm 估值因子纳入补数完整性契约；"
            "默认关闭，避免增量 K 线补数因为估值因子缺口而重复拉取已存在行情。"
        ),
    )


class HistoryBatchIngestionRequest(HistoryIngestionRequest):
    batch_size: int = Field(default=25, ge=1, le=200, description="单批最多处理标的数。")
    offset: int = Field(default=0, ge=0, description="从股票池成员列表的第几个标的开始。")


class HistoryAutoFillIngestionRequest(HistoryBatchIngestionRequest):
    max_batches: int | None = Field(
        default=None,
        ge=1,
        le=2000,
        description="最多自动推进多少个批次；为空时按股票池成员数自动计算。",
    )
    batch_delay_seconds: float = Field(
        default=0.7,
        ge=0,
        le=60,
        description="批次之间的等待时间，避免连续打满数据源。",
    )


class RealtimeSnapshotIngestionRequest(BaseModel):
    universe_id: str | None = Field(
        default="a-share-sample-research-pool",
        description="股票池 ID；为空时仅使用 symbols。",
    )
    symbols: list[str] | None = Field(
        default=None,
        min_length=1,
        max_length=100,
        description="股票代码、东方财富 secid 或规范化代码。",
    )
    trade_date: str | None = Field(
        default=None,
        description="写入的交易日，YYYY-MM-DD；为空时使用行情 quote_time 对应的上海日期。",
    )
    adjustment: Adjustment = Field(
        default="qfq",
        description="仅记录调用方期望口径；实时快照始终按未复权观察值隔离存储。",
    )
    batch_size: int = Field(default=100, ge=1, le=200, description="单批最多处理标的数。")
    offset: int = Field(default=0, ge=0, description="从股票池成员列表的第几个标的开始。")
    request_delay_seconds: float = Field(
        default=0.2,
        ge=0,
        le=60,
        description="批量实时行情请求后的等待时间，降低被限流概率。",
    )


class IngestionPreflightCoverage(BaseModel):
    symbol: str
    first_ts: datetime | None = None
    last_ts: datetime | None = None
    benchmark_last_ts: datetime | None = None
    row_count: int = 0
    rows_since_cutoff: int = 0
    expected_rows_since_cutoff: int = 0
    complete_rows_since_cutoff: int = 0
    amount_count: int = 0
    turnover_count: int = 0
    trade_status_count: int = 0
    is_st_count: int = 0
    limit_up_count: int = 0
    limit_down_count: int = 0
    pe_ttm_count: int = 0
    pb_mrq_count: int = 0
    ps_ttm_count: int = 0
    pcf_ncf_ttm_count: int = 0


class HistoryIngestionSymbolResult(BaseModel):
    symbol: str
    name: str | None = None
    secid: str | None = None
    source: str | None = None
    status: Literal["success", "failed", "skipped"]
    bars_received: int = 0
    rows_upserted: int = 0
    first_date: str | None = None
    last_date: str | None = None
    error: str | None = None
    skip_reason: str | None = None
    coverage_row_count: int | None = None
    coverage_first_date: date | None = None
    coverage_last_date: date | None = None
    missing_fields: list[str] = Field(default_factory=list)


class IngestionJobControlRequest(BaseModel):
    action: Literal["pause", "resume", "stop"]
    reason: str | None = Field(default=None, max_length=400)


class IngestionJobControlResponse(BaseModel):
    job_id: str
    action: Literal["pause", "resume", "stop"]
    status: str
    control: str
    updated_at: datetime = Field(default_factory=lambda: datetime.now(UTC))


class HistoryIngestionResponse(BaseModel):
    job_id: str
    status: Literal["completed", "partial", "failed"]
    provider: str = "eastmoney"
    universe_id: str | None = None
    period: KlinePeriod = "daily"
    adjustment: Adjustment = "qfq"
    lookback_years: int = 5
    total_symbols: int
    completed_symbols: int
    failed_symbols: int
    rows_received: int
    rows_upserted: int
    symbols: list[HistoryIngestionSymbolResult]
    batch_offset: int | None = None
    batch_size: int | None = None
    next_offset: int | None = None
    universe_total_symbols: int | None = None
    started_at: datetime
    completed_at: datetime
    data_quality: DataQuality = Field(default_factory=DataQuality)

    @model_validator(mode="after")
    def fill_contract_fields(self) -> Self:
        if self.failed_symbols:
            self.data_quality = _merge_data_quality(
                self.data_quality,
                warnings=[f"{self.failed_symbols} 个标的入库失败，请查看 symbols[].error。"],
                status="warning" if self.completed_symbols else "error",
            )
        return self


class IngestionJobSummary(BaseModel):
    id: str
    universe_id: str | None = None
    provider: str
    timeframe: str
    adjustment: str
    status: str
    total_symbols: int = 0
    completed_symbols: int = 0
    failed_symbols: int = 0
    rows_received: int = 0
    rows_upserted: int = 0
    error: str | None = None
    metadata: dict[str, Any] = Field(default_factory=dict)
    started_at: datetime | None = None
    completed_at: datetime | None = None
    created_at: datetime
    updated_at: datetime


class IngestionJobsResponse(BaseModel):
    jobs: list[IngestionJobSummary]
    fetched_at: datetime = Field(default_factory=lambda: datetime.now(UTC))


class AutoFillIngestionStartResponse(BaseModel):
    job_id: str
    status: str = "running"
    provider: str = "baostock"
    universe_id: str | None = None
    period: KlinePeriod = "daily"
    adjustment: Adjustment = "qfq"
    batch_size: int
    next_offset: int
    universe_total_symbols: int
    started_at: datetime
    metadata: dict[str, Any] = Field(default_factory=dict)
