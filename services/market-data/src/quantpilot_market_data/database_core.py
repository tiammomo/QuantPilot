from __future__ import annotations

import json
import os
from datetime import UTC, date, datetime, time
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit
from zoneinfo import ZoneInfo

import psycopg

SHANGHAI_TZ = ZoneInfo("Asia/Shanghai")
ROOT_DIR = Path(__file__).resolve().parents[4]
SECTOR_HINT_LABELS = {
    "semiconductor": "半导体",
    "gaming": "游戏",
    "bank": "银行",
    "gold-retail": "黄金珠宝",
    "liquor": "白酒",
    "home-appliance": "家电",
    "battery": "电池",
    "new-energy-auto": "新能源汽车",
    "insurance": "保险",
    "utility": "公用事业",
    "solar": "光伏",
    "pharma": "医药",
    "display-panel": "面板",
    "security-equipment": "安防设备",
    "telecom": "通信服务",
    "oil-gas": "石油石化",
    "construction": "建筑工程",
    "petrochemical": "石油化工",
    "coal-chemical": "煤化工",
    "chemical": "化工",
    "soda-ash": "纯碱",
    "fiberglass": "玻璃纤维",
    "copper-clad-laminate": "覆铜板",
    "semiconductor-packaging": "先进封装",
    "electronic-ceramics": "电子陶瓷",
    "consumer-electronics": "消费电子",
    "industrial-metal": "工业金属",
    "rare-earth": "稀土永磁",
    "ai-chip": "AI芯片",
    "memory-chip": "存储芯片",
    "cpo": "CPO概念",
    "robotics": "机器人",
    "low-altitude-economy": "低空经济",
    "computing-power": "算力",
}


class DatabaseError(RuntimeError):
    """数据库不可用或量化表结构未初始化。"""


def load_local_env_if_needed() -> None:
    if os.getenv("DATABASE_URL"):
        return
    for env_file in (ROOT_DIR / ".env", ROOT_DIR / ".env.local"):
        if not env_file.exists():
            continue
        for line in env_file.read_text(encoding="utf-8").splitlines():
            stripped = line.strip()
            if not stripped or stripped.startswith("#") or "=" not in stripped:
                continue
            key, value = stripped.split("=", 1)
            key = key.strip()
            value = value.strip().strip('"').strip("'")
            # This helper exists only to locate the database. Loading every project
            # secret into the market-data process violates least privilege.
            if key == "DATABASE_URL":
                os.environ.setdefault(key, value)
                return


def database_url_from_env() -> str:
    load_local_env_if_needed()
    url = os.getenv("DATABASE_URL", "").strip()
    if not url:
        raise DatabaseError("DATABASE_URL 未配置，无法写入本地 TimescaleDB。")
    if not (url.startswith("postgresql://") or url.startswith("postgres://")):
        raise DatabaseError("DATABASE_URL 必须指向 PostgreSQL/TimescaleDB。")
    parsed = urlsplit(url)
    query = [
        (key, value)
        for key, value in parse_qsl(parsed.query, keep_blank_values=True)
        if key != "schema"
    ]
    return urlunsplit(
        (parsed.scheme, parsed.netloc, parsed.path, urlencode(query), parsed.fragment)
    )


async def connect() -> psycopg.AsyncConnection:
    try:
        return await psycopg.AsyncConnection.connect(database_url_from_env())
    except psycopg.OperationalError as error:
        raise DatabaseError(f"无法连接 TimescaleDB：{error}") from error


def normalize_fetch_symbol(symbol: str) -> str:
    value = symbol.strip()
    upper = value.upper()
    if len(upper) == 9 and upper[:6].isdigit() and upper[6] == "." and upper[7:] in {
        "SH",
        "SZ",
        "BJ",
    }:
        return upper[:6]
    return value


def canonical_symbol(code: str, market: str | None) -> str:
    clean_code = code.strip().upper()
    if len(clean_code) == 9 and clean_code[:6].isdigit() and clean_code[6] == ".":
        return clean_code
    if market in {"SH", "SZ", "BJ"} and clean_code.isdigit():
        return f"{clean_code}.{market}"
    return clean_code


