from __future__ import annotations

import asyncio
from datetime import UTC, datetime
from decimal import Decimal
from pathlib import Path

from quantpilot_market_data.cache import MarketDataCache
from quantpilot_market_data.models import FinancialReportItem
from quantpilot_market_data.services.fundamentals import (
    get_financial_reports,
    get_fundamental_indicators,
)


class StubFinancialProvider:
    id = "stub-financials"
    name = "Stub financials"
    capability = None

    def __init__(self) -> None:
        self.calls = 0

    async def get_financial_reports(
        self,
        symbol: str,
        *,
        limit: int = 8,
    ) -> list[FinancialReportItem]:
        self.calls += 1
        return [
            FinancialReportItem(
                symbol=symbol,
                report_date=datetime(2025, 12, 31, tzinfo=UTC),
                data_type="2025年 年报",
                net_profit_yoy=Decimal("124.17"),
                operating_cash_flow_per_share=Decimal("0.3084"),
            ),
            FinancialReportItem(
                symbol=symbol,
                report_date=datetime(2024, 12, 31, tzinfo=UTC),
                data_type="2024年 年报",
                operating_cash_flow_per_share=Decimal("0.2837"),
            ),
        ][:limit]


def test_fundamental_cache_namespaces_invalidate_pre_contract_payloads(tmp_path: Path) -> None:
    provider = StubFinancialProvider()
    cache = MarketDataCache(root=tmp_path, enabled=True)

    financials = asyncio.run(
        get_financial_reports(provider, cache, symbol="600111", limit=8, ttl_seconds=3600)
    )
    indicators = asyncio.run(
        get_fundamental_indicators(provider, cache, symbol="600111", limit=8, ttl_seconds=3600)
    )

    assert financials.fetch.cache_key.startswith("fundamental-financials-v2-")
    assert indicators.fetch.cache_key.startswith("fundamental-indicators-v2-")
    assert financials.reports[0].operating_cash_flow_per_share == Decimal("0.3084")
    assert indicators.points[0].operating_cash_flow_per_share == Decimal("0.3084")
    assert indicators.points[0].operating_cash_flow_per_share_yoy == Decimal("8.7064")

    cached = asyncio.run(
        get_fundamental_indicators(provider, cache, symbol="600111", limit=8, ttl_seconds=3600)
    )
    assert cached.fetch.cache_status == "hit"
    assert provider.calls == 2
