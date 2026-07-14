from __future__ import annotations

import asyncio

import pytest
from fastapi import HTTPException

from quantpilot_market_data.security import require_market_admin


def call_admin_dependency(*, bearer: str | None = None, header: str | None = None) -> None:
    asyncio.run(require_market_admin(bearer, header))


def test_loopback_development_allows_missing_token(monkeypatch) -> None:
    monkeypatch.setenv("QUANTPILOT_MARKET_HOST", "127.0.0.1")
    monkeypatch.setenv("QUANTPILOT_DEGRADATION_MODE", "auto")
    monkeypatch.delenv("QUANTPILOT_MARKET_ADMIN_TOKEN", raising=False)
    call_admin_dependency()


def test_non_loopback_without_token_fails_closed(monkeypatch) -> None:
    monkeypatch.setenv("QUANTPILOT_MARKET_HOST", "0.0.0.0")
    monkeypatch.setenv("QUANTPILOT_DEGRADATION_MODE", "auto")
    monkeypatch.delenv("QUANTPILOT_MARKET_ADMIN_TOKEN", raising=False)
    with pytest.raises(HTTPException) as raised:
        call_admin_dependency()
    assert raised.value.status_code == 503


def test_configured_token_is_always_required(monkeypatch) -> None:
    monkeypatch.setenv("QUANTPILOT_MARKET_HOST", "127.0.0.1")
    monkeypatch.setenv("QUANTPILOT_MARKET_ADMIN_TOKEN", "secret")
    with pytest.raises(HTTPException) as raised:
        call_admin_dependency()
    assert raised.value.status_code == 401

    call_admin_dependency(bearer="Bearer secret")
    call_admin_dependency(header="secret")
