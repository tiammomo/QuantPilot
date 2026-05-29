from __future__ import annotations

import asyncio
import os
import threading
from contextlib import contextmanager
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal, InvalidOperation
from typing import Any

from quantpilot_market_data.models import (
    Adjustment,
    KlineBar,
    KlinePeriod,
    KlineResponse,
)
from quantpilot_market_data.providers.base import ProviderCapability
from quantpilot_market_data.providers.eastmoney import (
    infer_asset_type,
    market_from_secid,
    normalize_secid,
)


class AkShareError(RuntimeError):
    """AKShare SDK 不可用、接口失败或返回字段不符合契约。"""


PROXY_ENV_KEYS = (
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
)
NO_PROXY_ENV_KEYS = ("NO_PROXY", "no_proxy")
PROXY_ENV_LOCK = threading.Lock()


@contextmanager
def without_proxy_env():
    with PROXY_ENV_LOCK:
        previous = {key: os.environ.get(key) for key in (*PROXY_ENV_KEYS, *NO_PROXY_ENV_KEYS)}
        for key in PROXY_ENV_KEYS:
            os.environ.pop(key, None)
        os.environ["NO_PROXY"] = "*"
        os.environ["no_proxy"] = "*"
        try:
            yield
        finally:
            for key, value in previous.items():
                if value is None:
                    os.environ.pop(key, None)
                else:
                    os.environ[key] = value


class AkShareClient:
    id = "akshare-provider"
    name = "AKShare 聚合数据源"
    capability = ProviderCapability(
        status="degraded",
        markets=("a-share", "index-etf"),
        supports_history_kline=True,
        notes=(
            "可选 Python SDK，用于补 A 股历史成交额、振幅、涨跌额和换手率。",
            "部分接口底层仍依赖东方财富等公开端点，需低频补数和字段质量检查。",
        ),
    )

    async def get_kline_range(
        self,
        symbol_or_secid: str,
        *,
        period: KlinePeriod = "daily",
        adjustment: Adjustment = "qfq",
        start_date: str,
        end_date: str,
        limit: int = 1260,
    ) -> KlineResponse:
        if period not in {"daily", "weekly", "monthly"}:
            raise AkShareError(f"AKShare 当前只用于日/周/月线补数，不支持：{period}")

        symbol = akshare_symbol(symbol_or_secid)
        normalized_end = normalize_akshare_end_date(end_date)
        normalized_start = normalize_akshare_start_date(start_date, normalized_end, period, limit)

        try:
            records = await asyncio.to_thread(
                fetch_stock_zh_a_hist_records,
                symbol,
                period,
                normalized_start,
                normalized_end,
                akshare_adjustment(adjustment),
            )
        except ModuleNotFoundError as error:
            raise AkShareError(
                "当前 Python 环境未安装 akshare；请在 services/market-data 中执行 "
                "`uv sync --extra akshare` 或 `uv pip install akshare` 后重试。"
            ) from error
        except Exception as error:
            raise AkShareError(f"AKShare 历史行情请求失败：{error}") from error

        bars = parse_akshare_hist_records(records)
        if limit > 0:
            bars = bars[-limit:]
        secid = normalize_secid(symbol)
        return KlineResponse(
            symbol=symbol,
            secid=secid,
            asset_type=infer_asset_type(symbol=symbol, secid=secid, name=None),
            market=market_from_secid(secid),
            source="akshare",
            period=period,
            adjustment=adjustment,
            bars=bars,
            fetched_at=datetime.now(UTC),
            metadata={
                "source": "akshare",
                "sdk": "akshare.stock_zh_a_hist",
                "start_date": normalized_start,
                "end_date": normalized_end,
                "adjust": akshare_adjustment(adjustment),
            },
        )

    async def get_kline(
        self,
        symbol_or_secid: str,
        *,
        period: KlinePeriod = "daily",
        adjustment: Adjustment = "qfq",
        limit: int = 120,
        end: str = "20500101",
        allow_fallback: bool = True,
    ) -> KlineResponse:
        end_date = normalize_akshare_end_date(end)
        start_date = normalize_akshare_start_date("", end_date, period, limit)
        return await self.get_kline_range(
            symbol_or_secid,
            period=period,
            adjustment=adjustment,
            start_date=start_date,
            end_date=end_date,
            limit=limit,
        )


