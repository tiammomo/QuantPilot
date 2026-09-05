from __future__ import annotations

from fastapi import FastAPI
from fastapi.testclient import TestClient

from quantpilot_market_data.routers.lifecycle import create_lifecycle_router


async def passing_database_probe() -> None:
    return None


async def passing_redis_probe() -> bool:
    return True


async def failing_database_probe() -> None:
    raise RuntimeError("database password must not leak")


def client(*, failing_database: bool = False) -> TestClient:
    app = FastAPI()
    app.include_router(
        create_lifecycle_router(
            database_probe=(failing_database_probe if failing_database else passing_database_probe),
            redis_probe=passing_redis_probe,
        )
    )
    return TestClient(app)


def test_health_is_a_cache_safe_liveness_contract() -> None:
    response = client().get("/health")

    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store, max-age=0"
    assert response.json() == {"status": "ok", "service": "quantpilot-market-data"}


def test_ready_blocks_on_required_database_without_leaking_details(monkeypatch) -> None:
    monkeypatch.setenv("QUANTPILOT_DEGRADATION_MODE", "strict")
    monkeypatch.setenv("QUANTPILOT_DATABASE_REQUIRED", "1")
    response = client(failing_database=True).get("/ready")

    assert response.status_code == 503
    assert response.headers["cache-control"] == "no-store, max-age=0"
    assert response.json()["components"]["database"]["status"] == "failed"
    assert "password" not in response.text
