from __future__ import annotations

import asyncio
from datetime import date
from typing import Any

import pytest
from fastapi.testclient import TestClient

from quantpilot_market_data.api import create_app
from quantpilot_market_data.models import (
    TradingCalendarDay,
    TradingCalendarRefreshRequest,
    TradingCalendarRefreshResponse,
)
from quantpilot_market_data.repositories import foundation as foundation_repository
from quantpilot_market_data.routers import foundation as foundation_router
from quantpilot_market_data.services import foundation as foundation_service


def calendar_day(value: date, *, is_open: bool) -> TradingCalendarDay:
    return TradingCalendarDay(
        market="CN-A",
        trade_date=value,
        is_open=is_open,
        session="regular",
        source="baostock",
        metadata={"raw": {"calendar_date": value.isoformat()}},
    )


def test_refresh_calendar_defaults_to_five_year_window_and_returns_stats(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    provider_calls: list[tuple[str, str]] = []
    persisted: list[TradingCalendarDay] = []

    def fake_fetch(start: str, end: str) -> list[TradingCalendarDay]:
        provider_calls.append((start, end))
        return [
            calendar_day(date(2026, 7, 12), is_open=False),
            calendar_day(date(2026, 7, 13), is_open=True),
        ]

    async def fake_upsert(days: list[TradingCalendarDay]) -> dict[str, int]:
        persisted.extend(days)
        return {
            "received_days": 2,
            "inserted_days": 1,
            "updated_days": 0,
            "unchanged_days": 1,
            "written_days": 1,
        }

    monkeypatch.setattr(foundation_service, "_cn_today", lambda: date(2026, 7, 14))
    monkeypatch.setattr(foundation_service, "fetch_baostock_trade_dates", fake_fetch)
    monkeypatch.setattr(foundation_service, "upsert_trading_calendar_days", fake_upsert)

    response = asyncio.run(
        foundation_service.refresh_trading_calendar(TradingCalendarRefreshRequest())
    )

    assert provider_calls == [("2021-07-14", "2026-07-14")]
    assert persisted == [
        calendar_day(date(2026, 7, 12), is_open=False),
        calendar_day(date(2026, 7, 13), is_open=True),
    ]
    assert response.start == date(2021, 7, 14)
    assert response.end == date(2026, 7, 14)
    assert response.requested_days == 1827
    assert response.received_days == 2
    assert response.inserted_days == 1
    assert response.updated_days == 0
    assert response.unchanged_days == 1
    assert response.written_days == 1
    assert response.open_days == 1
    assert response.closed_days == 1
    assert response.first_date == date(2026, 7, 12)
    assert response.last_date == date(2026, 7, 13)


def test_refresh_calendar_rejects_future_end(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(foundation_service, "_cn_today", lambda: date(2026, 7, 14))

    with pytest.raises(ValueError, match="end 不能晚于上海时区今天"):
        asyncio.run(
            foundation_service.refresh_trading_calendar(
                TradingCalendarRefreshRequest(end=date(2026, 7, 15))
            )
        )


class FakeCursor:
    def __init__(self, row: dict[str, int]) -> None:
        self.row = row
        self.query = ""
        self.params: tuple[Any, ...] = ()

    async def __aenter__(self) -> FakeCursor:
        return self

    async def __aexit__(self, *args: object) -> None:
        return None

    async def execute(self, query: str, params: tuple[Any, ...]) -> None:
        self.query = query
        self.params = params

    async def fetchone(self) -> dict[str, int]:
        return self.row


class FakeConnection:
    def __init__(self, cursor: FakeCursor) -> None:
        self.fake_cursor = cursor

    async def __aenter__(self) -> FakeConnection:
        return self

    async def __aexit__(self, *args: object) -> None:
        return None

    def cursor(self, **kwargs: object) -> FakeCursor:
        return self.fake_cursor


def test_repository_uses_idempotent_calendar_upsert(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    cursor = FakeCursor(
        {
            "received_days": 2,
            "inserted_days": 1,
            "updated_days": 0,
            "unchanged_days": 1,
            "written_days": 1,
        }
    )

    async def fake_connect() -> FakeConnection:
        return FakeConnection(cursor)

    monkeypatch.setattr(foundation_repository, "connect", fake_connect)
    result = asyncio.run(
        foundation_repository.upsert_trading_calendar_days(
            [
                calendar_day(date(2026, 7, 12), is_open=False),
                calendar_day(date(2026, 7, 13), is_open=True),
            ]
        )
    )

    assert result == {
        "received_days": 2,
        "inserted_days": 1,
        "updated_days": 0,
        "unchanged_days": 1,
        "written_days": 1,
    }
    assert "ON CONFLICT (market, trade_date, session) DO UPDATE" in cursor.query
    assert "IS DISTINCT FROM EXCLUDED" in cursor.query
    payload = cursor.params[0].obj
    assert [item["is_open"] for item in payload] == [False, True]
    assert {item["source"] for item in payload} == {"baostock"}
    assert {item["session"] for item in payload} == {"regular"}


def test_refresh_calendar_admin_route(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    requests: list[TradingCalendarRefreshRequest] = []

    async def fake_refresh(
        request: TradingCalendarRefreshRequest,
    ) -> TradingCalendarRefreshResponse:
        requests.append(request)
        return TradingCalendarRefreshResponse(
            start=date(2026, 7, 12),
            end=date(2026, 7, 13),
            requested_days=2,
            received_days=2,
            inserted_days=2,
            written_days=2,
            open_days=1,
            closed_days=1,
            first_date=date(2026, 7, 12),
            last_date=date(2026, 7, 13),
        )

    monkeypatch.setenv("QUANTPILOT_MARKET_HOST", "127.0.0.1")
    monkeypatch.setenv("QUANTPILOT_DEGRADATION_MODE", "auto")
    monkeypatch.delenv("QUANTPILOT_MARKET_ADMIN_TOKEN", raising=False)
    monkeypatch.setattr(foundation_router, "refresh_trading_calendar", fake_refresh)

    with TestClient(create_app()) as client:
        response = client.post(
            "/api/v1/foundation/trading-calendar/refresh",
            json={"start": "2026-07-12", "end": "2026-07-13"},
        )

    assert response.status_code == 200
    assert response.json()["source"] == "baostock"
    assert response.json()["inserted_days"] == 2
    assert response.json()["written_days"] == 2
    assert response.json()["closed_days"] == 1
    assert requests == [
        TradingCalendarRefreshRequest(
            start=date(2026, 7, 12),
            end=date(2026, 7, 13),
        )
    ]


def test_refresh_calendar_route_validates_range(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("QUANTPILOT_MARKET_HOST", "127.0.0.1")
    monkeypatch.setenv("QUANTPILOT_DEGRADATION_MODE", "auto")
    monkeypatch.delenv("QUANTPILOT_MARKET_ADMIN_TOKEN", raising=False)

    with TestClient(create_app()) as client:
        response = client.post(
            "/api/v1/foundation/trading-calendar/refresh",
            json={"start": "2026-07-14", "end": "2026-07-13"},
        )

    assert response.status_code == 422
    assert "start 不能晚于 end" in response.text
