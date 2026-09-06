from __future__ import annotations

import hashlib
import json
import platform
from decimal import Decimal, getcontext
from pathlib import Path
from typing import TYPE_CHECKING, Any

import pydantic

from quantpilot_market_data.contracts.experiments import (
    BacktestEngineIdentity,
    BacktestExperiment,
    BacktestInputBar,
    BacktestInputData,
)
from quantpilot_market_data.contracts.quotes import KlineResponse

if TYPE_CHECKING:
    from quantpilot_market_data.contracts.analysis import BacktestResponse


def digest(value: Any) -> str:
    encoded = json.dumps(
        value, sort_keys=True, ensure_ascii=False, separators=(",", ":"), allow_nan=False
    ).encode("utf-8")
    return f"sha256:{hashlib.sha256(encoded).hexdigest()}"


def _source_digest() -> str:
    root = Path(__file__).resolve().parent
    # Bind the installed implementation and its serialization contracts, never a Git label alone.
    files = (
        "backtest.py",
        "backtest_experiments.py",
        "contracts/analysis.py",
        "contracts/common.py",
        "contracts/experiments.py",
        "contracts/quotes.py",
    )
    return digest({name: hashlib.sha256((root / name).read_bytes()).hexdigest() for name in files})


# Capture code identity when this process loads the engine. Deployments must restart it.
_CODE_SHA256 = _source_digest()
ASSUMPTIONS = [
    "Single asset, long or flat; signals and fills use the same bar close.",
    "Returns start on the next bar after entry; fees are charged on position changes.",
    "No slippage, capacity, suspension, price-limit or delisting execution model.",
    "Annualization uses 252 bars per year, including for non-daily input.",
    "The captured market data is an observed snapshot, not a point-in-time availability guarantee.",
]


def current_engine_identity() -> BacktestEngineIdentity:
    context = getcontext()
    decimal_settings = {
        key: str(getattr(context, key))
        for key in ("prec", "rounding", "Emin", "Emax", "capitals", "clamp")
    }
    decimal_settings["traps"] = ",".join(
        sorted(signal.__name__ for signal, enabled in context.traps.items() if enabled)
    )
    return BacktestEngineIdentity(
        code_sha256=_CODE_SHA256,
        runtime={
            "python": platform.python_version(),
            "implementation": platform.python_implementation(),
            "system": platform.system(),
            "machine": platform.machine(),
            "pydantic": pydantic.__version__,
            **{f"decimal_{key}": value for key, value in decimal_settings.items()},
        },
    )


def capture_input_data(kline: KlineResponse) -> BacktestInputData:
    fields = set(BacktestInputData.model_fields) - {"bars"}
    data = kline.model_dump(mode="json", include=fields)
    data["bars"] = [
        bar.model_dump(mode="json", include=set(BacktestInputBar.model_fields))
        for bar in kline.bars
    ]
    return BacktestInputData.model_validate(data)


def result_digest(result: BacktestResponse) -> str:
    # Fetch/cache metadata and collection wall time do not affect the numerical result.
    return digest(
        result.model_dump(mode="json", exclude={"experiment", "fetched_at", "fetch", "metadata"})
    )


def attach_experiment(
    result: BacktestResponse,
    data: BacktestInputData,
    *,
    initial_cash: Decimal,
    fee_bps: Decimal,
) -> BacktestResponse:
    record = {
        "schema_version": 1,
        "engine": current_engine_identity().model_dump(mode="json"),
        "strategy_id": result.strategy_id,
        "parameters": result.model_dump(mode="json")["parameters"],
        "initial_cash": str(initial_cash),
        "fee_bps": str(fee_bps),
        "data": data.model_dump(mode="json"),
        "data_sha256": digest(data.model_dump(mode="json")),
        "result_sha256": result_digest(result),
        "assumptions": list(ASSUMPTIONS),
    }
    experiment = BacktestExperiment.model_validate({"experiment_id": digest(record), **record})
    return result.model_copy(update={"experiment": experiment})


def verify_experiment(result: BacktestResponse) -> BacktestExperiment:
    experiment = result.experiment
    if experiment is None:
        raise ValueError(
            "This historical backtest has no captured experiment; offline replay is unavailable."
        )
    record = experiment.model_dump(mode="json", exclude={"experiment_id"})
    if digest(record) != experiment.experiment_id:
        raise ValueError("Backtest experiment integrity check failed.")
    if digest(experiment.data.model_dump(mode="json")) != experiment.data_sha256:
        raise ValueError("Backtest input snapshot integrity check failed.")
    if result_digest(result) != experiment.result_sha256:
        raise ValueError("Backtest result integrity check failed.")
    if experiment.engine != current_engine_identity():
        raise ValueError(
            "Backtest engine or runtime changed; use the recorded implementation and runtime."
        )
    return experiment
