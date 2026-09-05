from __future__ import annotations

from fastapi import APIRouter

from quantpilot_market_data.contracts.foundation import DataRegistryResponse
from quantpilot_market_data.services.registry import ProviderRegistryTtls, build_data_registry


def create_registry_router(ttls: ProviderRegistryTtls) -> APIRouter:
    router = APIRouter(prefix="/api/v1", tags=["registry"])

    @router.get("/registry", response_model=DataRegistryResponse)
    async def get_data_registry() -> DataRegistryResponse:
        return build_data_registry(ttls)

    return router