def fetch_stock_zh_a_hist_records(
    symbol: str,
    period: KlinePeriod,
    start_date: str,
    end_date: str,
    adjustment: str,
) -> list[dict[str, Any]]:
    import akshare as ak

    with without_proxy_env():
        frame = ak.stock_zh_a_hist(
            symbol=symbol,
            period=period,
            start_date=start_date,
            end_date=end_date,
            adjust=adjustment,
        )
    if frame is None:
        return []
    return frame.to_dict(orient="records")


def parse_akshare_hist_records(records: list[dict[str, Any]]) -> list[KlineBar]:
    bars: list[KlineBar] = []
    for record in records:
        date_value = first_record_value(record, "日期", "date")
        if date_value in (None, ""):
            continue
        bars.append(
            KlineBar(
                date=str(date_value),
                open=decimal_from_record(record, "开盘", "open"),
                close=decimal_from_record(record, "收盘", "close"),
                high=decimal_from_record(record, "最高", "high"),
                low=decimal_from_record(record, "最低", "low"),
                volume=int_from_record(record, "成交量", "volume"),
                amount=decimal_from_record(record, "成交额", "amount"),
                amplitude=decimal_from_record(record, "振幅", "amplitude"),
                change_percent=decimal_from_record(record, "涨跌幅", "change_percent"),
                change_amount=decimal_from_record(record, "涨跌额", "change_amount"),
                turnover=decimal_from_record(record, "换手率", "turnover"),
                metadata={
                    "source": "akshare",
                    "raw": normalize_record(record),
                    "fields": {
                        "date": str(date_value),
                        "amount": text_from_record(record, "成交额", "amount"),
                        "amplitude": text_from_record(record, "振幅", "amplitude"),
                        "change_percent": text_from_record(record, "涨跌幅", "change_percent"),
                        "change_amount": text_from_record(record, "涨跌额", "change_amount"),
                        "turnover": text_from_record(record, "换手率", "turnover"),
                    },
                },
            )
        )
    return bars


def akshare_symbol(symbol_or_secid: str) -> str:
    value = symbol_or_secid.strip().upper()
    if "." in value:
        left, right = value.split(".", 1)
        if left in {"0", "1"} and right.isdigit():
            return right
        if left.isdigit():
            return left
    for prefix in ("SH", "SZ", "BJ"):
        if value.startswith(prefix) and value[len(prefix) :].isdigit():
            return value[len(prefix) :]
    return value[:6] if len(value) >= 6 and value[:6].isdigit() else value


def akshare_adjustment(adjustment: Adjustment) -> str:
    return "" if adjustment == "none" else adjustment


def normalize_akshare_end_date(value: str) -> str:
    today = datetime.now(UTC).date()
    raw = (value or "").strip()
    parsed: date | None = None
    if len(raw) == 8 and raw.isdigit():
        parsed = date(int(raw[:4]), int(raw[4:6]), int(raw[6:8]))
    elif len(raw) == 10:
        parsed = date.fromisoformat(raw)
    if parsed is None or parsed > today:
        parsed = today
    return parsed.strftime("%Y%m%d")


def normalize_akshare_start_date(
    value: str,
    end_date: str,
    period: KlinePeriod,
    limit: int,
) -> str:
    raw = (value or "").strip()
    if len(raw) == 8 and raw.isdigit():
        return raw
    if len(raw) == 10:
        return date.fromisoformat(raw).strftime("%Y%m%d")

    end = date(int(end_date[:4]), int(end_date[4:6]), int(end_date[6:8]))
    multiplier = 2 if period == "daily" else 9 if period == "weekly" else 40
    start = end - timedelta(days=max(30, limit * multiplier))
    return start.strftime("%Y%m%d")


def first_record_value(record: dict[str, Any], *keys: str) -> Any:
    for key in keys:
        value = record.get(key)
        if value not in (None, ""):
            return value
    return None


def text_from_record(record: dict[str, Any], *keys: str) -> str | None:
    value = first_record_value(record, *keys)
    if value in (None, ""):
        return None
    return str(value)


def decimal_from_record(record: dict[str, Any], *keys: str) -> Decimal | None:
    value = first_record_value(record, *keys)
    if value in (None, "", "-", "nan", "NaN"):
        return None
    try:
        return Decimal(str(value))
    except (InvalidOperation, ValueError):
        return None


def int_from_record(record: dict[str, Any], *keys: str) -> int | None:
    value = decimal_from_record(record, *keys)
    return int(value) if value is not None else None


def normalize_record(record: dict[str, Any]) -> dict[str, str | None]:
    return {
        str(key): None if value is None else str(value)
        for key, value in record.items()
    }