def parse_bar_datetime(value: str) -> datetime:
    raw = value.strip()
    if not raw:
        raise ValueError("K 线日期为空")
    if len(raw) == 10:
        parsed_date = date.fromisoformat(raw)
        return datetime.combine(parsed_date, time.min, tzinfo=SHANGHAI_TZ).astimezone(UTC)
    normalized = raw.replace(" ", "T")
    parsed = datetime.fromisoformat(normalized)
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=SHANGHAI_TZ)
    return parsed.astimezone(UTC)


def trade_date_datetime(value: date | str) -> datetime:
    parsed_date = date.fromisoformat(value) if isinstance(value, str) else value
    return datetime.combine(parsed_date, time.min, tzinfo=SHANGHAI_TZ).astimezone(UTC)


def lookback_cutoff_datetime(years: int | None) -> datetime | None:
    if years is None or years <= 0:
        return None
    today = datetime.now(SHANGHAI_TZ).date()
    try:
        cutoff_date = today.replace(year=today.year - years)
    except ValueError:
        cutoff_date = today.replace(year=today.year - years, day=28)
    return datetime.combine(cutoff_date, time.min, tzinfo=SHANGHAI_TZ).astimezone(UTC)


def date_cutoff_datetime(value: str | None) -> datetime | None:
    raw = (value or "").strip()
    if not raw:
        return None
    if len(raw) == 8 and raw.isdigit():
        parsed_date = date(int(raw[:4]), int(raw[4:6]), int(raw[6:8]))
    else:
        parsed_date = date.fromisoformat(raw)
    return datetime.combine(parsed_date, time.min, tzinfo=SHANGHAI_TZ).astimezone(UTC)


def decimal_or_zero(value: Decimal | int | None) -> Decimal:
    if value is None:
        return Decimal("0")
    return value if isinstance(value, Decimal) else Decimal(str(value))


def decimal_or_none(value: Decimal | int | None) -> Decimal | None:
    if value is None:
        return None
    return value if isinstance(value, Decimal) else Decimal(str(value))


def decimal_subtract(
    left: Decimal | int | None,
    right: Decimal | int | None,
) -> Decimal | None:
    left_decimal = decimal_or_none(left)
    right_decimal = decimal_or_none(right)
    if left_decimal is None or right_decimal is None:
        return None
    return left_decimal - right_decimal


def amplitude_percent(
    high: Decimal | int | None,
    low: Decimal | int | None,
    previous_close: Decimal | int | None,
) -> Decimal | None:
    high_decimal = decimal_or_none(high)
    low_decimal = decimal_or_none(low)
    previous_decimal = decimal_or_none(previous_close)
    if high_decimal is None or low_decimal is None or previous_decimal in (None, Decimal("0")):
        return None
    return ((high_decimal - low_decimal) / previous_decimal) * Decimal("100")


def decimal_from_json(value: Any) -> Decimal | None:
    if value in (None, "", "-"):
        return None
    try:
        return Decimal(str(value))
    except (InvalidOperation, ValueError):
        return None


def bool_or_none(value: Any) -> bool | None:
    if isinstance(value, bool):
        return value
    if value is None:
        return None
    normalized = str(value).strip().lower()
    if normalized in {"1", "true", "t", "yes", "y"}:
        return True
    if normalized in {"0", "false", "f", "no", "n"}:
        return False
    return None


def json_array(value: Any) -> list[str]:
    if isinstance(value, list):
        return [str(item) for item in value]
    return []


