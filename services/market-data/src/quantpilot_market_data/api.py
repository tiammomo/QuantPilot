from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from quantpilot_market_data.cache import MarketDataCache, RedisJsonCache, ttl_from_env
from quantpilot_market_data.database_core import (
    connect,
)
from quantpilot_market_data.providers.akshare import AkShareClient
from quantpilot_market_data.providers.baostock import BaoStockClient
from quantpilot_market_data.providers.eastmoney import EastMoneyClient
from quantpilot_market_data.routers.analytics import router as analytics_router
from quantpilot_market_data.routers.backtests import create_backtest_router
from quantpilot_market_data.routers.context import create_context_router
from quantpilot_market_data.routers.events import create_events_router
from quantpilot_market_data.routers.foundation import router as foundation_router
from quantpilot_market_data.routers.fundamentals import create_fundamentals_router
from quantpilot_market_data.routers.indicators import create_indicators_router
from quantpilot_market_data.routers.ingestion import router as ingestion_router
from quantpilot_market_data.routers.ingestion_writes import create_ingestion_write_router
from quantpilot_market_data.routers.lifecycle import create_lifecycle_router
from quantpilot_market_data.routers.provider_candidates import (
    router as provider_candidates_router,
)
from quantpilot_market_data.routers.quotes import create_quotes_router
from quantpilot_market_data.routers.registry import create_registry_router
from quantpilot_market_data.routers.research import create_research_router
from quantpilot_market_data.services.ingestion.tasks import IngestionTaskGroup
from quantpilot_market_data.services.registry import ProviderRegistryTtls

QUOTE_CACHE_TTL_SECONDS = ttl_from_env("QUANTPILOT_QUOTE_CACHE_TTL_SECONDS", 5)
SYMBOL_CACHE_TTL_SECONDS = ttl_from_env("QUANTPILOT_SYMBOL_CACHE_TTL_SECONDS", 86400)
KLINE_CACHE_TTL_SECONDS = ttl_from_env("QUANTPILOT_KLINE_CACHE_TTL_SECONDS", 1800)
FINANCIAL_CACHE_TTL_SECONDS = ttl_from_env("QUANTPILOT_FINANCIAL_CACHE_TTL_SECONDS", 21600)
ANNOUNCEMENT_CACHE_TTL_SECONDS = ttl_from_env("QUANTPILOT_ANNOUNCEMENT_CACHE_TTL_SECONDS", 600)
SCREENER_CACHE_TTL_SECONDS = ttl_from_env("QUANTPILOT_SCREENER_CACHE_TTL_SECONDS", 60)


def create_app() -> FastAPI:
    ingestion_tasks = IngestionTaskGroup()

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        try:
            yield
        finally:
            await ingestion_tasks.close()

    app = FastAPI(
        title="QuantPilot Market Data API",
        description="QuantPilot 量化分析 Agent 的市场数据后端",
        version="0.1.0",
        lifespan=lifespan,
    )
    app.add_middleware(
        CORSMiddleware,
        allow_origin_regex=r"^https?://(localhost|127\.0\.0\.1):\d+$",
        allow_credentials=False,
        allow_methods=["GET", "POST", "OPTIONS"],
        allow_headers=["*"],
    )
    client = EastMoneyClient()
    akshare_client = AkShareClient()
    baostock_client = BaoStockClient()
    cache = MarketDataCache()
    intraday_redis_cache = RedisJsonCache()

    async def database_probe() -> None:
        connection = await connect()
        async with connection:
            await connection.execute("SELECT 1")

    app.include_router(
        create_lifecycle_router(
            database_probe=database_probe,
            redis_probe=intraday_redis_cache.ping,
        )
    )
    app.include_router(analytics_router)
    app.include_router(foundation_router)
    app.include_router(ingestion_router)
    app.include_router(provider_candidates_router)
    app.include_router(
        create_backtest_router(
            client=client,
            cache=cache,
            kline_cache_ttl_seconds=KLINE_CACHE_TTL_SECONDS,
        )
    )
    app.include_router(
        create_events_router(
            announcement_client=client,
            dividend_client=client,
            cache=cache,
            announcement_cache_ttl_seconds=ANNOUNCEMENT_CACHE_TTL_SECONDS,
            financial_cache_ttl_seconds=FINANCIAL_CACHE_TTL_SECONDS,
        )
    )
    app.include_router(
        create_fundamentals_router(
            client=client,
            cache=cache,
            financial_cache_ttl_seconds=FINANCIAL_CACHE_TTL_SECONDS,
        )
    )
    app.include_router(
        create_indicators_router(
            client=client,
            cache=cache,
            kline_cache_ttl_seconds=KLINE_CACHE_TTL_SECONDS,
        )
    )
    app.include_router(
        create_quotes_router(
            client=client,
            cache=cache,
            intraday_redis_cache=intraday_redis_cache,
            symbol_cache_ttl_seconds=SYMBOL_CACHE_TTL_SECONDS,
            quote_cache_ttl_seconds=QUOTE_CACHE_TTL_SECONDS,
            kline_cache_ttl_seconds=KLINE_CACHE_TTL_SECONDS,
        )
    )
    app.include_router(
        create_context_router(
            client=client,
            cache=cache,
            intraday_redis_cache=intraday_redis_cache,
            quote_cache_ttl_seconds=QUOTE_CACHE_TTL_SECONDS,
            kline_cache_ttl_seconds=KLINE_CACHE_TTL_SECONDS,
            financial_cache_ttl_seconds=FINANCIAL_CACHE_TTL_SECONDS,
            announcement_cache_ttl_seconds=ANNOUNCEMENT_CACHE_TTL_SECONDS,
        )
    )
    app.include_router(create_research_router(client))
    app.include_router(
        create_registry_router(
            ProviderRegistryTtls(
                quote=QUOTE_CACHE_TTL_SECONDS,
                symbol=SYMBOL_CACHE_TTL_SECONDS,
                kline=KLINE_CACHE_TTL_SECONDS,
                financial=FINANCIAL_CACHE_TTL_SECONDS,
                announcement=ANNOUNCEMENT_CACHE_TTL_SECONDS,
                screener=SCREENER_CACHE_TTL_SECONDS,
            )
        )
    )

    app.include_router(
        create_ingestion_write_router(
            client=client,
            akshare_client=akshare_client,
            baostock_client=baostock_client,
            tasks=ingestion_tasks,
        )
    )
    return app


app = create_app()
