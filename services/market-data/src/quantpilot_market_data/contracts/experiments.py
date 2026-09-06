from __future__ import annotations

import json
from datetime import datetime
from decimal import Decimal
from typing import Annotated, Literal, Self

from pydantic import BaseModel, ConfigDict, Field, JsonValue, model_validator

from quantpilot_market_data.contracts.common import AssetType, DataQuality, MarketCode
from quantpilot_market_data.contracts.quotes import Adjustment, KlinePeriod

Digest = Annotated[str, Field(pattern=r"^sha256:[a-f0-9]{64}$")]
Label = Annotated[str, Field(min_length=1, max_length=256)]
Price = Annotated[Decimal, Field(allow_inf_nan=False)]


class ExperimentContract(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)


class BacktestInputBar(ExperimentContract):
    """Only the fields consumed by the current numerical engine."""

    date: Label
    open: Price | None = None
    high: Price | None = None
    low: Price | None = None
    close: Price | None = None
    volume: int | None = None


class BacktestInputData(ExperimentContract):
    symbol: Label
    name: str | None = Field(default=None, max_length=256)
    secid: Label
    asset_type: AssetType
    market: MarketCode
    source: Label
    currency: Label
    timezone: Label
    period: KlinePeriod
    adjustment: Adjustment
    as_of: datetime | str | None = None
    fetched_at: datetime
    data_quality: DataQuality
    bars: list[BacktestInputBar] = Field(max_length=1500)


class BacktestEngineIdentity(ExperimentContract):
    version: Literal["single-asset-close-v1"] = "single-asset-close-v1"
    code_sha256: Digest
    runtime: dict[str, str]


class BacktestExperiment(ExperimentContract):
    """Portable inputs and integrity checks; not a provider signature or PIT guarantee."""

    schema_version: Literal[1] = 1
    experiment_id: Digest
    engine: BacktestEngineIdentity
    strategy_id: Label
    parameters: dict[str, JsonValue]
    initial_cash: Price = Field(gt=0)
    fee_bps: Price = Field(ge=0, le=10000)
    data: BacktestInputData
    data_sha256: Digest
    result_sha256: Digest
    assumptions: list[str]

    @model_validator(mode="after")
    def bound_parameters(self) -> Self:
        if len(self.parameters) > 64 or any(len(key) > 128 for key in self.parameters):
            raise ValueError("Backtest parameters exceed the experiment contract limit.")
        encoded = json.dumps(self.parameters, ensure_ascii=False, allow_nan=False)
        if len(encoded.encode("utf-8")) > 16_384:
            raise ValueError("Backtest parameters exceed 16 KiB.")
        return self