def json_object(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


EMPTY_TEXT_VALUES = {"-", "--", "无", "暂无", "None", "none", "null", "NULL", "nan", "NaN"}


def clean_sector_value(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value).replace('\\"', '"').strip()
    while text and text[0] in {'[', '"', "'", "“", "‘"}:
        text = text[1:].strip()
    while text and text[-1] in {']', '"', "'", "”", "’"}:
        text = text[:-1].strip()
    text = SECTOR_HINT_LABELS.get(text, text)
    if not text or text in EMPTY_TEXT_VALUES:
        return None
    return text


def first_decimal(*values: Any) -> Decimal | None:
    for value in values:
        parsed = decimal_from_json(value)
        if parsed is not None:
            return parsed
    return None


def first_text(*values: Any) -> str | None:
    for value in values:
        if isinstance(value, str):
            text = value.strip()
            if text and text not in EMPTY_TEXT_VALUES:
                return text
        elif value is not None:
            text = str(value).strip()
            if text and text not in EMPTY_TEXT_VALUES:
                return text
    return None


def split_sector_values(value: Any) -> list[str]:
    values: list[str] = []
    seen: set[str] = set()

    def collect(item: Any) -> None:
        if isinstance(item, list):
            for entry in item:
                collect(entry)
            return
        if isinstance(item, str):
            text = item.strip()
            if not text:
                return
            if (text.startswith("[") and text.endswith("]")) or (
                text.startswith('"') and text.endswith('"')
            ):
                try:
                    parsed = json.loads(text)
                except json.JSONDecodeError:
                    parsed = None
                if parsed is not None and parsed != item:
                    collect(parsed)
                    return
            normalized = (
                text.replace("，", ",")
                .replace("、", ",")
                .replace("；", ",")
                .replace(";", ",")
                .replace("|", ",")
            )
            candidates = normalized.split(",")
        else:
            candidates = [item]

        for candidate in candidates:
            cleaned = clean_sector_value(candidate)
            if cleaned and cleaned not in seen:
                seen.add(cleaned)
                values.append(cleaned)

    collect(value)
    return values


def unique_non_empty(values: list[str | None]) -> list[str]:
    result: list[str] = []
    seen: set[str] = set()
    for value in values:
        if not value:
            continue
        text = clean_sector_value(value)
        if not text or text in seen:
            continue
        seen.add(text)
        result.append(text)
    return result


def security_sector_fields(metadata_value: Any) -> dict[str, Any]:
    metadata = json_object(metadata_value)
    raw = json_object(metadata.get("raw"))
    sector_hint = first_text(metadata.get("sector_hint"), raw.get("sector_hint"))
    sector_hint_label = SECTOR_HINT_LABELS.get(sector_hint or "", sector_hint)
    industry = first_text(metadata.get("industry"), raw.get("industry"), raw.get("f100"))
    region = first_text(metadata.get("region"), raw.get("region"), raw.get("f102"))
    concepts = unique_non_empty([
        *split_sector_values(metadata.get("concepts")),
        *split_sector_values(raw.get("concepts")),
        *split_sector_values(raw.get("f103")),
    ])
    sector_tags = unique_non_empty([industry, *concepts[:3], region, sector_hint_label])
    return {
        "industry": industry,
        "region": region,
        "concepts": concepts,
        "sector_hint": sector_hint,
        "sector_tags": sector_tags,
    }


def coverage_status(row_count: int | None, last_ts: datetime | None) -> str:
    if not row_count:
        return "missing"
    if last_ts is None:
        return "missing"
    return "ready"


def infer_market_from_symbol(symbol: str) -> str:
    upper = symbol.strip().upper()
    if upper.endswith(".SH"):
        return "SSE"
    if upper.endswith(".SZ"):
        return "SZSE"
    if upper.endswith(".BJ"):
        return "BSE"
    return "CN-A"


def percent_change(current: Decimal | None, base: Decimal | None) -> Decimal | None:
    if current is None or base is None or base == 0:
        return None
    return (current / base - Decimal("1")) * Decimal("100")


def decimal_ratio(current: Decimal | None, base: Decimal | None) -> Decimal | None:
    if current is None or base is None or base == 0:
        return None
    return current / base


def universe_trend_status(
    *,
    latest_close: Decimal | None,
    ma20: Decimal | None,
    ma60: Decimal | None,
    sample_count: int,
) -> str:
    if sample_count < 60 or latest_close is None or ma20 is None or ma60 is None:
        return "insufficient"
    if latest_close >= ma20 >= ma60:
        return "bullish"
    if latest_close <= ma20 <= ma60:
        return "bearish"
    return "sideways"
