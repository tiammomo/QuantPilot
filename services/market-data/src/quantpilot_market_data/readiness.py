from __future__ import annotations

import os
from collections.abc import Awaitable, Callable, Mapping
from typing import Literal, TypedDict


class ReadinessComponent(TypedDict):
    enabled: bool
    required: bool
    ok: bool
    status: Literal["ok", "failed", "disabled"]


class ReadinessResult(TypedDict):
    ok: bool
    service: Literal["quantpilot-market-data"]
    components: dict[str, ReadinessComponent]


TRUE_VALUES = {"1", "true", "yes", "on", "enabled"}
FALSE_VALUES = {"0", "false", "no", "off", "disabled"}


def env_flag(environment: Mapping[str, str], name: str, fallback: bool) -> bool:
    value = environment.get(name, "").strip().lower()
    if not value:
        return fallback
    if value in TRUE_VALUES:
        return True
    if value in FALSE_VALUES:
        return False
    return fallback


async def get_market_readiness(
    *,
    database_probe: Callable[[], Awaitable[None]],
    redis_probe: Callable[[], Awaitable[bool]],
    environment: Mapping[str, str] | None = None,
) -> ReadinessResult:
    env = environment or os.environ
    strict = env.get("QUANTPILOT_DEGRADATION_MODE", "auto").strip().lower() == "strict"
    database_enabled = env_flag(env, "QUANTPILOT_DATABASE_ENABLED", True)
    redis_enabled = env_flag(env, "QUANTPILOT_REDIS_CACHE_ENABLED", True)
    definitions = [
        (
            "database",
            database_enabled,
            env_flag(env, "QUANTPILOT_DATABASE_REQUIRED", True),
            database_probe,
        ),
        (
            "redis",
            redis_enabled,
            env_flag(env, "QUANTPILOT_REDIS_REQUIRED", strict),
            redis_probe,
        ),
    ]
    components: dict[str, ReadinessComponent] = {}

    for name, enabled, required, probe in definitions:
        if not enabled:
            components[name] = {
                "enabled": False,
                "required": required,
                "ok": True,
                "status": "disabled",
            }
            continue
        try:
            probe_result = await probe()
            ok = probe_result is not False
        except Exception:
            ok = False
        components[name] = {
            "enabled": True,
            "required": required,
            "ok": ok,
            "status": "ok" if ok else "failed",
        }

    return {
        "ok": all(
            not component["required"] or component["ok"]
            for component in components.values()
        ),
        "service": "quantpilot-market-data",
        "components": components,
    }
