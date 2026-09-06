from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from quantpilot_market_data.backtest import build_strategy_backtest
from quantpilot_market_data.backtest_experiments import result_digest, verify_experiment
from quantpilot_market_data.contracts.analysis import BacktestResponse
from quantpilot_market_data.contracts.quotes import KlineResponse

MAX_ARTIFACT_BYTES = 8 * 1024 * 1024


def replay_backtest(payload: object) -> BacktestResponse:
    original = BacktestResponse.model_validate(payload)
    experiment = verify_experiment(original)
    replay = build_strategy_backtest(
        KlineResponse.model_validate(experiment.data.model_dump(mode="json")),
        strategy_id=experiment.strategy_id,
        parameters=experiment.parameters,
        initial_cash=experiment.initial_cash,
        fee_bps=experiment.fee_bps,
    )
    if result_digest(replay) != experiment.result_sha256:
        raise ValueError("Replayed result differs from the captured backtest.")
    if replay.experiment is None or replay.experiment.experiment_id != experiment.experiment_id:
        raise ValueError("Replayed experiment differs from the captured inputs.")
    return replay


def main() -> int:
    parser = argparse.ArgumentParser(description="Verify and replay a captured backtest offline.")
    parser.add_argument("artifact", type=Path, help="A saved backtest API response JSON file")
    args = parser.parse_args()
    try:
        with args.artifact.open("rb") as artifact:
            data = artifact.read(MAX_ARTIFACT_BYTES + 1)
        if len(data) > MAX_ARTIFACT_BYTES:
            raise ValueError("Backtest artifact exceeds 8 MiB.")
        replay = replay_backtest(json.loads(data))
        assert replay.experiment is not None
        print(
            json.dumps(
                {
                    "status": "verified",
                    "experiment_id": replay.experiment.experiment_id,
                    "data_sha256": replay.experiment.data_sha256,
                    "result_sha256": replay.experiment.result_sha256,
                    "sample_count": replay.summary.sample_count,
                }
            )
        )
        return 0
    except (OSError, ValueError, ArithmeticError, RecursionError) as error:
        # Pydantic error text may include artifact content; do not echo it to shared logs.
        message = str(error) if type(error) is ValueError else type(error).__name__
        print(json.dumps({"status": "rejected", "error": message}), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
