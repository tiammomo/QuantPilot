from __future__ import annotations

import json
import socket
import subprocess
import sys
from datetime import UTC, datetime, timedelta
from decimal import Decimal, localcontext

import pytest

from quantpilot_market_data import backtest_experiments
from quantpilot_market_data.backtest import STRATEGY_NAMES, build_strategy_backtest
from quantpilot_market_data.backtest_experiments import digest, result_digest
from quantpilot_market_data.contracts.analysis import BacktestResponse
from quantpilot_market_data.contracts.common import DataQuality
from quantpilot_market_data.contracts.quotes import KlineBar, KlineResponse
from quantpilot_market_data.replay_backtest import replay_backtest


def observed_data() -> KlineResponse:
    start = datetime(2025, 1, 1, tzinfo=UTC)
    return KlineResponse(
        symbol="fixture",
        name="Synthetic series",
        secid="fixture:1",
        source="fixture",
        currency="USD",
        timezone="America/New_York",
        period="daily",
        adjustment="none",
        fetched_at=datetime(2026, 1, 1, tzinfo=UTC),
        metadata={"transport": "private transport metadata"},
        data_quality=DataQuality(status="warning", warnings=["Synthetic research fixture"]),
        bars=[
            KlineBar(
                date=(start + timedelta(days=index)).date().isoformat(),
                open=Decimal(20 + index % 37),
                high=Decimal(21 + index % 37),
                low=Decimal(19 + index % 37),
                close=Decimal(20 + index % 37) + Decimal("0.123456789"),
                volume=100_000 + 1000 * index,
                metadata={"raw": "private provider payload"},
            )
            for index in range(180)
        ],
    )


def captured() -> BacktestResponse:
    return build_strategy_backtest(
        observed_data(),
        strategy_id="ma_crossover",
        parameters={"fast_window": 3, "slow_window": 7},
        initial_cash="100.123456789",
        fee_bps="5.1234567",
    )


@pytest.mark.parametrize("strategy_id", list(STRATEGY_NAMES))
def test_all_strategies_replay_serialized_artifacts_without_network(strategy_id, monkeypatch):
    original = build_strategy_backtest(
        observed_data(),
        strategy_id=strategy_id,
        initial_cash="100.123456789",
        fee_bps="5.1234567",
    )

    def deny_network(*_args, **_kwargs):
        raise AssertionError("Offline replay attempted network access")

    monkeypatch.setattr(socket.socket, "connect", deny_network)
    replay = replay_backtest(json.loads(original.model_dump_json()))
    assert replay.summary == original.summary
    assert replay.trades == original.trades
    assert replay.equity_curve == original.equity_curve
    assert replay.experiment == original.experiment


def test_snapshot_is_independent_of_live_data_and_preserves_observed_contract():
    data = observed_data()
    original = build_strategy_backtest(data, strategy_id="ma")
    assert original.currency == "USD"
    assert original.timezone == "America/New_York"
    assert "Synthetic research fixture" in original.data_quality.warnings
    assert original.experiment is not None
    assert original.experiment.strategy_id == "ma_crossover"
    assert original.experiment.data.fetched_at == data.fetched_at
    assert "private" not in original.experiment.model_dump_json()
    data.bars[0].close = Decimal("999")
    assert original.experiment.data.bars[0].close != data.bars[0].close
    newer = build_strategy_backtest(data, strategy_id="ma")
    assert newer.experiment.data_sha256 != original.experiment.data_sha256
    assert replay_backtest(json.loads(original.model_dump_json())).experiment == original.experiment


@pytest.mark.parametrize("mutation", ["data", "parameters", "result", "id", "version"])
def test_tampering_is_rejected_before_engine_execution(mutation, monkeypatch):
    payload = captured().model_dump(mode="json")
    if mutation == "data":
        payload["experiment"]["data"]["bars"][0]["close"] = "999"
    elif mutation == "parameters":
        payload["experiment"]["parameters"]["fast_window"] = 2
    elif mutation == "result":
        payload["summary"]["final_equity"] = "999"
    elif mutation == "id":
        payload["experiment"]["experiment_id"] = "sha256:" + "0" * 64
    else:
        payload["experiment"]["schema_version"] = 2

    def must_not_execute(*_args, **_kwargs):
        raise AssertionError("Engine ran before integrity validation")

    monkeypatch.setattr(
        "quantpilot_market_data.replay_backtest.build_strategy_backtest", must_not_execute
    )
    with pytest.raises(ValueError):
        replay_backtest(payload)


def test_resealed_false_results_still_fail_numerical_replay():
    record = captured().model_dump(mode="json")
    record["summary"]["final_equity"] = "999"
    record["experiment"]["result_sha256"] = result_digest(BacktestResponse.model_validate(record))
    record["experiment"]["experiment_id"] = digest(
        {key: value for key, value in record["experiment"].items() if key != "experiment_id"}
    )
    with pytest.raises(ValueError, match="Replayed result differs"):
        replay_backtest(record)


def test_engine_change_and_decimal_context_change_require_original_environment(monkeypatch):
    original = captured().model_dump(mode="json")
    identity = backtest_experiments.current_engine_identity()
    monkeypatch.setattr(backtest_experiments, "_CODE_SHA256", "sha256:" + "0" * 64)
    with pytest.raises(ValueError, match="engine or runtime changed"):
        replay_backtest(original)
    monkeypatch.setattr(backtest_experiments, "_CODE_SHA256", identity.code_sha256)
    with localcontext() as context:
        context.prec += 1
        with pytest.raises(ValueError, match="engine or runtime changed"):
            replay_backtest(original)


def test_legacy_results_remain_readable_but_cannot_be_replayed():
    original = captured().model_dump(mode="json")
    del original["experiment"]
    assert BacktestResponse.model_validate(original).summary.sample_count == 180
    with pytest.raises(ValueError, match="historical backtest"):
        replay_backtest(original)


@pytest.mark.parametrize("fee", ["-1", "10001", "NaN", "Infinity"])
def test_invalid_fees_cannot_create_replayable_receipts(fee):
    with pytest.raises(ValueError, match="fee_bps"):
        build_strategy_backtest(observed_data(), strategy_id="ma", fee_bps=fee)


def test_snapshot_size_is_bounded_before_calculation():
    data = observed_data()
    data.bars = [data.bars[0]] * 1501
    with pytest.raises(ValueError):
        build_strategy_backtest(data, strategy_id="ma")


def test_cli_verifies_saved_artifact_and_returns_failure_for_changed_results(tmp_path):
    artifact = tmp_path / "backtest.json"
    original = captured().model_dump(mode="json")
    artifact.write_text(json.dumps(original))
    command = [sys.executable, "-m", "quantpilot_market_data.replay_backtest", str(artifact)]
    result = subprocess.run(command, capture_output=True, text=True, check=False, timeout=20)
    assert result.returncode == 0, result.stderr
    assert json.loads(result.stdout)["experiment_id"] == original["experiment"]["experiment_id"]
    original["summary"]["final_equity"] = "999"
    artifact.write_text(json.dumps(original))
    result = subprocess.run(command, capture_output=True, text=True, check=False, timeout=20)
    assert result.returncode == 1
    assert json.loads(result.stderr)["status"] == "rejected"
    assert "private" not in result.stderr
