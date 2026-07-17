from __future__ import annotations

import asyncio

from quantpilot_market_data.readiness import get_market_readiness


async def passing_probe() -> None:
    return None


async def failing_probe() -> None:
    raise RuntimeError("sensitive dependency detail")


async def false_probe() -> bool:
    return False


def test_required_dependency_failure_blocks_readiness_without_leaking_error() -> None:
    result = asyncio.run(
        get_market_readiness(
            database_probe=failing_probe,
            redis_probe=passing_probe,  # type: ignore[arg-type]
            environment={
                "QUANTPILOT_DEGRADATION_MODE": "strict",
                "QUANTPILOT_DATABASE_REQUIRED": "1",
                "QUANTPILOT_REDIS_REQUIRED": "1",
            },
        )
    )

    assert result["ok"] is False
    assert result["components"]["database"]["status"] == "failed"
    assert "sensitive dependency detail" not in str(result)


def test_optional_failure_and_disabled_component_do_not_block() -> None:
    result = asyncio.run(
        get_market_readiness(
            database_probe=passing_probe,
            redis_probe=false_probe,
            environment={
                "QUANTPILOT_DATABASE_REQUIRED": "1",
                "QUANTPILOT_REDIS_REQUIRED": "0",
            },
        )
    )
    assert result["ok"] is True
    assert result["components"]["redis"]["status"] == "failed"

    disabled = asyncio.run(
        get_market_readiness(
            database_probe=passing_probe,
            redis_probe=false_probe,
            environment={
                "QUANTPILOT_DATABASE_REQUIRED": "1",
                "QUANTPILOT_REDIS_CACHE_ENABLED": "0",
            },
        )
    )
    assert disabled["components"]["redis"]["status"] == "disabled"
