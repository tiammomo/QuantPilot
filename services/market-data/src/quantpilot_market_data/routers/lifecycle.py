from __future__ import annotations

from collections.abc import Awaitable, Callable

from fastapi import APIRouter
from fastapi.responses import JSONResponse

from quantpilot_market_data.readiness import get_market_readiness

DatabaseProbe = Callable[[], Awaitable[None]]
RedisProbe = Callable[[], Awaitable[bool]]


def create_lifecycle_router(
    *,
    database_probe: DatabaseProbe,
    redis_probe: RedisProbe,
) -> APIRouter:
    router = APIRouter(tags=["lifecycle"])

    @router.get("/health")
    async def health() -> JSONResponse:
        return JSONResponse(
            content={"status": "ok", "service": "quantpilot-market-data"},
            headers={"Cache-Control": "no-store, max-age=0"},
        )

    @router.get("/ready")
    async def ready() -> JSONResponse:
        result = await get_market_readiness(
            database_probe=database_probe,
            redis_probe=redis_probe,
        )
        return JSONResponse(
            content=result,
            status_code=200 if result["ok"] else 503,
            headers={"Cache-Control": "no-store, max-age=0"},
        )

    return router
