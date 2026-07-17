from __future__ import annotations

import os
from pathlib import Path

import uvicorn
from dotenv import dotenv_values

MARKET_ENVIRONMENT_KEYS = {
    "CLICKHOUSE_DATABASE",
    "CLICKHOUSE_DB",
    "CLICKHOUSE_HOST",
    "CLICKHOUSE_HTTP_PORT",
    "CLICKHOUSE_PASSWORD",
    "CLICKHOUSE_PORT",
    "CLICKHOUSE_SECURE",
    "CLICKHOUSE_URL",
    "CLICKHOUSE_USER",
    "DATABASE_URL",
    "EASTMONEY_BASE_URLS",
    "EASTMONEY_KLINE_BASE_URLS",
    "QUANTPILOT_ANNOUNCEMENT_CACHE_TTL_SECONDS",
    "QUANTPILOT_CLICKHOUSE_ENABLED",
    "QUANTPILOT_DATABASE_ENABLED",
    "QUANTPILOT_DATABASE_REQUIRED",
    "QUANTPILOT_DEGRADATION_MODE",
    "QUANTPILOT_FINANCIAL_CACHE_TTL_SECONDS",
    "QUANTPILOT_KLINE_CACHE_TTL_SECONDS",
    "QUANTPILOT_MARKET_ADMIN_TOKEN",
    "QUANTPILOT_MARKET_CACHE_DIR",
    "QUANTPILOT_MARKET_CACHE_ENABLED",
    "QUANTPILOT_MARKET_HOST",
    "QUANTPILOT_MARKET_PORT",
    "QUANTPILOT_MARKET_RELOAD",
    "QUANTPILOT_QUOTE_CACHE_TTL_SECONDS",
    "QUANTPILOT_REDIS_CACHE_ENABLED",
    "QUANTPILOT_REDIS_REQUIRED",
    "QUANTPILOT_SCREENER_CACHE_TTL_SECONDS",
    "QUANTPILOT_SYMBOL_CACHE_TTL_SECONDS",
    "REDIS_NAMESPACE",
    "REDIS_URL",
    "TENCENT_KLINE_LIMIT_CAP",
}


def load_market_environment(root: Path | None = None) -> None:
    """Load only the environment values the isolated market service owns."""
    project_root = root or Path(__file__).resolve().parents[4]
    configured: dict[str, str] = {}
    for env_file in (project_root / ".env", project_root / ".env.local"):
        if not env_file.is_file():
            continue
        for key, value in dotenv_values(env_file).items():
            if key in MARKET_ENVIRONMENT_KEYS and value is not None:
                configured[key] = value
    for key, value in configured.items():
        os.environ.setdefault(key, value)


def main() -> None:
    load_market_environment()
    host = os.getenv("QUANTPILOT_MARKET_HOST", "127.0.0.1")
    port = int(os.getenv("QUANTPILOT_MARKET_PORT", "8000"))
    uvicorn.run(
        "quantpilot_market_data.api:app",
        host=host,
        port=port,
        reload=os.getenv("QUANTPILOT_MARKET_RELOAD", "0") == "1",
    )


if __name__ == "__main__":
    main()
