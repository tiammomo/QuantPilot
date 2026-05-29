from __future__ import annotations

import asyncio
from datetime import UTC, date, datetime, timedelta
from decimal import ROUND_HALF_UP, Decimal, InvalidOperation
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

PERCENT_QUANT = Decimal("0.00000001")


class BaoStockError(RuntimeError):
    """Baostock SDK 不可用、登录失败或返回字段不符合契约。"""


class BaoStockClient:
    id = "baostock-provider"
    name = "Baostock A 股历史行情"
    capability = ProviderCapability(
        status="available",
        markets=("a-share",),
        supports_history_kline=True,
        notes=(
            "免费 Python SDK，适合补 A 股日线成交额和换手率。",
            "返回 volume 为股数，入库前统一折算为手，保持前端成交量口径稳定。",
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
            raise BaoStockError(f"Baostock 当前只用于日/周/月线补数，不支持：{period}")

        code = baostock_code(symbol_or_secid)
        normalized_start = normalize_baostock_date(start_date, fallback_days=limit * 2)
        normalized_end = normalize_baostock_date(end_date, fallback_days=0, clamp_today=True)
        try:
            records = await asyncio.to_thread(
                fetch_baostock_history_records,
                code,
                baostock_frequency(period),
                normalized_start,
                normalized_end,
                baostock_adjustflag(adjustment),
            )
        except ModuleNotFoundError as error:
            raise BaoStockError(
                "当前 Python 环境未安装 baostock；请在 services/market-data 中执行 "
                "`uv sync --extra baostock` 或 `uv pip install baostock` 后重试。"
            ) from error
        except Exception as error:
            raise BaoStockError(f"Baostock 历史行情请求失败：{error}") from error

        bars = parse_baostock_records(records)
        if limit > 0:
            bars = bars[-limit:]
        symbol = baostock_symbol(code)
        secid = normalize_secid(symbol)
        return KlineResponse(
            symbol=symbol,
            secid=secid,
            asset_type=infer_asset_type(symbol=symbol, secid=secid, name=None),
            market=market_from_secid(secid),
            source="baostock",
            period=period,
            adjustment=adjustment,
            bars=bars,
            fetched_at=datetime.now(UTC),
            metadata={
                "source": "baostock",
                "sdk": "baostock.query_history_k_data_plus",
                "start_date": normalized_start,
                "end_date": normalized_end,
                "adjustflag": baostock_adjustflag(adjustment),
                "volume_unit": "hands",
            },
        )


def fetch_baostock_history_records(
    code: str,
    frequency: str,
    start_date: str,
    end_date: str,
    adjustflag: str,
) -> list[dict[str, Any]]:
    import baostock as bs

    login = bs.login()
    if login.error_code != "0":
        raise BaoStockError(f"Baostock 登录失败：{login.error_msg}")
    try:
        fields = (
            "date,code,open,high,low,close,preclose,volume,amount,"
            "adjustflag,turn,pctChg,tradestatus,isST,peTTM,pbMRQ,psTTM,pcfNcfTTM"
        )
        result = bs.query_history_k_data_plus(
            code,
            fields,
            start_date=start_date,
            end_date=end_date,
            frequency=frequency,
            adjustflag=adjustflag,
        )
        if result.error_code != "0":
            raise BaoStockError(result.error_msg)
        rows: list[dict[str, Any]] = []
        while result.next():
            rows.append(dict(zip(result.fields, result.get_row_data(), strict=False)))
        return rows
    finally:
        bs.logout()


def parse_baostock_records(records: list[dict[str, Any]]) -> list[KlineBar]:
    bars: list[KlineBar] = []
    for record in records:
        date_value = text_from_record(record, "date")
        if not date_value:
            continue
        code = text_from_record(record, "code") or ""
        preclose = decimal_from_record(record, "preclose")
        high = decimal_from_record(record, "high")
        low = decimal_from_record(record, "low")
        close = decimal_from_record(record, "close")
        change_percent = decimal_from_record(record, "pctChg")
        is_stock = is_a_share_stock_code(code)
        is_st = bool_from_record(record, "isST") if is_stock else False
        limit_marker = limit_marker_from_pct(
            code=code,
            change_percent=change_percent,
            is_st=is_st,
        )
        factors = factor_values_from_record(record)
        change_amount = (
            close - preclose
            if close is not None and preclose not in (None, 0)
            else None
        )
        amplitude = (
            (((high - low) / preclose) * Decimal("100")).quantize(
                PERCENT_QUANT,
                rounding=ROUND_HALF_UP,
            )
            if high is not None and low is not None and preclose not in (None, 0)
            else None
        )
        bars.append(
            KlineBar(
                date=date_value,
                open=decimal_from_record(record, "open"),
                close=close,
                high=high,
                low=low,
                previous_close=preclose,
                volume=baostock_volume_hands(record),
                amount=decimal_from_record(record, "amount"),
                amplitude=amplitude,
                change_percent=change_percent,
                change_amount=change_amount,
                turnover=decimal_from_record(record, "turn"),
                trade_status=text_from_record(record, "tradestatus"),
                is_st=is_st,
                limit_up=limit_marker == "up",
                limit_down=limit_marker == "down",
                metadata={
                    "source": "baostock",
                    "raw": normalize_record(record),
                    "fields": {
                        "amount": text_from_record(record, "amount"),
                        "turnover": text_from_record(record, "turn"),
                        "change_percent": text_from_record(record, "pctChg"),
                        "preclose": text_from_record(record, "preclose"),
                        "tradestatus": text_from_record(record, "tradestatus"),
                        "is_st": text_from_record(record, "isST"),
                        "volume": text_from_record(record, "volume"),
                    },
                    "factors": factors,
                    "volume_unit": "hands",
                },
            )
        )
    return bars


def baostock_code(symbol_or_secid: str) -> str:
    secid = normalize_secid(symbol_or_secid)
    market = market_from_secid(secid)
    symbol = secid.split(".", 1)[1] if "." in secid else symbol_or_secid[:6]
    prefix = "sh" if market == "SH" else "bj" if market == "BJ" else "sz"
    return f"{prefix}.{symbol}"


def baostock_symbol(code: str) -> str:
    return code.split(".", 1)[1] if "." in code else code


def baostock_frequency(period: KlinePeriod) -> str:
    return {"daily": "d", "weekly": "w", "monthly": "m"}[period]


def baostock_adjustflag(adjustment: Adjustment) -> str:
    return {"hfq": "1", "qfq": "2", "none": "3"}[adjustment]


def normalize_baostock_date(
    value: str,
    *,
    fallback_days: int,
    clamp_today: bool = False,
) -> str:
    raw = (value or "").strip()
    parsed: date | None = None
    if len(raw) == 8 and raw.isdigit():
        parsed = date(int(raw[:4]), int(raw[4:6]), int(raw[6:8]))
    elif len(raw) == 10:
        parsed = date.fromisoformat(raw)
    today = datetime.now(UTC).date()
    if parsed is None:
        parsed = today - timedelta(days=max(0, fallback_days))
    if clamp_today and parsed > today:
        parsed = today
    return parsed.isoformat()


def text_from_record(record: dict[str, Any], *keys: str) -> str | None:
    for key in keys:
        value = record.get(key)
        if value not in (None, ""):
            return str(value)
    return None


def decimal_from_record(record: dict[str, Any], *keys: str) -> Decimal | None:
    value = text_from_record(record, *keys)
    if value in (None, "", "-", "nan", "NaN"):
        return None
    try:
        return Decimal(value)
    except (InvalidOperation, ValueError):
        return None


def bool_from_record(record: dict[str, Any], *keys: str) -> bool | None:
    value = text_from_record(record, *keys)
    if value is None:
        return None
    normalized = value.strip().lower()
    if normalized in {"1", "true", "t", "yes", "y"}:
        return True
    if normalized in {"0", "false", "f", "no", "n"}:
        return False
    return None


def limit_threshold_for_code(code: str, is_st: bool | None) -> Decimal:
    if is_st:
        return Decimal("4.85")
    symbol = code.split(".", 1)[-1]
    if code.startswith("bj.") or symbol.startswith(("4", "8")):
        return Decimal("29.80")
    if symbol.startswith(("300", "301", "688")):
        return Decimal("19.80")
    return Decimal("9.80")


def is_a_share_stock_code(code: str) -> bool:
    symbol = code.split(".", 1)[-1]
    if code.startswith("sh."):
        return symbol.startswith(("600", "601", "603", "605", "688", "689"))
    if code.startswith("sz."):
        return symbol.startswith(("000", "001", "002", "003", "300", "301"))
    if code.startswith("bj."):
        return symbol.startswith(("4", "8", "920"))
    return False


def limit_marker_from_pct(
    *,
    code: str,
    change_percent: Decimal | None,
    is_st: bool | None,
) -> str | None:
    if change_percent is None:
        return None
    threshold = limit_threshold_for_code(code, is_st)
    if change_percent >= threshold:
        return "up"
    if change_percent <= -threshold:
        return "down"
    return None


def factor_values_from_record(record: dict[str, Any]) -> dict[str, str]:
    source_map = {
        "pe_ttm": "peTTM",
        "pb_mrq": "pbMRQ",
        "ps_ttm": "psTTM",
        "pcf_ncf_ttm": "pcfNcfTTM",
    }
    factors: dict[str, str] = {}
    for key, source_key in source_map.items():
        value = text_from_record(record, source_key)
        if value not in (None, "", "-"):
            factors[key] = value
    return factors


def baostock_volume_hands(record: dict[str, Any]) -> int | None:
    shares = decimal_from_record(record, "volume")
    if shares is None:
        return None
    hands = (shares / Decimal("100")).to_integral_value(rounding=ROUND_HALF_UP)
    return int(hands)


def normalize_record(record: dict[str, Any]) -> dict[str, str | None]:
    return {str(key): None if value is None else str(value) for key, value in record.items()}
