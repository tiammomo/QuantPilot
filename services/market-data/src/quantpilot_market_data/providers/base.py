from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal, Protocol

from quantpilot_market_data.models import (
    Adjustment,
    AnnouncementItem,
    DividendEvent,
    FinancialReportItem,
    KlinePeriod,
    KlineResponse,
    RealtimeQuote,
    SymbolResolveResult,
)

ProviderStatus = Literal["available", "degraded", "planned"]
ProviderMarket = Literal["a-share", "hk", "us", "global", "mixed", "index-etf"]


@dataclass(frozen=True)
class ProviderCapability:
    """Provider metadata used by routers and the capability-support registry."""

    status: ProviderStatus
    markets: tuple[ProviderMarket, ...]
    supports_realtime: bool = False
    supports_history_kline: bool = False
    supports_events: bool = False
    supports_fundamentals: bool = False
    requires_key: bool = False
    notes: tuple[str, ...] = field(default_factory=tuple)


class MarketDataProvider(Protocol):
    """Common metadata contract for market data providers."""

    id: str
    name: str
    capability: ProviderCapability


class HistoricalKlineProvider(MarketDataProvider, Protocol):
    """Provider contract for historical OHLCV/K-line data."""

    async def get_kline(
        self,
        symbol_or_secid: str,
        *,
        period: KlinePeriod = "daily",
        adjustment: Adjustment = "qfq",
        limit: int = 120,
        end: str = "20500101",
        allow_fallback: bool = True,
    ) -> KlineResponse: ...


class SymbolResolverProvider(MarketDataProvider, Protocol):
    """Provider contract for security symbol search and resolution."""

    async def resolve_symbol(
        self,
        query: str,
        *,
        count: int = 5,
    ) -> list[SymbolResolveResult]: ...


class RealtimeQuoteProvider(MarketDataProvider, Protocol):
    """Provider contract for realtime quote snapshots."""

    async def get_realtime_quote(self, symbol_or_secid: str) -> RealtimeQuote: ...

    async def get_realtime_quotes(
        self,
        symbols_or_secids: list[str],
    ) -> list[RealtimeQuote]: ...


class QuoteReadProvider(
    SymbolResolverProvider,
    RealtimeQuoteProvider,
    HistoricalKlineProvider,
    Protocol,
):
    """Provider contract for read-only quote, symbol and K-line use cases."""


class ResearchUniverseProvider(SymbolResolverProvider, RealtimeQuoteProvider, Protocol):
    """Provider contract for research-universe symbol discovery."""

    async def list_a_share_symbols(
        self,
        *,
        page: int = 1,
        page_size: int = 100,
    ) -> tuple[int, list[SymbolResolveResult]]: ...

    async def list_etf_symbols(
        self,
        *,
        page: int = 1,
        page_size: int = 100,
    ) -> tuple[int, list[SymbolResolveResult]]: ...


class FinancialReportProvider(MarketDataProvider, Protocol):
    """Provider contract for financial statement summaries."""

    async def get_financial_reports(
        self,
        symbol: str,
        *,
        limit: int = 8,
    ) -> list[FinancialReportItem]: ...


class AnnouncementProvider(MarketDataProvider, Protocol):
    """Provider contract for announcement/event feeds."""

    async def get_announcements(
        self,
        symbol: str,
        *,
        limit: int = 20,
    ) -> list[AnnouncementItem]: ...


class DividendEventProvider(MarketDataProvider, Protocol):
    """Provider contract for dividend and ex-rights events."""

    async def get_dividend_events(
        self,
        symbol: str,
        *,
        limit: int = 20,
    ) -> list[DividendEvent]: ...


class AnalysisContextProvider(
    RealtimeQuoteProvider,
    HistoricalKlineProvider,
    FinancialReportProvider,
    AnnouncementProvider,
    Protocol,
):
    """Provider capabilities required by the aggregate analysis-context use case."""
