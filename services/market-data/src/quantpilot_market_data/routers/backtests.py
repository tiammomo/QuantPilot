from __future__ import annotations

from decimal import Decimal

from fastapi import APIRouter, HTTPException, Request

from quantpilot_market_data.cache import MarketDataCache
from quantpilot_market_data.contracts.analysis import BacktestResponse
from quantpilot_market_data.contracts.quotes import Adjustment, KlinePeriod
from quantpilot_market_data.providers.base import HistoricalKlineProvider
from quantpilot_market_data.providers.eastmoney import EastMoneyError
from quantpilot_market_data.services.backtests import (
    get_ma_crossover_backtest,
    get_strategy_backtest,
)


def create_backtest_router(
    *,
    client: HistoricalKlineProvider,
    cache: MarketDataCache,
    kline_cache_ttl_seconds: int,
) -> APIRouter:
    router = APIRouter(prefix="/api/v1/backtests", tags=["backtests"])

    @router.get("/ma-crossover/{symbol}", response_model=BacktestResponse)
    async def get_ma_crossover_backtest_endpoint(
        symbol: str,
        fast_window: int = 20,
        slow_window: int = 60,
        period: KlinePeriod = "daily",
        adjustment: Adjustment = "qfq",
        limit: int = 250,
        end: str = "20500101",
        initial_cash: Decimal = Decimal("1"),
        fee_bps: Decimal = Decimal("5"),
    ) -> BacktestResponse:
        try:
            return await get_ma_crossover_backtest(
                client,
                cache,
                symbol=symbol,
                fast_window=fast_window,
                slow_window=slow_window,
                period=period,
                adjustment=adjustment,
                limit=limit,
                end=end,
                initial_cash=initial_cash,
                fee_bps=fee_bps,
                ttl_seconds=kline_cache_ttl_seconds,
            )
        except ValueError as error:
            raise HTTPException(status_code=400, detail=str(error)) from error
        except EastMoneyError as error:
            raise HTTPException(status_code=502, detail=str(error)) from error

    @router.get("/strategies/{strategy_id}/{symbol}", response_model=BacktestResponse)
    async def get_strategy_backtest_endpoint(
        request: Request,
        strategy_id: str,
        symbol: str,
        period: KlinePeriod = "daily",
        adjustment: Adjustment = "qfq",
        limit: int = 1000,
        end: str = "20500101",
        initial_cash: Decimal = Decimal("1"),
        fee_bps: Decimal = Decimal("5"),
    ) -> BacktestResponse:
        try:
            return await get_strategy_backtest(
                client,
                cache,
                strategy_id=strategy_id,
                symbol=symbol,
                parameters=strategy_backtest_parameters(request),
                period=period,
                adjustment=adjustment,
                limit=limit,
                end=end,
                initial_cash=initial_cash,
                fee_bps=fee_bps,
                ttl_seconds=kline_cache_ttl_seconds,
            )
        except ValueError as error:
            raise HTTPException(status_code=400, detail=str(error)) from error
        except EastMoneyError as error:
            raise HTTPException(status_code=502, detail=str(error)) from error

    return router


def strategy_backtest_parameters(request: Request) -> dict[str, str]:
    reserved = {
        "period",
        "adjustment",
        "limit",
        "end",
        "initial_cash",
        "fee_bps",
    }
    return {
        key: value
        for key, value in request.query_params.items()
        if key not in reserved and value not in {"", "undefined", "null"}
    }
