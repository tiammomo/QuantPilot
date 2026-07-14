from __future__ import annotations

import asyncio
from datetime import date, datetime

from quantpilot_market_data.database_core import SHANGHAI_TZ
from quantpilot_market_data.models import (
    DataQualityScanRequest,
    DataQualityScanResponse,
    FactorDefinitionResponse,
    FoundationStatusResponse,
    TradingCalendarRefreshRequest,
    TradingCalendarRefreshResponse,
    TradingCalendarResponse,
)
from quantpilot_market_data.providers.baostock import (
    BaoStockError,
    fetch_baostock_trade_dates,
)
from quantpilot_market_data.repositories.foundation import (
    list_factor_definitions,
    list_foundation_components,
    list_trading_calendar_days,
    run_data_quality_scan,
    upsert_trading_calendar_days,
)


async def get_foundation_status() -> FoundationStatusResponse:
    return FoundationStatusResponse(components=await list_foundation_components())


async def get_factor_definitions(
    *,
    category: str | None = None,
    status: str | None = None,
) -> FactorDefinitionResponse:
    return FactorDefinitionResponse(
        factors=await list_factor_definitions(category=category, status=status)
    )


async def get_trading_calendar(
    *,
    market: str,
    start: str | None,
    end: str | None,
    limit: int,
) -> TradingCalendarResponse:
    days = await list_trading_calendar_days(
        market=market,
        start=start,
        end=end,
        limit=limit,
    )
    return TradingCalendarResponse(
        market=market,
        start=date.fromisoformat(start) if start else None,
        end=date.fromisoformat(end) if end else None,
        days=days,
    )


def _cn_today() -> date:
    return datetime.now(SHANGHAI_TZ).date()


def _years_before(value: date, years: int) -> date:
    try:
        return value.replace(year=value.year - years)
    except ValueError:
        return value.replace(year=value.year - years, day=28)


async def refresh_trading_calendar(
    request: TradingCalendarRefreshRequest,
) -> TradingCalendarRefreshResponse:
    today = _cn_today()
    end_date = request.end or today
    if end_date > today:
        raise ValueError("end 不能晚于上海时区今天")
    start_date = request.start or _years_before(end_date, 5)
    if start_date > end_date:
        raise ValueError("start 不能晚于 end")

    try:
        days = await asyncio.to_thread(
            fetch_baostock_trade_dates,
            start_date.isoformat(),
            end_date.isoformat(),
        )
    except ModuleNotFoundError as error:
        raise BaoStockError(
            "当前 Python 环境未安装 baostock；请在 services/market-data 中执行 "
            "`uv sync --extra baostock` 或 `uv pip install baostock` 后重试。"
        ) from error

    days = [day for day in days if start_date <= day.trade_date <= end_date]
    if not days:
        raise BaoStockError("Baostock 交易日历请求失败：指定区间未返回任何日历记录。")
    stats = await upsert_trading_calendar_days(days)
    open_days = sum(1 for day in days if day.is_open)
    return TradingCalendarRefreshResponse(
        start=start_date,
        end=end_date,
        requested_days=(end_date - start_date).days + 1,
        received_days=stats["received_days"],
        inserted_days=stats["inserted_days"],
        updated_days=stats["updated_days"],
        unchanged_days=stats["unchanged_days"],
        written_days=stats["written_days"],
        open_days=open_days,
        closed_days=len(days) - open_days,
        first_date=min(day.trade_date for day in days),
        last_date=max(day.trade_date for day in days),
    )


async def scan_data_quality(
    request: DataQualityScanRequest,
) -> DataQualityScanResponse:
    return await run_data_quality_scan(request)
