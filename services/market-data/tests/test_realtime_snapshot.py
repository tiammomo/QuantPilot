from __future__ import annotations

from datetime import UTC, datetime
from decimal import Decimal

import pytest

from quantpilot_market_data.models import RealtimeQuote
from quantpilot_market_data.repositories.upserts import validate_realtime_snapshot


def quote(*, source: str = "eastmoney") -> RealtimeQuote:
    timestamp = datetime(2026, 7, 13, 7, 0, tzinfo=UTC)
    return RealtimeQuote(
        symbol="600519",
        secid="1.600519",
        market="SH",
        source=source,
        price=Decimal("1500"),
        open=Decimal("1490"),
        high=Decimal("1510"),
        low=Decimal("1480"),
        quote_time=timestamp,
        fetched_at=timestamp,
    )


def test_snapshot_date_must_match_quote_time() -> None:
    trade_date, quote_time = validate_realtime_snapshot(quote(), "2026-07-13")
    assert trade_date.isoformat() == "2026-07-13"
    assert quote_time == quote().quote_time
    with pytest.raises(ValueError, match="禁止回填"):
        validate_realtime_snapshot(quote(), "2026-07-12")


def test_snapshot_rejects_unknown_source() -> None:
    with pytest.raises(ValueError, match="只接受 eastmoney"):
        validate_realtime_snapshot(quote(source="proxy"), None)
