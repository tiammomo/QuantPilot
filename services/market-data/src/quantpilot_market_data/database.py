from __future__ import annotations

import json
import os
from datetime import UTC, date, datetime, time, timedelta
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit
from zoneinfo import ZoneInfo

import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb

from quantpilot_market_data.cache import RedisJsonCache, ttl_from_env
from quantpilot_market_data.clickhouse import (
    ClickHouseError,
    initialize_clickhouse,
    insert_daily_bars,
    is_clickhouse_enabled,
    query_screener_feature_rows,
)
from quantpilot_market_data.models import (
    AShareScreenerCandidate,
    AShareScreenerResponse,
    ClickHouseSyncResponse,
    DataQualityIssue,
    DataQualityScanRequest,
    DataQualityScanResponse,
    FactorDefinition,
    FoundationComponentStatus,
    HistoryIngestionResponse,
    IngestionJobSummary,
    IngestionPreflightCoverage,
    KlineResponse,
    LocalKlineBar,
    LocalKlineResponse,
    LocalKlineSummary,
    MarketDataCoverageItem,
    RealtimeQuote,
    ResearchUniverse,
    ResearchUniverseMember,
    ResearchUniverseSummary,
    ScreenerMode,
    SectorCapitalFlowDetail,
    SectorCapitalFlowItem,
    SectorCapitalFlowMarketSummary,
    SectorCapitalFlowMember,
    SectorCapitalFlowTrendPoint,
    SymbolResolveResult,
    TradingCalendarDay,
)

SHANGHAI_TZ = ZoneInfo("Asia/Shanghai")
DEFAULT_UNIVERSE_ID = "a-share-sample-research-pool"
SECTOR_CAPITAL_FLOW_CACHE_TTL_SECONDS = 300
SCREENER_CACHE_TTL_SECONDS = ttl_from_env("QUANTPILOT_SCREENER_CACHE_TTL_SECONDS", 60)
INGESTION_JOB_STALE_SECONDS = 15 * 60
INGESTION_JOB_STOP_GRACE_SECONDS = 60
_SECTOR_CAPITAL_FLOW_CACHE: dict[tuple[str, int, str], tuple[datetime, dict[str, Any]]] = {}
_SECTOR_CAPITAL_FLOW_REDIS_CACHE = RedisJsonCache()
_SCREENER_CACHE: dict[tuple[str, str, str, int], tuple[datetime, AShareScreenerResponse]] = {}
_SCREENER_REDIS_CACHE = RedisJsonCache()
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
            if key:
                os.environ.setdefault(key, value)


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


def clean_sector_value(value: Any) -> str | None:
    text = str(value).replace('\\"', '"').strip()
    while text and text[0] in {'[', '"', "'", "“", "‘"}:
        text = text[1:].strip()
    while text and text[-1] in {']', '"', "'", "”", "’"}:
        text = text[:-1].strip()
    text = SECTOR_HINT_LABELS.get(text, text)
    if not text or text in {"-", "--", "无", "暂无"}:
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
            if text and text not in {"-", "--", "无", "暂无"}:
                return text
        elif value is not None:
            text = str(value).strip()
            if text and text not in {"-", "--", "无", "暂无"}:
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


def _coverage_missing_fields(
    coverage: IngestionPreflightCoverage,
    require_fields: list[str],
) -> tuple[bool, list[str]]:
    missing: list[str] = []
    if coverage.row_count <= 0 or coverage.rows_since_cutoff <= 0:
        return False, ["kline"]
    expected_rows = max(1, coverage.expected_rows_since_cutoff or 0)
    if coverage.benchmark_last_ts is not None and (
        coverage.last_ts is None or coverage.last_ts < coverage.benchmark_last_ts
    ):
        missing.append("latest_trade_date")
    if coverage.rows_since_cutoff < expected_rows:
        missing.append("kline")
    if coverage.rows_since_cutoff <= 0:
        missing.append("kline")
    if require_fields and coverage.complete_rows_since_cutoff < expected_rows:
        missing.extend(
            field
            for field in require_fields
            if field
            in {
                "amount",
                "turnover",
                "trade_status",
                "is_st",
                "limit_up",
                "limit_down",
            }
        )
    factor_count_by_key = {
        "pe_ttm": coverage.pe_ttm_count,
        "pb_mrq": coverage.pb_mrq_count,
        "ps_ttm": coverage.ps_ttm_count,
        "pcf_ncf_ttm": coverage.pcf_ncf_ttm_count,
    }
    for key, count in factor_count_by_key.items():
        if key in require_fields and count < expected_rows:
            missing.append(key)
    missing = list(dict.fromkeys(missing))
    return not missing, missing


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


def research_member_from_row(row: dict[str, Any]) -> ResearchUniverseMember:
    row_count = int(row["row_count"] or 0)
    sector_fields = security_sector_fields(row["security_metadata"])
    latest_close = decimal_or_none(row["latest_close"])
    previous_close = decimal_or_none(row["previous_close"])
    latest_change_percent = decimal_or_none(row.get("latest_change_percent"))
    close_20d = decimal_or_none(row["close_20d"])
    close_60d = decimal_or_none(row["close_60d"])
    ma20 = decimal_or_none(row["ma20"])
    ma60 = decimal_or_none(row["ma60"])
    sample_count = int(row["sample_count"] or 0)
    return ResearchUniverseMember(
        symbol=str(row["symbol"]),
        code=str(row["code"]),
        name=row["security_name"],
        industry=sector_fields["industry"],
        region=sector_fields["region"],
        concepts=sector_fields["concepts"],
        sector_hint=sector_fields["sector_hint"],
        sector_tags=sector_fields["sector_tags"],
        exchange=row["exchange"],
        asset_type=row["asset_type"],
        currency=row["currency"],
        timezone=row["timezone"],
        secid=row["secid"],
        provider=str(row["provider"] or "eastmoney"),
        security_status=str(row["security_status"] or "active"),
        role=str(row["role"] or "member"),
        weight=decimal_or_none(row["weight"]),
        row_count=row_count,
        first_ts=row["first_ts"],
        last_ts=row["last_ts"],
        data_provider=row["data_provider"],
        latest_close=latest_close,
        latest_change_pct=(
            latest_change_percent
            if latest_change_percent is not None
            else percent_change(latest_close, previous_close)
        ),
        latest_amount=decimal_or_none(row.get("latest_amount")),
        latest_turnover=decimal_or_none(row.get("latest_turnover")),
        strength_20d_pct=percent_change(latest_close, close_20d),
        strength_60d_pct=percent_change(latest_close, close_60d),
        ma20=ma20,
        ma60=ma60,
        trend_status=universe_trend_status(
            latest_close=latest_close,
            ma20=ma20,
            ma60=ma60,
            sample_count=sample_count,
        ),
        avg_amount_20d=decimal_or_none(row["avg_amount_20d"]),
        avg_volume_20d=decimal_or_none(row["avg_volume_20d"]),
        avg_turnover_20d=decimal_or_none(row.get("avg_turnover_20d")),
        trade_status=row.get("trade_status"),
        is_st=bool_or_none(row.get("is_st")),
        limit_up=bool_or_none(row.get("limit_up")),
        limit_down=bool_or_none(row.get("limit_down")),
        pe_ttm=decimal_or_none(row.get("pe_ttm")),
        pb_mrq=decimal_or_none(row.get("pb_mrq")),
        ps_ttm=decimal_or_none(row.get("ps_ttm")),
        pcf_ncf_ttm=decimal_or_none(row.get("pcf_ncf_ttm")),
        data_status=coverage_status(row_count, row["last_ts"]),
    )


async def get_universe_fetch_targets(universe_id: str) -> list[dict[str, str]]:
    async with await connect() as connection, connection.cursor(row_factory=dict_row) as cursor:
        await cursor.execute(
            """
                SELECT securities.symbol, securities.code, securities.secid, securities.asset_type
                FROM quant.security_universe_members members
                JOIN quant.securities securities
                  ON securities.symbol = members.symbol
                WHERE members.universe_id = %s
                ORDER BY
                  CASE
                    WHEN members.metadata->>'order' ~ '^[0-9]+$'
                    THEN (members.metadata->>'order')::INT
                  END NULLS LAST,
                  securities.symbol
                """,
            (universe_id,),
        )
        rows = await cursor.fetchall()
    return [
        {
            "symbol": str(row["symbol"]),
            "query": str(row["secid"] or row["code"] or row["symbol"]),
            "asset_type": str(row["asset_type"] or "stock"),
        }
        for row in rows
    ]


async def list_research_universes() -> list[ResearchUniverse]:
    async with await connect() as connection, connection.cursor(row_factory=dict_row) as cursor:
        await cursor.execute(
            """
                SELECT
                  universes.id,
                  universes.name,
                  universes.description,
                  universes.status,
                  universes.source,
                  universes.tags,
                  universes.metadata AS universe_metadata,
                  universes.created_at,
                  universes.updated_at,
                  securities.symbol,
                  securities.code,
                  securities.name AS security_name,
                  securities.exchange,
                  securities.asset_type,
                  securities.currency,
                  securities.timezone,
                  securities.secid,
                  securities.provider,
                  securities.metadata AS security_metadata,
                  securities.status AS security_status,
                  members.role,
                  members.weight,
                  sync_state.first_ts,
                  sync_state.last_ts,
                  sync_state.provider AS data_provider,
                  COALESCE(sync_state.row_count, 0) AS row_count,
                  market_metrics.sample_count,
                  market_metrics.latest_close,
                  market_metrics.previous_close,
                  market_metrics.latest_change_percent,
                  market_metrics.latest_amount,
                  market_metrics.latest_turnover,
                  market_metrics.close_20d,
                  market_metrics.close_60d,
                  market_metrics.ma20,
                  market_metrics.ma60,
                  market_metrics.avg_amount_20d,
                  market_metrics.avg_volume_20d,
                  market_metrics.avg_turnover_20d,
                  market_metrics.trade_status,
                  market_metrics.is_st,
                  market_metrics.limit_up,
                  market_metrics.limit_down,
                  factor_metrics.pe_ttm,
                  factor_metrics.pb_mrq,
                  factor_metrics.ps_ttm,
                  factor_metrics.pcf_ncf_ttm
                FROM quant.security_universes universes
                LEFT JOIN quant.security_universe_members members
                  ON members.universe_id = universes.id
                LEFT JOIN quant.securities securities
                  ON securities.symbol = members.symbol
                LEFT JOIN LATERAL (
                  SELECT sync_row.*
                  FROM quant.market_data_sync_state sync_row
                  WHERE sync_row.symbol = securities.symbol
                    AND sync_row.timeframe = COALESCE(
                      universes.metadata->>'default_timeframe',
                      'daily'
                    )
                    AND sync_row.adjustment = COALESCE(
                      universes.metadata->>'default_adjustment',
                      'qfq'
                    )
                  ORDER BY (
                    sync_row.provider = COALESCE(universes.metadata->>'provider', 'eastmoney')
                  ) DESC, sync_row.last_ts DESC NULLS LAST
                  LIMIT 1
                ) sync_state ON TRUE
                LEFT JOIN LATERAL (
                  SELECT
                    count(*)::INT AS sample_count,
                    (array_agg(recent.close ORDER BY recent.ts DESC))[1] AS latest_close,
                    (array_agg(recent.close ORDER BY recent.ts DESC))[2] AS previous_close,
                    (array_agg(recent.change_percent ORDER BY recent.ts DESC))[1]
                      AS latest_change_percent,
                    (array_agg(recent.amount ORDER BY recent.ts DESC))[1] AS latest_amount,
                    (array_agg(recent.turnover ORDER BY recent.ts DESC))[1] AS latest_turnover,
                    (array_agg(recent.close ORDER BY recent.ts DESC))[21] AS close_20d,
                    (array_agg(recent.close ORDER BY recent.ts DESC))[61] AS close_60d,
                    avg(recent.close) FILTER (WHERE recent.rn <= 20) AS ma20,
                    avg(recent.close) FILTER (WHERE recent.rn <= 60) AS ma60,
                    avg(recent.amount) FILTER (
                      WHERE recent.rn <= 20 AND recent.amount IS NOT NULL
                    ) AS avg_amount_20d,
                    avg(recent.volume) FILTER (WHERE recent.rn <= 20) AS avg_volume_20d,
                    avg(recent.turnover) FILTER (
                      WHERE recent.rn <= 20 AND recent.turnover IS NOT NULL
                    ) AS avg_turnover_20d,
                    (array_agg(recent.trade_status ORDER BY recent.ts DESC))[1] AS trade_status,
                    (array_agg(recent.is_st ORDER BY recent.ts DESC))[1] AS is_st,
                    (array_agg(recent.limit_up ORDER BY recent.ts DESC))[1] AS limit_up,
                    (array_agg(recent.limit_down ORDER BY recent.ts DESC))[1] AS limit_down
                  FROM (
                    SELECT
                      bars.ts,
                      bars.close,
                      bars.amount,
                      bars.volume,
                      bars.change_percent,
                      bars.turnover,
                      bars.trade_status,
                      bars.is_st,
                      bars.limit_up,
                      bars.limit_down,
                      row_number() OVER (ORDER BY bars.ts DESC) AS rn
                    FROM quant.stock_bars bars
                    WHERE bars.symbol = securities.symbol
                      AND bars.timeframe = COALESCE(
                        universes.metadata->>'default_timeframe',
                        'daily'
                      )
                      AND bars.adjustment = COALESCE(
                        universes.metadata->>'default_adjustment',
                        'qfq'
                      )
                    ORDER BY bars.ts DESC
                    LIMIT 61
                  ) recent
                ) market_metrics ON TRUE
                LEFT JOIN LATERAL (
                  SELECT
                    max(factor_value) FILTER (WHERE factor_key = 'pe_ttm') AS pe_ttm,
                    max(factor_value) FILTER (WHERE factor_key = 'pb_mrq') AS pb_mrq,
                    max(factor_value) FILTER (WHERE factor_key = 'ps_ttm') AS ps_ttm,
                    max(factor_value) FILTER (WHERE factor_key = 'pcf_ncf_ttm')
                      AS pcf_ncf_ttm
                  FROM (
                    SELECT DISTINCT ON (factor_key)
                      factor_key,
                      factor_value
                    FROM quant.stock_factors
                    WHERE symbol = securities.symbol
                    ORDER BY factor_key, ts DESC
                  ) latest_factors
                ) factor_metrics ON TRUE
                ORDER BY
                  CASE
                    WHEN universes.metadata->>'display_order' ~ '^[0-9]+$'
                    THEN (universes.metadata->>'display_order')::INT
                  END NULLS LAST,
                  universes.created_at,
                  CASE
                    WHEN members.metadata->>'order' ~ '^[0-9]+$'
                    THEN (members.metadata->>'order')::INT
                  END NULLS LAST,
                  securities.symbol
                """,
        )
        rows = await cursor.fetchall()

    universes: dict[str, ResearchUniverse] = {}
    for row in rows:
        universe_id = str(row["id"])
        metadata = json_object(row["universe_metadata"])
        if universe_id not in universes:
            universes[universe_id] = ResearchUniverse(
                id=universe_id,
                name=str(row["name"]),
                description=row["description"],
                status=str(row["status"]),
                source=str(row["source"]),
                tags=json_array(row["tags"]),
                default_timeframe=metadata.get("default_timeframe") or "daily",
                default_adjustment=metadata.get("default_adjustment") or "qfq",
                provider=metadata.get("provider") or "eastmoney",
                created_at=row["created_at"],
                updated_at=row["updated_at"],
            )
        if row["symbol"]:
            universes[universe_id].members.append(research_member_from_row(row))

    for universe in universes.values():
        universe.member_count = len(universe.members)
        universe.stock_count = sum(
            1 for member in universe.members if member.asset_type == "stock"
        )
        universe.etf_count = sum(1 for member in universe.members if member.asset_type == "etf")
        universe.index_count = sum(
            1 for member in universe.members if member.asset_type == "index"
        )
        universe.fund_count = sum(
            1 for member in universe.members if member.asset_type == "fund"
        )
        universe.ready_count = sum(
            1 for member in universe.members if member.data_status == "ready"
        )
        universe.bar_count = sum(member.row_count for member in universe.members)
        universe.latest_ts = max(
            (member.last_ts for member in universe.members if member.last_ts),
            default=None,
        )
    return list(universes.values())


async def list_research_universe_summaries() -> list[ResearchUniverseSummary]:
    async with await connect() as connection, connection.cursor(row_factory=dict_row) as cursor:
        await cursor.execute(
            """
                SELECT
                  universes.id,
                  universes.name,
                  universes.description,
                  universes.status,
                  universes.source,
                  universes.tags,
                  universes.metadata AS universe_metadata,
                  universes.created_at,
                  universes.updated_at,
                  count(members.symbol)::INT AS member_count,
                  count(*) FILTER (WHERE securities.asset_type = 'stock')::INT AS stock_count,
                  count(*) FILTER (WHERE securities.asset_type = 'etf')::INT AS etf_count,
                  count(*) FILTER (WHERE securities.asset_type = 'index')::INT AS index_count,
                  count(*) FILTER (WHERE securities.asset_type = 'fund')::INT AS fund_count,
                  count(*) FILTER (
                    WHERE COALESCE(sync_state.row_count, 0) > 0
                      AND sync_state.last_ts IS NOT NULL
                  )::INT AS ready_count,
                  COALESCE(sum(sync_state.row_count), 0)::BIGINT AS bar_count,
                  max(sync_state.last_ts) AS latest_ts
                FROM quant.security_universes universes
                LEFT JOIN quant.security_universe_members members
                  ON members.universe_id = universes.id
                LEFT JOIN quant.securities securities
                  ON securities.symbol = members.symbol
                LEFT JOIN LATERAL (
                  SELECT sync_row.*
                  FROM quant.market_data_sync_state sync_row
                  WHERE sync_row.symbol = securities.symbol
                    AND sync_row.timeframe = COALESCE(
                      universes.metadata->>'default_timeframe',
                      'daily'
                    )
                    AND sync_row.adjustment = COALESCE(
                      universes.metadata->>'default_adjustment',
                      'qfq'
                    )
                  ORDER BY (
                    sync_row.provider = COALESCE(universes.metadata->>'provider', 'eastmoney')
                  ) DESC, sync_row.last_ts DESC NULLS LAST
                  LIMIT 1
                ) sync_state ON TRUE
                GROUP BY
                  universes.id,
                  universes.name,
                  universes.description,
                  universes.status,
                  universes.source,
                  universes.tags,
                  universes.metadata,
                  universes.created_at,
                  universes.updated_at
                ORDER BY
                  CASE
                    WHEN universes.metadata->>'display_order' ~ '^[0-9]+$'
                    THEN (universes.metadata->>'display_order')::INT
                  END NULLS LAST,
                  universes.created_at
                """,
        )
        rows = await cursor.fetchall()

    summaries: list[ResearchUniverseSummary] = []
    for row in rows:
        metadata = json_object(row["universe_metadata"])
        summaries.append(
            ResearchUniverseSummary(
                id=str(row["id"]),
                name=str(row["name"]),
                description=row["description"],
                status=str(row["status"]),
                source=str(row["source"]),
                tags=json_array(row["tags"]),
                default_timeframe=metadata.get("default_timeframe") or "daily",
                default_adjustment=metadata.get("default_adjustment") or "qfq",
                provider=metadata.get("provider") or "eastmoney",
                member_count=int(row["member_count"] or 0),
                stock_count=int(row["stock_count"] or 0),
                etf_count=int(row["etf_count"] or 0),
                index_count=int(row["index_count"] or 0),
                fund_count=int(row["fund_count"] or 0),
                ready_count=int(row["ready_count"] or 0),
                bar_count=int(row["bar_count"] or 0),
                latest_ts=row["latest_ts"],
                created_at=row["created_at"],
                updated_at=row["updated_at"],
            )
        )
    return summaries


async def list_research_universe_members_page(
    *,
    universe_id: str,
    page: int = 1,
    page_size: int = 10,
    keyword: str | None = None,
) -> tuple[list[ResearchUniverseMember], int, int, int]:
    clean_keyword = (keyword or "").strip()
    keyword_pattern = f"%{clean_keyword}%"
    page_size = max(1, min(page_size, 100))

    filter_params = (
        universe_id,
        clean_keyword,
        keyword_pattern,
        keyword_pattern,
        keyword_pattern,
        keyword_pattern,
        keyword_pattern,
        keyword_pattern,
    )
    filter_sql = """
        members.universe_id = %s
        AND (
          %s = ''
          OR securities.symbol ILIKE %s
          OR securities.code ILIKE %s
          OR securities.name ILIKE %s
          OR securities.exchange ILIKE %s
          OR securities.asset_type ILIKE %s
          OR COALESCE(securities.metadata::TEXT, '') ILIKE %s
        )
    """

    async with await connect() as connection, connection.cursor(row_factory=dict_row) as cursor:
        await cursor.execute(
            f"""
                SELECT count(*)::INT AS total
                FROM quant.security_universe_members members
                JOIN quant.securities securities
                  ON securities.symbol = members.symbol
                WHERE {filter_sql}
                """,
            filter_params,
        )
        total_row = await cursor.fetchone()
        total = int(total_row["total"] or 0) if total_row else 0
        total_pages = max(1, (total + page_size - 1) // page_size)
        current_page = min(max(1, page), total_pages)
        offset = (current_page - 1) * page_size

        await cursor.execute(
            f"""
                WITH filtered_members AS (
                  SELECT
                    universes.metadata AS universe_metadata,
                    securities.symbol,
                    securities.code,
                    securities.name AS security_name,
                    securities.exchange,
                    securities.asset_type,
                    securities.currency,
                    securities.timezone,
                    securities.secid,
                    securities.provider,
                    securities.metadata AS security_metadata,
                    securities.status AS security_status,
                    members.role,
                    members.weight,
                    CASE
                      WHEN members.metadata->>'order' ~ '^[0-9]+$'
                      THEN (members.metadata->>'order')::INT
                    END AS member_order
                  FROM quant.security_universe_members members
                  JOIN quant.security_universes universes
                    ON universes.id = members.universe_id
                  JOIN quant.securities securities
                    ON securities.symbol = members.symbol
                  WHERE {filter_sql}
                  ORDER BY member_order NULLS LAST, securities.symbol
                  LIMIT %s OFFSET %s
                )
                SELECT
                  filtered_members.symbol,
                  filtered_members.code,
                  filtered_members.security_name,
                  filtered_members.exchange,
                  filtered_members.asset_type,
                  filtered_members.currency,
                  filtered_members.timezone,
                  filtered_members.secid,
                  filtered_members.provider,
                  filtered_members.security_metadata,
                  filtered_members.security_status,
                  filtered_members.role,
                  filtered_members.weight,
                  sync_state.first_ts,
                  sync_state.last_ts,
                  sync_state.provider AS data_provider,
                  COALESCE(sync_state.row_count, 0) AS row_count,
                  market_metrics.sample_count,
                  market_metrics.latest_close,
                  market_metrics.previous_close,
                  market_metrics.latest_change_percent,
                  market_metrics.latest_amount,
                  market_metrics.latest_turnover,
                  market_metrics.close_20d,
                  market_metrics.close_60d,
                  market_metrics.ma20,
                  market_metrics.ma60,
                  market_metrics.avg_amount_20d,
                  market_metrics.avg_volume_20d,
                  market_metrics.avg_turnover_20d,
                  market_metrics.trade_status,
                  market_metrics.is_st,
                  market_metrics.limit_up,
                  market_metrics.limit_down,
                  factor_metrics.pe_ttm,
                  factor_metrics.pb_mrq,
                  factor_metrics.ps_ttm,
                  factor_metrics.pcf_ncf_ttm
                FROM filtered_members
                LEFT JOIN LATERAL (
                  SELECT sync_row.*
                  FROM quant.market_data_sync_state sync_row
                  WHERE sync_row.symbol = filtered_members.symbol
                    AND sync_row.timeframe = COALESCE(
                      filtered_members.universe_metadata->>'default_timeframe',
                      'daily'
                    )
                    AND sync_row.adjustment = COALESCE(
                      filtered_members.universe_metadata->>'default_adjustment',
                      'qfq'
                    )
                  ORDER BY (
                    sync_row.provider = COALESCE(
                      filtered_members.universe_metadata->>'provider',
                      'eastmoney'
                    )
                  ) DESC, sync_row.last_ts DESC NULLS LAST
                  LIMIT 1
                ) sync_state ON TRUE
                LEFT JOIN LATERAL (
                  SELECT
                    count(*)::INT AS sample_count,
                    (array_agg(recent.close ORDER BY recent.ts DESC))[1] AS latest_close,
                    (array_agg(recent.close ORDER BY recent.ts DESC))[2] AS previous_close,
                    (array_agg(recent.change_percent ORDER BY recent.ts DESC))[1]
                      AS latest_change_percent,
                    (array_agg(recent.amount ORDER BY recent.ts DESC))[1] AS latest_amount,
                    (array_agg(recent.turnover ORDER BY recent.ts DESC))[1] AS latest_turnover,
                    (array_agg(recent.close ORDER BY recent.ts DESC))[21] AS close_20d,
                    (array_agg(recent.close ORDER BY recent.ts DESC))[61] AS close_60d,
                    avg(recent.close) FILTER (WHERE recent.rn <= 20) AS ma20,
                    avg(recent.close) FILTER (WHERE recent.rn <= 60) AS ma60,
                    avg(recent.amount) FILTER (
                      WHERE recent.rn <= 20 AND recent.amount IS NOT NULL
                    ) AS avg_amount_20d,
                    avg(recent.volume) FILTER (WHERE recent.rn <= 20) AS avg_volume_20d,
                    avg(recent.turnover) FILTER (
                      WHERE recent.rn <= 20 AND recent.turnover IS NOT NULL
                    ) AS avg_turnover_20d,
                    (array_agg(recent.trade_status ORDER BY recent.ts DESC))[1] AS trade_status,
                    (array_agg(recent.is_st ORDER BY recent.ts DESC))[1] AS is_st,
                    (array_agg(recent.limit_up ORDER BY recent.ts DESC))[1] AS limit_up,
                    (array_agg(recent.limit_down ORDER BY recent.ts DESC))[1] AS limit_down
                  FROM (
                    SELECT
                      bars.ts,
                      bars.close,
                      bars.amount,
                      bars.volume,
                      bars.change_percent,
                      bars.turnover,
                      bars.trade_status,
                      bars.is_st,
                      bars.limit_up,
                      bars.limit_down,
                      row_number() OVER (ORDER BY bars.ts DESC) AS rn
                    FROM quant.stock_bars bars
                    WHERE bars.symbol = filtered_members.symbol
                      AND bars.timeframe = COALESCE(
                        filtered_members.universe_metadata->>'default_timeframe',
                        'daily'
                      )
                      AND bars.adjustment = COALESCE(
                        filtered_members.universe_metadata->>'default_adjustment',
                        'qfq'
                      )
                    ORDER BY bars.ts DESC
                    LIMIT 61
                  ) recent
                ) market_metrics ON TRUE
                LEFT JOIN LATERAL (
                  SELECT
                    max(factor_value) FILTER (WHERE factor_key = 'pe_ttm') AS pe_ttm,
                    max(factor_value) FILTER (WHERE factor_key = 'pb_mrq') AS pb_mrq,
                    max(factor_value) FILTER (WHERE factor_key = 'ps_ttm') AS ps_ttm,
                    max(factor_value) FILTER (WHERE factor_key = 'pcf_ncf_ttm')
                      AS pcf_ncf_ttm
                  FROM (
                    SELECT DISTINCT ON (factor_key)
                      factor_key,
                      factor_value
                    FROM quant.stock_factors
                    WHERE symbol = filtered_members.symbol
                    ORDER BY factor_key, ts DESC
                  ) latest_factors
                ) factor_metrics ON TRUE
                ORDER BY filtered_members.member_order NULLS LAST, filtered_members.symbol
                """,
            (*filter_params, page_size, offset),
        )
        rows = await cursor.fetchall()

    return [research_member_from_row(row) for row in rows], total, current_page, total_pages


def sector_signal(
    *,
    covered_count: int,
    rising_ratio: Decimal | None,
    strength_20d_pct: Decimal | None,
    amount_ratio_20d: Decimal | None,
    proxy_net_amount: Decimal | None,
) -> str:
    if covered_count < 3:
        return "insufficient"
    if (
        proxy_net_amount is not None
        and proxy_net_amount > 0
        and rising_ratio is not None
        and rising_ratio >= Decimal("55")
        and (strength_20d_pct or Decimal("0")) > 0
        and (amount_ratio_20d or Decimal("1")) >= Decimal("1")
    ):
        return "warming"
    if (
        proxy_net_amount is not None
        and proxy_net_amount < 0
        and rising_ratio is not None
        and rising_ratio <= Decimal("45")
        and (strength_20d_pct or Decimal("0")) < 0
    ):
        return "cooling"
    return "neutral"


def _sector_cache_get(key: tuple[str, int, str]) -> dict[str, Any] | None:
    cached = _SECTOR_CAPITAL_FLOW_CACHE.get(key)
    if not cached:
        return None
    cached_at, value = cached
    if datetime.now(UTC) - cached_at > timedelta(seconds=SECTOR_CAPITAL_FLOW_CACHE_TTL_SECONDS):
        _SECTOR_CAPITAL_FLOW_CACHE.pop(key, None)
        return None
    return value


def _sector_cache_set(key: tuple[str, int, str], value: dict[str, Any]) -> None:
    _SECTOR_CAPITAL_FLOW_CACHE[key] = (datetime.now(UTC), value)
    if len(_SECTOR_CAPITAL_FLOW_CACHE) > 32:
        oldest_key = min(_SECTOR_CAPITAL_FLOW_CACHE.items(), key=lambda item: item[1][0])[0]
        _SECTOR_CAPITAL_FLOW_CACHE.pop(oldest_key, None)


def _sector_redis_key(key: tuple[str, int, str]) -> str:
    return _SECTOR_CAPITAL_FLOW_REDIS_CACHE.key(":".join(str(part) for part in key))


def _sector_restore_summary_payload(payload: dict[str, Any]) -> dict[str, Any]:
    restored = dict(payload)
    if isinstance(restored.get("items"), list):
        restored["items"] = [
            SectorCapitalFlowItem.model_validate(item)
            for item in restored["items"]
        ]
    if isinstance(restored.get("_items_all"), list):
        restored["_items_all"] = [
            SectorCapitalFlowItem.model_validate(item)
            for item in restored["_items_all"]
        ]
    if isinstance(restored.get("market_summary"), dict):
        restored["market_summary"] = SectorCapitalFlowMarketSummary.model_validate(
            restored["market_summary"]
        )
    if isinstance(restored.get("detail"), dict):
        restored["detail"] = SectorCapitalFlowDetail.model_validate(restored["detail"])
    return restored


def _sector_redis_payload(value: dict[str, Any], *, include_source_rows: bool) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "items": [
            item.model_dump(mode="json") if isinstance(item, SectorCapitalFlowItem) else item
            for item in value.get("items", [])
        ],
        "_items_all": [
            item.model_dump(mode="json") if isinstance(item, SectorCapitalFlowItem) else item
            for item in value.get("_items_all", [])
        ],
        "market_summary": (
            value["market_summary"].model_dump(mode="json")
            if isinstance(value.get("market_summary"), SectorCapitalFlowMarketSummary)
            else value.get("market_summary")
        ),
        "detail": (
            value["detail"].model_dump(mode="json")
            if isinstance(value.get("detail"), SectorCapitalFlowDetail)
            else value.get("detail")
        ),
        "cache_status": value.get("cache_status", "miss"),
        "cache_ttl_seconds": value.get("cache_ttl_seconds"),
    }
    if include_source_rows:
        payload["_source_rows"] = value.get("_source_rows", [])
    return payload


async def _sector_redis_get(key: tuple[str, int, str]) -> dict[str, Any] | None:
    payload = await _SECTOR_CAPITAL_FLOW_REDIS_CACHE.read(_sector_redis_key(key))
    if payload is None:
        return None
    try:
        return _sector_restore_summary_payload(payload)
    except (TypeError, ValueError):
        return None


async def _sector_redis_set(
    key: tuple[str, int, str],
    value: dict[str, Any],
    *,
    include_source_rows: bool = False,
) -> None:
    await _SECTOR_CAPITAL_FLOW_REDIS_CACHE.write(
        _sector_redis_key(key),
        ttl_seconds=SECTOR_CAPITAL_FLOW_CACHE_TTL_SECONDS,
        payload=_sector_redis_payload(value, include_source_rows=include_source_rows),
    )


def _sector_market_analysis(summary: SectorCapitalFlowMarketSummary) -> list[str]:
    analysis: list[str] = []
    if summary.proxy_net_amount is not None:
        direction = (
            "偏流入"
            if summary.proxy_net_amount > 0
            else "偏流出"
            if summary.proxy_net_amount < 0
            else "均衡"
        )
        analysis.append(f"全市场方向成交额代理{direction}，当前值 {summary.proxy_net_amount:.0f}。")
    if summary.rising_ratio is not None:
        analysis.append(
            f"覆盖样本上涨占比约 {summary.rising_ratio:.1f}%，"
            "可用于判断资金扩散还是局部抱团。"
        )
    if summary.warming_count or summary.cooling_count:
        analysis.append(
            f"升温板块 {summary.warming_count} 个，"
            f"转冷板块 {summary.cooling_count} 个。"
        )
    if summary.strongest_sectors:
        analysis.append(f"强势方向集中在：{'、'.join(summary.strongest_sectors[:5])}。")
    return analysis


def _sector_detail_analysis(item: SectorCapitalFlowItem) -> list[str]:
    analysis: list[str] = []
    if item.proxy_net_amount is not None:
        direction = (
            "净流入代理为正"
            if item.proxy_net_amount > 0
            else "净流入代理为负"
            if item.proxy_net_amount < 0
            else "方向暂均衡"
        )
        analysis.append(f"{item.sector} {direction}，结合成交额和上涨占比观察资金连续性。")
    if item.rising_ratio is not None:
        analysis.append(
            f"板块内上涨占比 {item.rising_ratio:.1f}%，"
            f"覆盖 {item.covered_count}/{item.member_count} 只。"
        )
    if item.amount_ratio_20d is not None:
        analysis.append(f"最新成交额约为 20 日均额的 {item.amount_ratio_20d:.2f} 倍。")
    if item.strength_20d_pct is not None:
        analysis.append(f"20 日强弱 {item.strength_20d_pct:.2f}%，用于判断趋势是否与资金热度共振。")
    return analysis


def directional_amount(amount: Decimal | None, change_percent: Decimal | None) -> Decimal | None:
    if amount is None:
        return None
    if change_percent is None:
        return Decimal("0")
    if change_percent > 0:
        return amount
    if change_percent < 0:
        return -amount
    return Decimal("0")


def _build_sector_market_summary(
    items: list[SectorCapitalFlowItem],
    source_rows: list[dict[str, Any]],
) -> SectorCapitalFlowMarketSummary:
    total_latest_amount = Decimal("0")
    total_proxy_net_amount = Decimal("0")
    total_covered = 0
    total_rising = 0
    weighted_amount_base = Decimal("0")
    turnover_values: list[Decimal] = []
    seen_symbols: set[str] = set()
    for row in source_rows:
        symbol = str(row["symbol"])
        if symbol in seen_symbols:
            continue
        seen_symbols.add(symbol)
        latest_amount = decimal_or_none(row["latest_amount"])
        avg_amount_20d = decimal_or_none(row["avg_amount_20d"])
        latest_change_percent = decimal_or_none(row["latest_change_percent"])
        avg_turnover_20d = decimal_or_none(row["avg_turnover_20d"])
        if row["sample_count"]:
            total_covered += 1
        if latest_change_percent is not None and latest_change_percent > 0:
            total_rising += 1
        if latest_amount is not None:
            total_latest_amount += latest_amount
            directional = directional_amount(latest_amount, latest_change_percent)
            if directional is not None:
                total_proxy_net_amount += directional
        if avg_amount_20d is not None:
            weighted_amount_base += avg_amount_20d
        if avg_turnover_20d is not None:
            turnover_values.append(avg_turnover_20d)
    signal_counts = {
        "warming": sum(1 for item in items if item.signal == "warming"),
        "cooling": sum(1 for item in items if item.signal == "cooling"),
        "neutral": sum(1 for item in items if item.signal == "neutral"),
        "insufficient": sum(1 for item in items if item.signal == "insufficient"),
    }
    strongest = sorted(
        [item for item in items if item.strength_20d_pct is not None],
        key=lambda item: item.strength_20d_pct or Decimal("-999"),
        reverse=True,
    )[:5]
    weakest = sorted(
        [item for item in items if item.strength_20d_pct is not None],
        key=lambda item: item.strength_20d_pct or Decimal("999"),
    )[:5]
    summary = SectorCapitalFlowMarketSummary(
        sector_count=len(items),
        warming_count=signal_counts["warming"],
        cooling_count=signal_counts["cooling"],
        neutral_count=signal_counts["neutral"],
        insufficient_count=signal_counts["insufficient"],
        covered_symbol_count=total_covered,
        total_latest_amount=total_latest_amount if total_latest_amount else None,
        proxy_net_amount=total_proxy_net_amount if total_latest_amount else None,
        rising_ratio=(
            Decimal(total_rising) / Decimal(total_covered) * Decimal("100")
            if total_covered
            else None
        ),
        amount_ratio_20d=(
            total_latest_amount / weighted_amount_base
            if weighted_amount_base
            else None
        ),
        avg_turnover_20d=(
            sum(turnover_values) / Decimal(len(turnover_values))
            if turnover_values
            else None
        ),
        strongest_sectors=[item.sector for item in strongest],
        weakest_sectors=[item.sector for item in weakest],
    )
    summary.analysis = _sector_market_analysis(summary)
    return summary


async def list_sector_capital_flow(
    *,
    universe_id: str = DEFAULT_UNIVERSE_ID,
    limit: int = 40,
    sector: str | None = None,
    detail_days: int = 20,
) -> dict[str, Any]:
    normalized_limit = max(1, min(limit, 120))
    normalized_sector = (sector or "").strip()
    normalized_detail_days = max(5, min(detail_days, 60))
    summary_cache_key = (universe_id, normalized_limit, "sector-summary-v3")
    detail_cache_key = (
        universe_id,
        normalized_limit,
        f"sector-detail:{normalized_sector}:{normalized_detail_days}:v3",
    )
    if normalized_sector:
        cached_detail = _sector_cache_get(detail_cache_key)
        if cached_detail is not None:
            return {
                **cached_detail,
                "cache_status": "hit",
                "cache_ttl_seconds": SECTOR_CAPITAL_FLOW_CACHE_TTL_SECONDS,
            }
        cached_detail = await _sector_redis_get(detail_cache_key)
        if cached_detail is not None:
            _sector_cache_set(detail_cache_key, {**cached_detail, "cache_status": "hit"})
            return {
                **cached_detail,
                "cache_status": "redis-hit",
                "cache_ttl_seconds": SECTOR_CAPITAL_FLOW_CACHE_TTL_SECONDS,
            }
        cached_summary = _sector_cache_get(summary_cache_key)
        if cached_summary is None:
            cached_summary = await _sector_redis_get(summary_cache_key)
            if cached_summary is not None:
                _sector_cache_set(summary_cache_key, {**cached_summary, "cache_status": "hit"})
        source_rows = cached_summary.get("_source_rows") if cached_summary else None
        summary_items = cached_summary.get("_items_all") if cached_summary else None
        if isinstance(source_rows, list) and isinstance(summary_items, list):
            detail = await build_sector_capital_flow_detail(
                universe_id=universe_id,
                sector=normalized_sector,
                detail_days=normalized_detail_days,
                summary_items=summary_items,
                source_rows=source_rows,
            )
            result = {
                **cached_summary,
                "detail": detail,
                "cache_status": cached_summary.get("cache_status", "hit"),
                "cache_ttl_seconds": SECTOR_CAPITAL_FLOW_CACHE_TTL_SECONDS,
            }
            _sector_cache_set(detail_cache_key, result)
            await _sector_redis_set(detail_cache_key, result)
            return result
    else:
        cached_summary = _sector_cache_get(summary_cache_key)
        if cached_summary is not None:
            return {
                **cached_summary,
                "cache_status": "hit",
                "cache_ttl_seconds": SECTOR_CAPITAL_FLOW_CACHE_TTL_SECONDS,
            }
        cached_summary = await _sector_redis_get(summary_cache_key)
        if cached_summary is not None:
            _sector_cache_set(summary_cache_key, {**cached_summary, "cache_status": "hit"})
            return {
                **cached_summary,
                "cache_status": "redis-hit",
                "cache_ttl_seconds": SECTOR_CAPITAL_FLOW_CACHE_TTL_SECONDS,
            }

    async with await connect() as connection, connection.cursor(row_factory=dict_row) as cursor:
        await cursor.execute(
            """
            WITH universe_config AS (
              SELECT
                id,
                COALESCE(metadata->>'default_timeframe', 'daily') AS timeframe,
                COALESCE(metadata->>'default_adjustment', 'qfq') AS adjustment
              FROM quant.security_universes
              WHERE id = %s
            ),
            universe_members AS (
              SELECT
                securities.symbol,
                securities.name,
                securities.metadata AS security_metadata,
                universe_config.timeframe,
                universe_config.adjustment
              FROM quant.security_universe_members members
              JOIN universe_config
                ON universe_config.id = members.universe_id
              JOIN quant.securities securities
                ON securities.symbol = members.symbol
              WHERE members.universe_id = %s
                AND securities.asset_type = 'stock'
            )
            SELECT
              universe_members.symbol,
              universe_members.name,
              universe_members.security_metadata,
              metrics.sample_count,
              metrics.latest_close,
              metrics.close_20d,
              metrics.latest_change_percent,
              metrics.latest_amount,
              metrics.latest_turnover,
              metrics.latest_limit_up,
              metrics.latest_limit_down,
              metrics.avg_amount_20d,
              metrics.avg_turnover_20d
            FROM universe_members
            LEFT JOIN LATERAL (
              SELECT
                count(*)::INT AS sample_count,
                (array_agg(recent.close ORDER BY recent.ts DESC))[1] AS latest_close,
                (array_agg(recent.close ORDER BY recent.ts DESC))[21] AS close_20d,
                (array_agg(recent.change_percent ORDER BY recent.ts DESC))[1]
                  AS latest_change_percent,
                (array_agg(recent.amount ORDER BY recent.ts DESC))[1] AS latest_amount,
                (array_agg(recent.turnover ORDER BY recent.ts DESC))[1] AS latest_turnover,
                (array_agg(recent.limit_up ORDER BY recent.ts DESC))[1] AS latest_limit_up,
                (array_agg(recent.limit_down ORDER BY recent.ts DESC))[1] AS latest_limit_down,
                avg(recent.amount) FILTER (
                  WHERE recent.rn <= 20 AND recent.amount IS NOT NULL
                ) AS avg_amount_20d,
                avg(recent.turnover) FILTER (
                  WHERE recent.rn <= 20 AND recent.turnover IS NOT NULL
                ) AS avg_turnover_20d
              FROM (
                SELECT
                  bars.ts,
                  bars.close,
                  bars.amount,
                  bars.turnover,
                  bars.change_percent,
                  bars.limit_up,
                  bars.limit_down,
                  row_number() OVER (ORDER BY bars.ts DESC) AS rn
                FROM quant.stock_bars bars
                WHERE bars.symbol = universe_members.symbol
                  AND bars.timeframe = universe_members.timeframe
                  AND bars.adjustment = universe_members.adjustment
                ORDER BY bars.ts DESC
                LIMIT 21
              ) recent
            ) metrics ON TRUE
            """,
            (universe_id, universe_id),
        )
        rows = await cursor.fetchall()

    groups: dict[str, dict[str, Any]] = {}
    for row in rows:
        sector_fields = security_sector_fields(row["security_metadata"])
        sector_tags = sector_fields["sector_tags"] or [sector_fields["industry"] or "未分组"]
        latest_amount = decimal_or_none(row["latest_amount"])
        avg_amount_20d = decimal_or_none(row["avg_amount_20d"])
        latest_change_percent = decimal_or_none(row["latest_change_percent"])
        strength_20d = percent_change(
            decimal_or_none(row["latest_close"]),
            decimal_or_none(row["close_20d"]),
        )
        avg_turnover_20d = decimal_or_none(row["avg_turnover_20d"])
        limit_up = bool_or_none(row["latest_limit_up"]) is True

        for sector in sector_tags:
            group = groups.setdefault(
                str(sector),
                {
                    "member_count": 0,
                    "covered_count": 0,
                    "rising_count": 0,
                    "falling_count": 0,
                    "limit_up_count": 0,
                    "limit_down_count": 0,
                    "latest_amount": Decimal("0"),
                    "avg_amount_20d": Decimal("0"),
                    "avg_turnover_sum": Decimal("0"),
                    "avg_turnover_count": 0,
                    "strength_sum": Decimal("0"),
                    "strength_count": 0,
                    "proxy_net_amount": Decimal("0"),
                    "top_symbols": [],
                },
            )
            group["member_count"] += 1
            if row["sample_count"]:
                group["covered_count"] += 1
            if latest_change_percent is not None and latest_change_percent > 0:
                group["rising_count"] += 1
            if latest_change_percent is not None and latest_change_percent < 0:
                group["falling_count"] += 1
            if limit_up:
                group["limit_up_count"] += 1
            if bool_or_none(row["latest_limit_down"]) is True:
                group["limit_down_count"] += 1
            if latest_amount is not None:
                group["latest_amount"] += latest_amount
                if latest_change_percent is not None:
                    if latest_change_percent > 0:
                        group["proxy_net_amount"] += latest_amount
                    elif latest_change_percent < 0:
                        group["proxy_net_amount"] -= latest_amount
            if avg_amount_20d is not None:
                group["avg_amount_20d"] += avg_amount_20d
            if avg_turnover_20d is not None:
                group["avg_turnover_sum"] += avg_turnover_20d
                group["avg_turnover_count"] += 1
            if strength_20d is not None:
                group["strength_sum"] += strength_20d
                group["strength_count"] += 1
            top_symbols = group["top_symbols"]
            if len(top_symbols) < 8:
                symbol_label = f"{row['name'] or row['symbol']} {row['symbol']}"
                if symbol_label not in top_symbols:
                    top_symbols.append(symbol_label)

    items: list[SectorCapitalFlowItem] = []
    for sector, group in groups.items():
        covered_count = int(group["covered_count"])
        rising_ratio = (
            Decimal(group["rising_count"]) / Decimal(covered_count) * Decimal("100")
            if covered_count
            else None
        )
        amount_ratio_20d = (
            group["latest_amount"] / group["avg_amount_20d"]
            if group["avg_amount_20d"]
            else None
        )
        avg_turnover = (
            group["avg_turnover_sum"] / Decimal(group["avg_turnover_count"])
            if group["avg_turnover_count"]
            else None
        )
        strength_20d_pct = (
            group["strength_sum"] / Decimal(group["strength_count"])
            if group["strength_count"]
            else None
        )
        proxy_net_amount = group["proxy_net_amount"] if group["latest_amount"] else None
        items.append(
            SectorCapitalFlowItem(
                sector=sector,
                member_count=int(group["member_count"]),
                covered_count=covered_count,
                rising_count=int(group["rising_count"]),
                falling_count=int(group["falling_count"]),
                limit_up_count=int(group["limit_up_count"]),
                limit_down_count=int(group["limit_down_count"]),
                rising_ratio=rising_ratio,
                latest_amount=group["latest_amount"] if group["latest_amount"] else None,
                avg_amount_20d=group["avg_amount_20d"] if group["avg_amount_20d"] else None,
                amount_ratio_20d=amount_ratio_20d,
                avg_turnover_20d=avg_turnover,
                strength_20d_pct=strength_20d_pct,
                contribution_ratio=None,
                net_amount_ratio=(
                    proxy_net_amount / group["latest_amount"] * Decimal("100")
                    if proxy_net_amount is not None and group["latest_amount"]
                    else None
                ),
                proxy_net_amount=proxy_net_amount,
                signal=sector_signal(
                    covered_count=covered_count,
                    rising_ratio=rising_ratio,
                    strength_20d_pct=strength_20d_pct,
                    amount_ratio_20d=amount_ratio_20d,
                    proxy_net_amount=proxy_net_amount,
                ),
                top_symbols=list(group["top_symbols"]),
            )
        )

    sorted_items = sorted(
        items,
        key=lambda item: (
            item.proxy_net_amount or Decimal("-999999999999999999"),
            item.latest_amount or Decimal("0"),
            item.member_count,
        ),
        reverse=True,
    )
    total_latest_amount = sum((item.latest_amount or Decimal("0")) for item in sorted_items)
    if total_latest_amount:
        for item in sorted_items:
            item.contribution_ratio = (
                (item.latest_amount or Decimal("0")) / total_latest_amount * Decimal("100")
            )

    market_summary = _build_sector_market_summary(sorted_items, rows)
    result = {
        "items": sorted_items[:normalized_limit],
        "_items_all": sorted_items,
        "_source_rows": rows,
        "market_summary": market_summary,
        "detail": None,
        "cache_status": "miss",
        "cache_ttl_seconds": SECTOR_CAPITAL_FLOW_CACHE_TTL_SECONDS,
    }
    _sector_cache_set(summary_cache_key, result)
    await _sector_redis_set(summary_cache_key, result, include_source_rows=True)

    if normalized_sector:
        detail = await build_sector_capital_flow_detail(
            universe_id=universe_id,
            sector=normalized_sector,
            detail_days=normalized_detail_days,
            summary_items=sorted_items,
            source_rows=rows,
        )
        result = {**result, "detail": detail}
        _sector_cache_set(detail_cache_key, result)
        await _sector_redis_set(detail_cache_key, result)
    return result


async def list_foundation_components() -> list[FoundationComponentStatus]:
    async with await connect() as connection, connection.cursor(row_factory=dict_row) as cursor:
        await cursor.execute(
            """
            WITH table_estimates AS (
              SELECT
                c.relname,
                GREATEST(c.reltuples::BIGINT, 0) AS estimated_rows
              FROM pg_class c
              JOIN pg_namespace n ON n.oid = c.relnamespace
              WHERE n.nspname = 'quant'
                AND c.relname IN ('stock_bars', 'stock_factors')
            )
            SELECT
              (SELECT count(*)::INT FROM quant.trading_calendars) AS calendar_count,
              (SELECT count(*)::INT FROM quant.factor_definitions) AS factor_count,
              (SELECT count(*)::INT FROM quant.data_quality_scans) AS quality_scan_count,
              (SELECT count(*)::INT FROM quant.platform_jobs) AS platform_job_count,
              COALESCE(
                (SELECT estimated_rows FROM table_estimates WHERE relname = 'stock_bars'),
                0
              ) AS bar_count,
              COALESCE(
                (SELECT estimated_rows FROM table_estimates WHERE relname = 'stock_factors'),
                0
              ) AS factor_value_count,
              (SELECT count(*)::INT FROM quant.market_data_ingestion_jobs) AS ingestion_job_count
            """
        )
        row = await cursor.fetchone()

    row = row or {}
    calendar_count = int(row.get("calendar_count") or 0)
    factor_count = int(row.get("factor_count") or 0)
    quality_scan_count = int(row.get("quality_scan_count") or 0)
    platform_job_count = int(row.get("platform_job_count") or 0)
    bar_count = int(row.get("bar_count") or 0)
    factor_value_count = int(row.get("factor_value_count") or 0)
    ingestion_job_count = int(row.get("ingestion_job_count") or 0)
    return [
        FoundationComponentStatus(
            id="trading-calendar",
            name="交易日历",
            status="ready" if calendar_count else "partial",
            count=calendar_count,
            detail=(
                f"已维护 {calendar_count} 个交易日记录。"
                if calendar_count
                else "尚未维护独立交易日历，当前按本地 K 线日期推断。"
            ),
        ),
        FoundationComponentStatus(
            id="factor-registry",
            name="因子定义仓库",
            status="ready" if factor_count else "missing",
            count=factor_count,
            detail=f"已登记 {factor_count} 个因子口径，因子值 {factor_value_count} 条。",
        ),
        FoundationComponentStatus(
            id="data-quality",
            name="数据质量扫描",
            status="ready" if quality_scan_count else "partial",
            count=quality_scan_count,
            detail=(
                f"已有 {quality_scan_count} 次扫描归档。"
                if quality_scan_count
                else "扫描 API 已可用，尚未产生归档。"
            ),
        ),
        FoundationComponentStatus(
            id="platform-jobs",
            name="平台任务底座",
            status="ready" if platform_job_count or ingestion_job_count else "partial",
            count=platform_job_count + ingestion_job_count,
            detail=(
                f"平台任务 {platform_job_count} 个，补数任务 {ingestion_job_count} 个。"
            ),
        ),
        FoundationComponentStatus(
            id="timeseries-store",
            name="TimescaleDB 行情时序库",
            status="ready" if bar_count else "partial",
            count=bar_count,
            detail=f"本地 K 线 {bar_count} 行。",
        ),
    ]


async def list_factor_definitions(
    *,
    category: str | None = None,
    status: str | None = None,
) -> list[FactorDefinition]:
    params: list[Any] = []
    filters: list[str] = []
    if category:
        filters.append("category = %s")
        params.append(category)
    if status:
        filters.append("status = %s")
        params.append(status)
    where_sql = f"WHERE {' AND '.join(filters)}" if filters else ""

    async with await connect() as connection, connection.cursor(row_factory=dict_row) as cursor:
        await cursor.execute(
            f"""
            SELECT
              factor_key,
              name,
              category,
              frequency,
              value_type,
              unit,
              description,
              formula,
              dependencies,
              status,
              provider,
              metadata,
              updated_at
            FROM quant.factor_definitions
            {where_sql}
            ORDER BY
              category,
              COALESCE((metadata->>'display_order')::INT, 9999),
              factor_key
            """,
            tuple(params),
        )
        rows = await cursor.fetchall()

    return [
        FactorDefinition(
            factor_key=str(row["factor_key"]),
            name=str(row["name"]),
            category=str(row["category"]),
            frequency=str(row["frequency"]),
            value_type=str(row["value_type"]),
            unit=row["unit"],
            description=str(row["description"] or ""),
            formula=row["formula"],
            dependencies=json_array(row["dependencies"]),
            status=str(row["status"]),
            provider=str(row["provider"]),
            metadata=json_object(row["metadata"]),
            updated_at=row["updated_at"],
        )
        for row in rows
    ]


async def list_trading_calendar_days(
    *,
    market: str = "CN-A",
    start: str | None = None,
    end: str | None = None,
    limit: int = 260,
) -> list[TradingCalendarDay]:
    start_date = date.fromisoformat(start) if start else None
    end_date = date.fromisoformat(end) if end else None
    normalized_limit = max(1, min(limit, 5000))
    inferred_start_date = start_date
    if inferred_start_date is None:
        range_end = end_date or datetime.now(SHANGHAI_TZ).date()
        inferred_start_date = range_end - timedelta(days=max(45, normalized_limit * 4))
    async with await connect() as connection, connection.cursor(row_factory=dict_row) as cursor:
        await cursor.execute(
            """
            SELECT market, trade_date, is_open, session, source, metadata
            FROM quant.trading_calendars
            WHERE market = %s
              AND (%s::DATE IS NULL OR trade_date >= %s)
              AND (%s::DATE IS NULL OR trade_date <= %s)
            ORDER BY trade_date DESC
            LIMIT %s
            """,
            (market, start_date, start_date, end_date, end_date, normalized_limit),
        )
        rows = await cursor.fetchall()

    if rows:
        return [
            TradingCalendarDay(
                market=str(row["market"]),
                trade_date=row["trade_date"],
                is_open=bool(row["is_open"]),
                session=str(row["session"]),
                source=str(row["source"]),
                metadata=json_object(row["metadata"]),
            )
            for row in reversed(rows)
        ]

    inferred_market = market or "CN-A"
    async with await connect() as connection, connection.cursor(row_factory=dict_row) as cursor:
        await cursor.execute(
            """
            SELECT DISTINCT bars.ts::date AS trade_date
            FROM quant.stock_bars bars
            JOIN quant.securities securities
              ON securities.symbol = bars.symbol
            WHERE bars.timeframe = 'daily'
              AND securities.asset_type IN ('stock', 'etf', 'index', 'fund')
              AND (
                %s = 'CN-A'
                OR (%s = 'SSE' AND securities.exchange = 'SH')
                OR (%s = 'SZSE' AND securities.exchange = 'SZ')
                OR (%s = 'BSE' AND securities.exchange = 'BJ')
              )
              AND (%s::DATE IS NULL OR bars.ts >= %s::DATE)
              AND (%s::DATE IS NULL OR bars.ts::date <= %s)
            ORDER BY trade_date DESC
            LIMIT %s
            """,
            (
                inferred_market,
                inferred_market,
                inferred_market,
                inferred_market,
                inferred_start_date,
                inferred_start_date,
                end_date,
                end_date,
                normalized_limit,
            ),
        )
        inferred_rows = await cursor.fetchall()

    return [
        TradingCalendarDay(
            market=inferred_market,
            trade_date=row["trade_date"],
            is_open=True,
            session="regular",
            source="stock_bars-inferred",
            metadata={"inferred": True},
        )
        for row in reversed(inferred_rows)
    ]


async def run_data_quality_scan(
    request: DataQualityScanRequest,
) -> DataQualityScanResponse:
    started_at = datetime.now(UTC)
    scan_id = f"dq-{started_at.strftime('%Y%m%d%H%M%S')}-{os.urandom(4).hex()}"
    required_fields = [
        field.strip()
        for field in request.required_fields
        if field.strip()
        in {"amount", "turnover", "trade_status", "is_st", "limit_up", "limit_down"}
    ]
    async with await connect() as connection, connection.cursor(row_factory=dict_row) as cursor:
        if request.symbols:
            symbols = [
                canonical_symbol(symbol, symbol.split(".")[-1] if "." in symbol else None)
                for symbol in request.symbols
            ]
            await cursor.execute(
                """
                SELECT symbol, name, exchange
                FROM quant.securities
                WHERE symbol = ANY(%s::text[])
                ORDER BY symbol
                """,
                (symbols,),
            )
        else:
            await cursor.execute(
                """
                SELECT securities.symbol, securities.name, securities.exchange
                FROM quant.security_universe_members members
                JOIN quant.securities securities
                  ON securities.symbol = members.symbol
                WHERE members.universe_id = %s
                ORDER BY
                  CASE
                    WHEN members.metadata->>'order' ~ '^[0-9]+$'
                    THEN (members.metadata->>'order')::INT
                  END NULLS LAST,
                  securities.symbol
                """,
                (request.universe_id,),
            )
        target_rows = await cursor.fetchall()

    targets = [
        {
            "symbol": str(row["symbol"]),
            "query": normalize_fetch_symbol(str(row["symbol"])),
            "name": row["name"],
            "market": infer_market_from_symbol(str(row["symbol"])),
        }
        for row in target_rows
    ]
    coverage_by_symbol = await get_history_ingestion_preflight(
        targets=targets,
        timeframe=request.timeframe,
        adjustment=request.adjustment,
        lookback_years=request.lookback_years,
        require_fields=required_fields,
    )

    issues: list[DataQualityIssue] = []
    passed_symbols = 0
    warning_symbols = 0
    failed_symbols = 0
    checked_rows = 0
    missing_field_counts: dict[str, int] = {field: 0 for field in required_fields}
    latest_ts: datetime | None = None
    expected_rows = 0
    for target in targets:
        coverage = coverage_by_symbol.get(target["symbol"])
        if coverage is None or coverage.row_count == 0:
            failed_symbols += 1
            issues.append(
                DataQualityIssue(
                    symbol=target["symbol"],
                    name=target["name"],
                    severity="error",
                    issue_type="missing_kline",
                    message="本地没有可用 K 线。",
                )
            )
            continue

        checked_rows += coverage.rows_since_cutoff
        expected_rows = max(expected_rows, coverage.expected_rows_since_cutoff)
        if coverage.benchmark_last_ts and (
            latest_ts is None or coverage.benchmark_last_ts > latest_ts
        ):
            latest_ts = coverage.benchmark_last_ts

        symbol_issues: list[DataQualityIssue] = []
        if (
            coverage.expected_rows_since_cutoff
            and coverage.rows_since_cutoff < coverage.expected_rows_since_cutoff
        ):
            symbol_issues.append(
                DataQualityIssue(
                    symbol=target["symbol"],
                    name=target["name"],
                    severity="warning",
                    issue_type="missing_window_rows",
                    message=(
                        "补数区间样本少于本地参考交易日，可能存在缺 K 或新上市样本。"
                    ),
                    metrics={
                        "rows_since_cutoff": coverage.rows_since_cutoff,
                        "expected_rows_since_cutoff": coverage.expected_rows_since_cutoff,
                    },
                )
            )
        if (
            coverage.benchmark_last_ts
            and coverage.last_ts
            and coverage.last_ts.date() < coverage.benchmark_last_ts.date()
        ):
            symbol_issues.append(
                DataQualityIssue(
                    symbol=target["symbol"],
                    name=target["name"],
                    severity="warning",
                    issue_type="stale_latest_bar",
                    message="最新 K 线日期落后于本地参考最新交易日。",
                    metrics={
                        "last_ts": coverage.last_ts.isoformat(),
                        "benchmark_last_ts": coverage.benchmark_last_ts.isoformat(),
                    },
                )
            )
        _, missing_fields = _coverage_missing_fields(coverage, required_fields)
        for field in missing_fields:
            missing_field_counts[field] = missing_field_counts.get(field, 0) + 1
        if missing_fields:
            symbol_issues.append(
                DataQualityIssue(
                    symbol=target["symbol"],
                    name=target["name"],
                    severity="warning",
                    issue_type="missing_fields",
                    message=f"补数区间字段覆盖不完整：{', '.join(missing_fields)}。",
                    metrics={
                        "missing_fields": missing_fields,
                        "complete_rows_since_cutoff": coverage.complete_rows_since_cutoff,
                        "rows_since_cutoff": coverage.rows_since_cutoff,
                    },
                )
            )

        if symbol_issues:
            warning_symbols += 1
            issues.extend(symbol_issues)
        else:
            passed_symbols += 1

    severity = "ok"
    if failed_symbols:
        severity = "error"
    elif warning_symbols:
        severity = "warning"
    completed_at = datetime.now(UTC)
    response = DataQualityScanResponse(
        id=scan_id,
        universe_id=None if request.symbols else request.universe_id,
        symbol=targets[0]["symbol"] if len(targets) == 1 else None,
        scope="symbol" if len(targets) == 1 else "symbols" if request.symbols else "universe",
        timeframe=request.timeframe,
        adjustment=request.adjustment,
        status="completed",
        severity=severity,
        checked_symbols=len(targets),
        passed_symbols=passed_symbols,
        warning_symbols=warning_symbols,
        failed_symbols=failed_symbols,
        checked_rows=checked_rows,
        issue_count=len(issues),
        issues=issues[:500],
        metrics={
            "lookback_years": request.lookback_years,
            "required_fields": required_fields,
            "missing_field_counts": missing_field_counts,
            "expected_rows_since_cutoff": expected_rows,
            "benchmark_last_ts": latest_ts.isoformat() if latest_ts else None,
        },
        started_at=started_at,
        completed_at=completed_at,
    )

    if request.persist:
        async with await connect() as connection, connection.cursor() as cursor:
            await cursor.execute(
                """
                INSERT INTO quant.data_quality_scans (
                  id, universe_id, symbol, scope, timeframe, adjustment, status, severity,
                  checked_symbols, passed_symbols, warning_symbols, failed_symbols,
                  checked_rows, issue_count, issues, metrics, started_at, completed_at,
                  created_at, updated_at
                )
                VALUES (
                  %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s,
                  %s, %s, now(), now()
                )
                ON CONFLICT (id) DO UPDATE SET
                  status = EXCLUDED.status,
                  severity = EXCLUDED.severity,
                  checked_symbols = EXCLUDED.checked_symbols,
                  passed_symbols = EXCLUDED.passed_symbols,
                  warning_symbols = EXCLUDED.warning_symbols,
                  failed_symbols = EXCLUDED.failed_symbols,
                  checked_rows = EXCLUDED.checked_rows,
                  issue_count = EXCLUDED.issue_count,
                  issues = EXCLUDED.issues,
                  metrics = EXCLUDED.metrics,
                  completed_at = EXCLUDED.completed_at,
                  updated_at = now()
                """,
                (
                    response.id,
                    response.universe_id,
                    response.symbol,
                    response.scope,
                    response.timeframe,
                    response.adjustment,
                    response.status,
                    response.severity,
                    response.checked_symbols,
                    response.passed_symbols,
                    response.warning_symbols,
                    response.failed_symbols,
                    response.checked_rows,
                    response.issue_count,
                    Jsonb([issue.model_dump(mode="json") for issue in response.issues]),
                    Jsonb(response.metrics),
                    response.started_at,
                    response.completed_at,
                ),
            )
    return response


async def build_sector_capital_flow_detail(
    *,
    universe_id: str,
    sector: str,
    detail_days: int,
    summary_items: list[SectorCapitalFlowItem],
    source_rows: list[dict[str, Any]],
) -> SectorCapitalFlowDetail | None:
    item = next((entry for entry in summary_items if entry.sector == sector), None)
    if item is None:
        return None

    selected_rows: list[dict[str, Any]] = []
    selected_symbols: list[str] = []
    for row in source_rows:
        sector_fields = security_sector_fields(row["security_metadata"])
        sector_tags = sector_fields["sector_tags"] or [sector_fields["industry"] or "未分组"]
        if sector in [str(tag) for tag in sector_tags]:
            selected_rows.append(row)
            selected_symbols.append(str(row["symbol"]))

    top_members = sorted(
        [
            SectorCapitalFlowMember(
                symbol=str(row["symbol"]),
                name=row["name"],
                latest_amount=decimal_or_none(row["latest_amount"]),
                proxy_net_amount=directional_amount(
                    decimal_or_none(row["latest_amount"]),
                    decimal_or_none(row["latest_change_percent"]),
                ),
                latest_change_percent=decimal_or_none(row["latest_change_percent"]),
                strength_20d_pct=percent_change(
                    decimal_or_none(row["latest_close"]),
                    decimal_or_none(row["close_20d"]),
                ),
                turnover=decimal_or_none(row["latest_turnover"]),
                limit_up=bool_or_none(row["latest_limit_up"]),
            )
            for row in selected_rows
        ],
        key=lambda member: member.latest_amount or Decimal("0"),
        reverse=True,
    )[:12]

    if not selected_symbols:
        return SectorCapitalFlowDetail(
            sector=sector,
            item=item,
            top_members=top_members,
            analysis=_sector_detail_analysis(item),
        )

    trend_days = max(detail_days, 20)
    trend_cutoff = datetime.now(UTC) - timedelta(days=max(120, trend_days * 4))
    async with await connect() as connection, connection.cursor(row_factory=dict_row) as cursor:
        await cursor.execute(
            """
            WITH universe_config AS (
              SELECT
                COALESCE(metadata->>'default_timeframe', 'daily') AS timeframe,
                COALESCE(metadata->>'default_adjustment', 'qfq') AS adjustment
              FROM quant.security_universes
              WHERE id = %s
            ),
            ranked_bars AS (
              SELECT
                bars.symbol,
                bars.ts,
                bars.amount,
                bars.change_percent,
                bars.limit_up,
                dense_rank() OVER (ORDER BY bars.ts DESC) AS day_rank
              FROM quant.stock_bars bars
              CROSS JOIN universe_config
              WHERE bars.symbol = ANY(%s)
                AND bars.timeframe = universe_config.timeframe
                AND bars.adjustment = universe_config.adjustment
                AND bars.ts >= %s
            )
            SELECT symbol, ts::date AS trade_date, amount, change_percent, limit_up
            FROM ranked_bars
            WHERE day_rank <= %s
            ORDER BY trade_date ASC, symbol
            """,
            (universe_id, selected_symbols, trend_cutoff, trend_days),
        )
        trend_rows = await cursor.fetchall()

    by_date: dict[date, dict[str, Any]] = {}
    for row in trend_rows:
        trade_day = row["trade_date"]
        group = by_date.setdefault(
            trade_day,
            {
                "covered_count": 0,
                "rising_count": 0,
                "limit_up_count": 0,
                "latest_amount": Decimal("0"),
                "proxy_net_amount": Decimal("0"),
            },
        )
        amount = decimal_or_none(row["amount"])
        change_percent = decimal_or_none(row["change_percent"])
        if amount is not None:
            group["latest_amount"] += amount
            if change_percent is not None:
                group["covered_count"] += 1
                if change_percent > 0:
                    group["rising_count"] += 1
                    group["proxy_net_amount"] += amount
                elif change_percent < 0:
                    group["proxy_net_amount"] -= amount
        if bool_or_none(row["limit_up"]) is True:
            group["limit_up_count"] += 1

    raw_points: list[SectorCapitalFlowTrendPoint] = []
    rolling_amounts: list[Decimal] = []
    for trade_day, group in sorted(by_date.items()):
        latest_amount = group["latest_amount"]
        rolling_amounts.append(latest_amount)
        rolling_window = rolling_amounts[-20:]
        avg_amount = sum(rolling_window) / Decimal(len(rolling_window)) if rolling_window else None
        covered_count = int(group["covered_count"])
        raw_points.append(
            SectorCapitalFlowTrendPoint(
                trade_date=trade_day,
                latest_amount=latest_amount if latest_amount else None,
                proxy_net_amount=group["proxy_net_amount"] if latest_amount else None,
                rising_ratio=(
                    Decimal(group["rising_count"]) / Decimal(covered_count) * Decimal("100")
                    if covered_count
                    else None
                ),
                amount_ratio_20d=(latest_amount / avg_amount if avg_amount else None),
                limit_up_count=int(group["limit_up_count"]),
            )
        )

    return SectorCapitalFlowDetail(
        sector=sector,
        item=item,
        trend=raw_points[-detail_days:],
        top_members=top_members,
        analysis=_sector_detail_analysis(item),
    )


def _screener_missing_fields(row: dict[str, Any]) -> list[str]:
    required = {
        "close": row.get("latest_close"),
        "open": row.get("latest_open"),
        "previous_close": row.get("previous_close"),
        "amount": row.get("latest_amount"),
        "turnover": row.get("latest_turnover"),
        "ma5": row.get("ma5"),
        "ma10": row.get("ma10"),
        "ma20": row.get("ma20"),
        "ma30": row.get("ma30"),
        "ma60": row.get("ma60"),
    }
    return [key for key, value in required.items() if value is None]


def _screener_score(row: dict[str, Any]) -> Decimal:
    close = decimal_or_none(row.get("latest_close"))
    open_price = decimal_or_none(row.get("latest_open"))
    previous_close = decimal_or_none(row.get("previous_close"))
    amount = decimal_or_none(row.get("latest_amount"))
    avg_amount_20d = decimal_or_none(row.get("avg_amount_20d"))
    strength_20d = percent_change(close, decimal_or_none(row.get("close_20d")))
    amount_ratio = decimal_ratio(amount, avg_amount_20d)
    ma5 = decimal_or_none(row.get("ma5"))
    ma10 = decimal_or_none(row.get("ma10"))
    ma20 = decimal_or_none(row.get("ma20"))
    ma30 = decimal_or_none(row.get("ma30"))
    ma60 = decimal_or_none(row.get("ma60"))
    latest_change = decimal_or_none(row.get("latest_change_percent"))
    previous_change = decimal_or_none(row.get("previous_change_percent"))
    limit_up_count_4d = int(row.get("limit_up_count_4d") or 0)
    limit_up_count_10d = int(row.get("limit_up_count_10d") or 0)
    score = Decimal("0")

    if (
        all(value is not None for value in (ma5, ma10, ma20, ma30, ma60))
        and ma5 >= ma10 >= ma20 >= ma30 >= ma60
    ):
        score += Decimal("28")
    elif (
        all(value is not None for value in (ma5, ma10, ma20, ma60))
        and ma5 >= ma10 >= ma20 >= ma60
    ):
        score += Decimal("20")
    if close is not None and ma5 is not None and close >= ma5:
        score += Decimal("12")
        distance = decimal_ratio(close, ma5)
        if distance is not None and distance > Decimal("1.12"):
            score -= Decimal("6")
    if strength_20d is not None:
        score += max(Decimal("0"), min(Decimal("18"), strength_20d / Decimal("2")))
    if amount_ratio is not None:
        score += max(Decimal("0"), min(Decimal("16"), amount_ratio * Decimal("5")))
    if latest_change is not None and latest_change > 0:
        score += Decimal("8")
    if open_price is not None and previous_close is not None and open_price > previous_close:
        score += Decimal("6")
    if previous_change is not None and previous_change >= 0:
        score += Decimal("4")
    if limit_up_count_4d > 0:
        score += Decimal("10")
    elif limit_up_count_10d > 0:
        score += Decimal("5")
    return score.quantize(Decimal("0.01"))


def _screener_signals(row: dict[str, Any]) -> list[str]:
    close = decimal_or_none(row.get("latest_close"))
    open_price = decimal_or_none(row.get("latest_open"))
    previous_close = decimal_or_none(row.get("previous_close"))
    amount = decimal_or_none(row.get("latest_amount"))
    avg_amount_20d = decimal_or_none(row.get("avg_amount_20d"))
    amount_ratio = decimal_ratio(amount, avg_amount_20d)
    ma5 = decimal_or_none(row.get("ma5"))
    ma10 = decimal_or_none(row.get("ma10"))
    ma20 = decimal_or_none(row.get("ma20"))
    ma30 = decimal_or_none(row.get("ma30"))
    ma60 = decimal_or_none(row.get("ma60"))
    latest_change = decimal_or_none(row.get("latest_change_percent"))
    previous_change = decimal_or_none(row.get("previous_change_percent"))
    limit_up_count_4d = int(row.get("limit_up_count_4d") or 0)
    signals: list[str] = []
    if limit_up_count_4d > 0:
        signals.append("近4日出现涨停")
    if (
        all(value is not None for value in (ma5, ma10, ma20, ma30, ma60))
        and ma5 >= ma10 >= ma20 >= ma30 >= ma60
    ):
        signals.append("MA5/10/20/30/60 多头排列")
    if close is not None and ma5 is not None and close >= ma5:
        signals.append("收盘价站上 MA5")
    if open_price is not None and previous_close is not None and open_price > previous_close:
        signals.append("今日高开")
    if latest_change is not None and latest_change > 0:
        signals.append("今日上涨")
    if previous_change is not None and previous_change >= 0:
        signals.append("前一日未下跌")
    if amount_ratio is not None and amount_ratio >= Decimal("1.2"):
        signals.append("成交额较20日均额放大")
    return signals


def _screener_warnings(row: dict[str, Any]) -> list[str]:
    warnings: list[str] = []
    if int(row.get("sample_count") or 0) < 60:
        warnings.append("样本不足 60 根日 K，MA60 稳定性较弱")
    if bool_or_none(row.get("latest_limit_up")) is True:
        warnings.append("当日涨停，可能无法合理买入")
    if decimal_or_none(row.get("latest_amount")) is None:
        warnings.append("缺少成交额，流动性判断不完整")
    if decimal_or_none(row.get("latest_turnover")) is None:
        warnings.append("缺少换手率")
    return warnings


def _screener_cache_key(
    *,
    universe_id: str,
    trade_date: date,
    mode: ScreenerMode,
    limit: int,
) -> tuple[str, str, str, int]:
    return (universe_id, trade_date.isoformat(), mode, limit)


def _screener_cached_response(
    response: AShareScreenerResponse,
    cache_status: str,
) -> AShareScreenerResponse:
    return response.model_copy(
        update={
            "cache_status": cache_status,
            "cache_ttl_seconds": SCREENER_CACHE_TTL_SECONDS,
            "fetched_at": datetime.now(UTC),
        }
    )


def _screener_cache_get(
    key: tuple[str, str, str, int],
) -> AShareScreenerResponse | None:
    cached = _SCREENER_CACHE.get(key)
    if not cached:
        return None
    cached_at, response = cached
    if datetime.now(UTC) - cached_at > timedelta(seconds=SCREENER_CACHE_TTL_SECONDS):
        _SCREENER_CACHE.pop(key, None)
        return None
    return _screener_cached_response(response, "hit")


def _screener_cache_set(
    key: tuple[str, str, str, int],
    response: AShareScreenerResponse,
) -> None:
    if SCREENER_CACHE_TTL_SECONDS <= 0:
        return
    _SCREENER_CACHE[key] = (datetime.now(UTC), response)
    if len(_SCREENER_CACHE) > 64:
        oldest_key = min(_SCREENER_CACHE.items(), key=lambda item: item[1][0])[0]
        _SCREENER_CACHE.pop(oldest_key, None)


def _screener_redis_key(key: tuple[str, str, str, int]) -> str:
    return _SCREENER_REDIS_CACHE.key(":".join(str(part) for part in ("screener", *key)))


async def _screener_redis_get(
    key: tuple[str, str, str, int],
) -> AShareScreenerResponse | None:
    payload = await _SCREENER_REDIS_CACHE.read(_screener_redis_key(key))
    if payload is None:
        return None
    try:
        response = AShareScreenerResponse.model_validate(payload)
    except (TypeError, ValueError):
        return None
    return _screener_cached_response(response, "redis-hit")


async def _screener_redis_set(
    key: tuple[str, str, str, int],
    response: AShareScreenerResponse,
) -> None:
    await _SCREENER_REDIS_CACHE.write(
        _screener_redis_key(key),
        ttl_seconds=SCREENER_CACHE_TTL_SECONDS,
        payload=response.model_dump(mode="json"),
    )


async def sync_clickhouse_daily_bars(
    *,
    universe_id: str = DEFAULT_UNIVERSE_ID,
    start: date | None = None,
    end: date | None = None,
    timeframe: str = "daily",
    adjustment: str = "qfq",
    limit: int | None = 300_000,
) -> ClickHouseSyncResponse:
    if not is_clickhouse_enabled():
        return ClickHouseSyncResponse(
            enabled=False,
            status="disabled",
            universe_id=universe_id,
            timeframe=timeframe,
            adjustment=adjustment,
            start=start,
            end=end,
            message="ClickHouse 分析层未启用，设置 QUANTPILOT_CLICKHOUSE_ENABLED=1 后可同步。",
        )

    safe_limit = None if limit is None else max(1, min(limit, 2_000_000))
    limit_clause = "" if safe_limit is None else "LIMIT %s"
    params: list[Any] = [
        universe_id,
        universe_id,
        timeframe,
        adjustment,
        start,
        start,
        end,
        end,
    ]
    if safe_limit is not None:
        params.append(safe_limit)

    async with await connect() as connection, connection.cursor(row_factory=dict_row) as cursor:
        await cursor.execute(
            f"""
            SELECT
              %s::text AS universe_id,
              bars.symbol,
              COALESCE(securities.code, split_part(bars.symbol, '.', 1)) AS code,
              securities.name,
              COALESCE(securities.exchange, 'UNKNOWN') AS exchange,
              COALESCE(securities.asset_type, 'stock') AS asset_type,
              (bars.ts AT TIME ZONE 'Asia/Shanghai')::date AS trade_date,
              bars.timeframe,
              bars.adjustment,
              bars.open,
              bars.high,
              bars.low,
              bars.close,
              bars.previous_close,
              bars.volume,
              bars.amount,
              bars.amplitude,
              bars.change_percent,
              bars.change_amount,
              bars.turnover,
              bars.trade_status,
              bars.is_st,
              bars.limit_up,
              bars.limit_down,
              COALESCE(securities.metadata, '{{}}'::jsonb) AS security_metadata,
              bars.provider
            FROM quant.stock_bars bars
            JOIN quant.security_universe_members members
              ON members.symbol = bars.symbol
              AND members.universe_id = %s
            LEFT JOIN quant.securities securities
              ON securities.symbol = bars.symbol
            WHERE bars.timeframe = %s
              AND bars.adjustment = %s
              AND (
                %s::date IS NULL
                OR bars.ts >= (%s::date::timestamp AT TIME ZONE 'Asia/Shanghai')
              )
              AND (
                %s::date IS NULL
                OR bars.ts < (((%s::date + 1)::timestamp) AT TIME ZONE 'Asia/Shanghai')
              )
            ORDER BY bars.ts DESC, bars.symbol ASC
            {limit_clause}
            """,
            params,
        )
        rows = [dict(row) for row in await cursor.fetchall()]

    try:
        await initialize_clickhouse()
        written = await insert_daily_bars(rows)
    except ClickHouseError as error:
        return ClickHouseSyncResponse(
            enabled=True,
            status="error",
            universe_id=universe_id,
            timeframe=timeframe,
            adjustment=adjustment,
            start=start,
            end=end,
            rows_read=len(rows),
            rows_written=0,
            message=str(error),
        )

    return ClickHouseSyncResponse(
        enabled=True,
        status="ok",
        universe_id=universe_id,
        timeframe=timeframe,
        adjustment=adjustment,
        start=start,
        end=end,
        rows_read=len(rows),
        rows_written=written,
        message="已同步日线行情到 ClickHouse 分析表。",
    )


async def screen_a_share_short_term_candidates(
    *,
    universe_id: str = DEFAULT_UNIVERSE_ID,
    trade_date: date | None = None,
    mode: ScreenerMode = "short_term",
    limit: int = 20,
) -> AShareScreenerResponse:
    safe_limit = max(1, min(limit, 100))
    resolved_trade_date = trade_date
    requested_trade_date_input = trade_date

    async with await connect() as connection, connection.cursor(row_factory=dict_row) as cursor:
        await cursor.execute(
            """
            WITH universe_config AS (
              SELECT
                id,
                COALESCE(metadata->>'default_timeframe', 'daily') AS timeframe,
                COALESCE(metadata->>'default_adjustment', 'qfq') AS adjustment
              FROM quant.security_universes
              WHERE id = %s
            )
            SELECT max((bars.ts AT TIME ZONE 'Asia/Shanghai')::date) AS trade_date
            FROM quant.security_universe_members members
            JOIN universe_config
              ON universe_config.id = members.universe_id
            JOIN quant.securities securities
              ON securities.symbol = members.symbol
            JOIN quant.stock_bars bars
              ON bars.symbol = members.symbol
             AND bars.timeframe = universe_config.timeframe
             AND bars.adjustment = universe_config.adjustment
            WHERE members.universe_id = %s
              AND securities.asset_type = 'stock'
              AND (
                %s::date IS NULL
                OR bars.ts < ((%s::date + 1)::timestamp AT TIME ZONE 'Asia/Shanghai')
              )
            """,
            (universe_id, universe_id, resolved_trade_date, resolved_trade_date),
        )
        target_row = await cursor.fetchone()
        resolved_trade_date = target_row["trade_date"] if target_row else None

        if resolved_trade_date is None:
            return AShareScreenerResponse(
                universe_id=universe_id,
                mode=mode,
                trade_date=None,
                scanned_symbols=0,
                limit=safe_limit,
                candidates=[],
                notes=["本地股票池尚未找到可筛选的交易日。"],
            )

        cache_key = _screener_cache_key(
            universe_id=universe_id,
            trade_date=resolved_trade_date,
            mode=mode,
            limit=safe_limit,
        )
        cached = _screener_cache_get(cache_key)
        if cached is not None:
            return cached
        cached = await _screener_redis_get(cache_key)
        if cached is not None:
            _screener_cache_set(cache_key, cached)
            return cached

        data_basis = "timescaledb.stock_bars"
        clickhouse_note: str | None = None
        rows: list[dict[str, Any]] = []
        if is_clickhouse_enabled():
            try:
                clickhouse_trade_date, clickhouse_rows = await query_screener_feature_rows(
                    universe_id=universe_id,
                    trade_date=resolved_trade_date,
                    timeframe="daily",
                    adjustment="qfq",
                )
                if clickhouse_trade_date == resolved_trade_date and clickhouse_rows:
                    rows = clickhouse_rows
                    data_basis = "clickhouse.quant_bars_daily"
                    clickhouse_note = "本次筛选使用 ClickHouse 分析表生成横截面特征。"
                elif clickhouse_trade_date == resolved_trade_date:
                    clickhouse_note = "ClickHouse 未返回可用筛选特征，已回退 TimescaleDB。"
                elif clickhouse_trade_date is not None:
                    clickhouse_note = (
                        "ClickHouse 分析表最新交易日为 "
                        f"{clickhouse_trade_date.isoformat()}，"
                        "与 TimescaleDB 目标交易日不一致，已回退 TimescaleDB。"
                    )
            except Exception as error:
                clickhouse_note = f"ClickHouse 查询失败，已回退 TimescaleDB：{error}"

        if not rows:
            await cursor.execute(
                """
                WITH universe_config AS (
                  SELECT
                    id,
                    COALESCE(metadata->>'default_timeframe', 'daily') AS timeframe,
                    COALESCE(metadata->>'default_adjustment', 'qfq') AS adjustment
                  FROM quant.security_universes
                  WHERE id = %s
                ),
                member_symbols AS (
                  SELECT
                    securities.symbol,
                    securities.code,
                    securities.name,
                    securities.exchange,
                    securities.metadata AS security_metadata,
                    universe_config.timeframe,
                    universe_config.adjustment
                  FROM quant.security_universe_members members
                  JOIN universe_config
                    ON universe_config.id = members.universe_id
                  JOIN quant.securities securities
                    ON securities.symbol = members.symbol
                  WHERE members.universe_id = %s
                    AND securities.asset_type = 'stock'
                    AND securities.exchange <> 'BJ'
                    AND securities.code !~ '^(688|8|4)'
                    AND securities.name NOT ILIKE '%%ST%%'
                ),
                features AS (
                  SELECT
                    members.symbol,
                    members.code,
                    members.name,
                    members.exchange,
                    members.security_metadata,
                    count(recent_bars.*)::INT AS sample_count,
                    max(recent_bars.trade_date) FILTER (
                      WHERE recent_bars.rn = 1
                    ) AS latest_trade_date,
                    max(recent_bars.provider) FILTER (
                      WHERE recent_bars.rn = 1
                    ) AS latest_provider,
                    max(recent_bars.open) FILTER (WHERE recent_bars.rn = 1) AS latest_open,
                    max(recent_bars.high) FILTER (WHERE recent_bars.rn = 1) AS latest_high,
                    max(recent_bars.low) FILTER (WHERE recent_bars.rn = 1) AS latest_low,
                    max(recent_bars.close) FILTER (WHERE recent_bars.rn = 1) AS latest_close,
                    max(recent_bars.previous_close) FILTER (
                      WHERE recent_bars.rn = 1
                    ) AS previous_close,
                    max(recent_bars.amount) FILTER (
                      WHERE recent_bars.rn = 1
                    ) AS latest_amount,
                    max(recent_bars.turnover) FILTER (
                      WHERE recent_bars.rn = 1
                    ) AS latest_turnover,
                    max(recent_bars.change_percent) FILTER (
                      WHERE recent_bars.rn = 1
                    ) AS latest_change_percent,
                    max(recent_bars.change_percent) FILTER (
                      WHERE recent_bars.rn = 2
                    ) AS previous_change_percent,
                    bool_or(recent_bars.limit_up) FILTER (
                      WHERE recent_bars.rn = 1
                    ) AS latest_limit_up,
                    bool_or(recent_bars.is_st) FILTER (
                      WHERE recent_bars.rn = 1
                    ) AS latest_is_st,
                    avg(recent_bars.close) FILTER (WHERE recent_bars.rn <= 5) AS ma5,
                    avg(recent_bars.close) FILTER (WHERE recent_bars.rn <= 10) AS ma10,
                    avg(recent_bars.close) FILTER (WHERE recent_bars.rn <= 20) AS ma20,
                    avg(recent_bars.close) FILTER (WHERE recent_bars.rn <= 30) AS ma30,
                    avg(recent_bars.close) FILTER (WHERE recent_bars.rn <= 60) AS ma60,
                    avg(recent_bars.amount) FILTER (
                      WHERE recent_bars.rn <= 20 AND recent_bars.amount IS NOT NULL
                    ) AS avg_amount_20d,
                    max(recent_bars.close) FILTER (WHERE recent_bars.rn = 21) AS close_20d,
                    count(*) FILTER (
                      WHERE recent_bars.rn <= 4 AND recent_bars.limit_up IS TRUE
                    )::INT AS limit_up_count_4d,
                    count(*) FILTER (
                      WHERE recent_bars.rn <= 10 AND recent_bars.limit_up IS TRUE
                    )::INT AS limit_up_count_10d,
                    max(recent_bars.trade_date) FILTER (
                      WHERE recent_bars.rn <= 10 AND recent_bars.limit_up IS TRUE
                    ) AS latest_limit_up_date
                  FROM member_symbols members
                  LEFT JOIN LATERAL (
                    SELECT
                      local_bars.*,
                      row_number() OVER (ORDER BY local_bars.ts DESC) AS rn
                    FROM (
                      SELECT
                        bars.ts,
                        (bars.ts AT TIME ZONE 'Asia/Shanghai')::date AS trade_date,
                        bars.open,
                        bars.high,
                        bars.low,
                        bars.close,
                        bars.previous_close,
                        bars.amount,
                        bars.volume,
                        bars.turnover,
                        bars.change_percent,
                        bars.limit_up,
                        bars.is_st,
                        bars.provider
                      FROM quant.stock_bars bars
                      WHERE bars.symbol = members.symbol
                        AND bars.timeframe = members.timeframe
                        AND bars.adjustment = members.adjustment
                        AND bars.ts >= (
                          (%s::date - 260)::timestamp
                          AT TIME ZONE 'Asia/Shanghai'
                        )
                        AND bars.ts < (
                          (%s::date + 1)::timestamp
                          AT TIME ZONE 'Asia/Shanghai'
                        )
                      ORDER BY bars.ts DESC
                      LIMIT 60
                    ) local_bars
                  ) recent_bars ON TRUE
                  GROUP BY
                    members.symbol,
                    members.code,
                    members.name,
                    members.exchange,
                    members.security_metadata
                )
                SELECT
                  features.*,
                  %s::date AS requested_trade_date,
                  count(*) OVER ()::INT AS scanned_symbols
                FROM features
                WHERE features.latest_trade_date = %s::date
                  AND COALESCE(features.latest_is_st, FALSE) IS FALSE
                  AND COALESCE(features.latest_limit_up, FALSE) IS FALSE
                  AND features.latest_close IS NOT NULL
                  AND features.sample_count >= 20
                """,
                (
                    universe_id,
                    universe_id,
                    resolved_trade_date,
                    resolved_trade_date,
                    resolved_trade_date,
                    resolved_trade_date,
                ),
            )
            rows = await cursor.fetchall()

    def passes_mode(row: dict[str, Any]) -> bool:
        close = decimal_or_none(row.get("latest_close"))
        open_price = decimal_or_none(row.get("latest_open"))
        previous_close = decimal_or_none(row.get("previous_close"))
        amount = decimal_or_none(row.get("latest_amount"))
        avg_amount_20d = decimal_or_none(row.get("avg_amount_20d"))
        amount_ratio = decimal_ratio(amount, avg_amount_20d)
        ma5 = decimal_or_none(row.get("ma5"))
        ma10 = decimal_or_none(row.get("ma10"))
        ma20 = decimal_or_none(row.get("ma20"))
        ma30 = decimal_or_none(row.get("ma30"))
        ma60 = decimal_or_none(row.get("ma60"))
        latest_change = decimal_or_none(row.get("latest_change_percent"))
        previous_change = decimal_or_none(row.get("previous_change_percent"))
        strength_20d = percent_change(close, decimal_or_none(row.get("close_20d")))
        has_ma_stack_60 = all(
            value is not None for value in (ma5, ma10, ma20, ma30, ma60)
        ) and ma5 >= ma10 >= ma20 >= ma30 >= ma60
        has_ma_stack_20 = all(
            value is not None for value in (ma5, ma10, ma20)
        ) and ma5 >= ma10 >= ma20
        has_liquidity = amount is not None and amount >= Decimal("100000000")
        if mode == "limit_up_relay":
            return bool(
                int(row.get("limit_up_count_4d") or 0) >= 1
                and has_ma_stack_60
                and close is not None
                and ma5 is not None
                and close >= ma5
                and open_price is not None
                and previous_close is not None
                and open_price > previous_close
                and latest_change is not None
                and latest_change > 0
                and previous_change is not None
                and previous_change >= 0
                and has_liquidity
            )
        if mode == "trend_liquidity":
            return bool(
                has_ma_stack_20
                and close is not None
                and ma5 is not None
                and close >= ma5
                and strength_20d is not None
                and strength_20d > 0
                and amount_ratio is not None
                and amount_ratio >= Decimal("1.1")
                and has_liquidity
            )
        return bool(
            has_liquidity
            and close is not None
            and ma5 is not None
            and close >= ma5
            and latest_change is not None
            and latest_change > 0
            and (
                has_ma_stack_60
                or int(row.get("limit_up_count_4d") or 0) >= 1
                or (
                    strength_20d is not None
                    and strength_20d >= Decimal("8")
                    and amount_ratio is not None
                    and amount_ratio >= Decimal("1.2")
                )
            )
        )

    filtered_rows = [row for row in rows if passes_mode(row)]
    filtered_rows.sort(key=_screener_score, reverse=True)
    candidates: list[AShareScreenerCandidate] = []
    for row in filtered_rows[:safe_limit]:
        sector_fields = security_sector_fields(row["security_metadata"])
        amount_ratio = decimal_ratio(
            decimal_or_none(row.get("latest_amount")),
            decimal_or_none(row.get("avg_amount_20d")),
        )
        candidate = AShareScreenerCandidate(
            symbol=str(row["symbol"]),
            code=str(row["code"]),
            name=row["name"],
            exchange=row["exchange"] or "UNKNOWN",
            sector_tags=sector_fields["sector_tags"],
            trade_date=row["latest_trade_date"],
            close=decimal_or_none(row.get("latest_close")),
            open=decimal_or_none(row.get("latest_open")),
            high=decimal_or_none(row.get("latest_high")),
            low=decimal_or_none(row.get("latest_low")),
            previous_close=decimal_or_none(row.get("previous_close")),
            change_percent=decimal_or_none(row.get("latest_change_percent")),
            amount=decimal_or_none(row.get("latest_amount")),
            turnover=decimal_or_none(row.get("latest_turnover")),
            ma5=decimal_or_none(row.get("ma5")),
            ma10=decimal_or_none(row.get("ma10")),
            ma20=decimal_or_none(row.get("ma20")),
            ma30=decimal_or_none(row.get("ma30")),
            ma60=decimal_or_none(row.get("ma60")),
            strength_20d_pct=percent_change(
                decimal_or_none(row.get("latest_close")),
                decimal_or_none(row.get("close_20d")),
            ),
            amount_ratio_20d=amount_ratio,
            limit_up_count_4d=int(row.get("limit_up_count_4d") or 0),
            limit_up_count_10d=int(row.get("limit_up_count_10d") or 0),
            latest_limit_up_date=row.get("latest_limit_up_date"),
            is_limit_up=bool_or_none(row.get("latest_limit_up")),
            is_st=bool_or_none(row.get("latest_is_st")),
            sample_count=int(row.get("sample_count") or 0),
            score=_screener_score(row),
            signals=_screener_signals(row),
            warnings=_screener_warnings(row),
            missing_fields=_screener_missing_fields(row),
        )
        candidates.append(candidate)

    response_trade_date = next(
        (row.get("latest_trade_date") for row in rows if row.get("latest_trade_date")),
        resolved_trade_date,
    )
    notes = [
        (
            "本接口通过 QuantPilot market-data API 读取 ClickHouse 分析表；"
            "skills 不直接访问数据库。"
            if data_basis.startswith("clickhouse.")
            else (
                "本接口只通过 QuantPilot market-data API 读取本地 TimescaleDB；"
                "skills 不直接访问数据库。"
            )
        ),
        "当前 DDE 大单金额/大单净量未落库，候选结果使用日线 OHLCV、涨跌停、均线和流动性代理。",
    ]
    if clickhouse_note:
        notes.append(clickhouse_note)
    if requested_trade_date_input is not None and response_trade_date != requested_trade_date_input:
        notes.append(
            f"用户请求交易日 {requested_trade_date_input.isoformat()} 本地没有完整股票池覆盖，"
            f"已使用不晚于该日期的最近可用交易日 {response_trade_date.isoformat()}。"
        )
    response = AShareScreenerResponse(
        universe_id=universe_id,
        mode=mode,
        trade_date=response_trade_date,
        scanned_symbols=int(rows[0]["scanned_symbols"] or len(rows)) if rows else 0,
        limit=safe_limit,
        candidates=candidates,
        data_basis=data_basis,
        notes=notes,
        cache_status="miss",
        cache_ttl_seconds=SCREENER_CACHE_TTL_SECONDS,
    )
    if response_trade_date is not None:
        cache_key = _screener_cache_key(
            universe_id=universe_id,
            trade_date=response_trade_date,
            mode=mode,
            limit=safe_limit,
        )
        _screener_cache_set(cache_key, response)
        await _screener_redis_set(cache_key, response)
    return response


async def add_security_to_universe(
    *,
    universe_id: str,
    security: SymbolResolveResult,
    role: str = "member",
    weight: Decimal | None = None,
) -> ResearchUniverseMember:
    symbol = canonical_symbol(security.symbol, security.market)
    metadata = {
        "query": security.query,
        "raw": security.raw,
        "industry": security.raw.get("industry") or security.raw.get("f100"),
        "region": security.raw.get("region") or security.raw.get("f102"),
        "concepts": security.raw.get("concepts") or security.raw.get("f103"),
        "added_source": "strategy-platform",
    }
    async with await connect() as connection, connection.cursor(row_factory=dict_row) as cursor:
        await cursor.execute(
            """
            SELECT id
            FROM quant.security_universes
            WHERE id = %s
            """,
            (universe_id,),
        )
        if await cursor.fetchone() is None:
            raise DatabaseError(f"股票池不存在：{universe_id}")

        await cursor.execute(
            """
            INSERT INTO quant.securities (
              symbol, code, name, exchange, asset_type, currency, timezone, secid, provider,
              metadata, created_at, updated_at
            )
            VALUES (%s, %s, %s, %s, %s, 'CNY', 'Asia/Shanghai', %s, %s, %s, now(), now())
            ON CONFLICT (symbol) DO UPDATE SET
              code = EXCLUDED.code,
              name = COALESCE(EXCLUDED.name, quant.securities.name),
              exchange = EXCLUDED.exchange,
              asset_type = EXCLUDED.asset_type,
              secid = EXCLUDED.secid,
              provider = EXCLUDED.provider,
              metadata = quant.securities.metadata || EXCLUDED.metadata,
              updated_at = now()
            """,
            (
                symbol,
                security.symbol,
                security.name,
                security.market,
                security.asset_type,
                security.secid,
                security.source,
                Jsonb(metadata),
            ),
        )
        await cursor.execute(
            """
            SELECT COALESCE(max((members.metadata->>'order')::INT), 0) + 1 AS next_order
            FROM quant.security_universe_members members
            WHERE members.universe_id = %s
              AND members.metadata->>'order' ~ '^[0-9]+$'
            """,
            (universe_id,),
        )
        order_row = await cursor.fetchone()
        next_order = int(order_row["next_order"] or 1) if order_row else 1
        await cursor.execute(
            """
            INSERT INTO quant.security_universe_members (
              universe_id, symbol, role, weight, metadata, added_at
            )
            VALUES (%s, %s, %s, %s, %s, now())
            ON CONFLICT (universe_id, symbol) DO UPDATE SET
              role = EXCLUDED.role,
              weight = EXCLUDED.weight,
              metadata = quant.security_universe_members.metadata || EXCLUDED.metadata
            """,
            (
                universe_id,
                symbol,
                role or "member",
                weight,
                Jsonb({"order": next_order, "added_source": "strategy-platform"}),
            ),
        )

    members, _, _, _ = await list_research_universe_members_page(
        universe_id=universe_id,
        page=1,
        page_size=10,
        keyword=symbol,
    )
    for member in members:
        if member.symbol == symbol:
            return member
    raise DatabaseError(f"股票已写入但无法读取股票池成员：{symbol}")


async def add_securities_to_universe(
    *,
    universe_id: str,
    securities: list[SymbolResolveResult],
    role: str = "member",
    added_source: str = "a-share-batch-import",
) -> list[ResearchUniverseMember]:
    if not securities:
        return []

    async with await connect() as connection, connection.cursor(row_factory=dict_row) as cursor:
        await cursor.execute(
            """
            SELECT id
            FROM quant.security_universes
            WHERE id = %s
            """,
            (universe_id,),
        )
        if await cursor.fetchone() is None:
            raise DatabaseError(f"股票池不存在：{universe_id}")

        await cursor.execute(
            """
            SELECT COALESCE(max((members.metadata->>'order')::INT), 0) + 1 AS next_order
            FROM quant.security_universe_members members
            WHERE members.universe_id = %s
              AND members.metadata->>'order' ~ '^[0-9]+$'
            """,
            (universe_id,),
        )
        order_row = await cursor.fetchone()
        next_order = int(order_row["next_order"] or 1) if order_row else 1

        symbols: list[str] = []
        for offset, security in enumerate(securities):
            symbol = canonical_symbol(security.symbol, security.market)
            symbols.append(symbol)
            metadata = {
                "query": security.query,
                "raw": security.raw,
                "industry": security.raw.get("industry") or security.raw.get("f100"),
                "region": security.raw.get("region") or security.raw.get("f102"),
                "concepts": security.raw.get("concepts") or security.raw.get("f103"),
                "added_source": added_source,
            }
            await cursor.execute(
                """
                INSERT INTO quant.securities (
                  symbol, code, name, exchange, asset_type, currency, timezone, secid,
                  provider, metadata, created_at, updated_at
                )
                VALUES (%s, %s, %s, %s, %s, 'CNY', 'Asia/Shanghai', %s, %s, %s, now(), now())
                ON CONFLICT (symbol) DO UPDATE SET
                  code = EXCLUDED.code,
                  name = COALESCE(EXCLUDED.name, quant.securities.name),
                  exchange = EXCLUDED.exchange,
                  asset_type = EXCLUDED.asset_type,
                  secid = EXCLUDED.secid,
                  provider = EXCLUDED.provider,
                  metadata = quant.securities.metadata || EXCLUDED.metadata,
                  updated_at = now()
                """,
                (
                    symbol,
                    security.symbol,
                    security.name,
                    security.market,
                    security.asset_type,
                    security.secid,
                    security.source,
                    Jsonb(metadata),
                ),
            )
            await cursor.execute(
                """
                INSERT INTO quant.security_universe_members (
                  universe_id, symbol, role, weight, metadata, added_at
                )
                VALUES (%s, %s, %s, NULL, %s, now())
                ON CONFLICT (universe_id, symbol) DO UPDATE SET
                  role = EXCLUDED.role,
                  metadata = CASE
                    WHEN quant.security_universe_members.metadata ? 'order'
                    THEN quant.security_universe_members.metadata || (EXCLUDED.metadata - 'order')
                    ELSE quant.security_universe_members.metadata || EXCLUDED.metadata
                  END
                """,
                (
                    universe_id,
                    symbol,
                    role or "member",
                    Jsonb(
                        {
                            "order": next_order + offset,
                            "added_source": added_source,
                        }
                    ),
                ),
            )

    universes = await list_research_universes()
    member_by_symbol = {
        member.symbol: member
        for universe in universes
        if universe.id == universe_id
        for member in universe.members
    }
    return [member_by_symbol[symbol] for symbol in symbols if symbol in member_by_symbol]


async def list_market_data_coverage(
    universe_id: str | None = None,
) -> list[MarketDataCoverageItem]:
    async with await connect() as connection, connection.cursor(row_factory=dict_row) as cursor:
        if universe_id:
            await cursor.execute(
                """
                    SELECT
                      securities.symbol,
                      securities.name,
                      COALESCE(
                        coverage.timeframe,
                        universes.metadata->>'default_timeframe',
                        'daily'
                      ) AS timeframe,
                      COALESCE(
                        coverage.adjustment,
                        universes.metadata->>'default_adjustment',
                        'qfq'
                      ) AS adjustment,
                      COALESCE(
                        coverage.provider,
                        universes.metadata->>'provider',
                        'eastmoney'
                      ) AS provider,
                      coverage.first_ts,
                      coverage.last_ts,
                      COALESCE(coverage.row_count, 0) AS row_count
                    FROM quant.security_universe_members members
                    JOIN quant.security_universes universes
                      ON universes.id = members.universe_id
                    JOIN quant.securities securities
                      ON securities.symbol = members.symbol
                    LEFT JOIN LATERAL (
                      SELECT coverage_row.*
                      FROM quant.market_data_coverage coverage_row
                      WHERE coverage_row.symbol = securities.symbol
                        AND coverage_row.timeframe = COALESCE(
                          universes.metadata->>'default_timeframe',
                          'daily'
                        )
                        AND coverage_row.adjustment = COALESCE(
                          universes.metadata->>'default_adjustment',
                          'qfq'
                        )
                      ORDER BY (
                        coverage_row.provider = COALESCE(
                          universes.metadata->>'provider',
                          'eastmoney'
                        )
                      ) DESC, coverage_row.last_ts DESC NULLS LAST
                      LIMIT 1
                    ) coverage ON TRUE
                    WHERE members.universe_id = %s
                    ORDER BY
                      CASE
                        WHEN members.metadata->>'order' ~ '^[0-9]+$'
                        THEN (members.metadata->>'order')::INT
                      END NULLS LAST,
                      securities.symbol
                    """,
                (universe_id,),
            )
        else:
            await cursor.execute(
                """
                    SELECT
                      coverage.symbol,
                      securities.name,
                      coverage.timeframe,
                      coverage.adjustment,
                      coverage.provider,
                      coverage.first_ts,
                      coverage.last_ts,
                      coverage.row_count
                    FROM quant.market_data_coverage coverage
                    LEFT JOIN quant.securities securities
                      ON securities.symbol = coverage.symbol
                    ORDER BY coverage.symbol, coverage.timeframe, coverage.adjustment
                    """,
            )
        rows = await cursor.fetchall()

    return [
        MarketDataCoverageItem(
            symbol=str(row["symbol"]),
            name=row["name"],
            timeframe=row["timeframe"],
            adjustment=row["adjustment"],
            provider=str(row["provider"]),
            first_ts=row["first_ts"],
            last_ts=row["last_ts"],
            row_count=int(row["row_count"] or 0),
            data_status=coverage_status(int(row["row_count"] or 0), row["last_ts"]),
        )
        for row in rows
    ]


def calculate_return_pct(
    latest_close: Decimal | None,
    previous_close: Decimal | None,
) -> Decimal | None:
    if latest_close is None or previous_close is None or previous_close == 0:
        return None
    return ((latest_close - previous_close) / previous_close) * Decimal("100")


def aggregate_local_bars(
    bars: list[LocalKlineBar],
    timeframe: str,
) -> list[LocalKlineBar]:
    if timeframe not in {"weekly", "monthly"}:
        return bars

    grouped: dict[tuple[int, int], list[LocalKlineBar]] = {}
    for bar in bars:
        local_date = bar.ts.astimezone(SHANGHAI_TZ).date()
        if timeframe == "weekly":
            iso_year, iso_week, _ = local_date.isocalendar()
            key = (iso_year, iso_week)
        else:
            key = (local_date.year, local_date.month)
        grouped.setdefault(key, []).append(bar)

    aggregated: list[LocalKlineBar] = []
    for _, bucket_bars in sorted(grouped.items()):
        ordered = sorted(bucket_bars, key=lambda item: item.ts)
        amount_values = [item.amount for item in ordered if item.amount is not None]
        turnover_values = [item.turnover for item in ordered if item.turnover is not None]
        aggregated.append(
            LocalKlineBar(
                ts=ordered[-1].ts,
                open=ordered[0].open,
                high=max(item.high for item in ordered),
                low=min(item.low for item in ordered),
                close=ordered[-1].close,
                previous_close=ordered[0].previous_close,
                volume=sum((item.volume for item in ordered), Decimal("0")),
                amount=sum(amount_values, Decimal("0")) if amount_values else None,
                turnover=sum(turnover_values, Decimal("0")) if turnover_values else None,
                trade_status=ordered[-1].trade_status,
                is_st=ordered[-1].is_st,
                limit_up=None,
                limit_down=None,
                provider=ordered[-1].provider,
                metadata={
                    "aggregated_from": "daily",
                    "source_bar_count": len(ordered),
                    "source_first_ts": ordered[0].ts.isoformat(),
                    "source_last_ts": ordered[-1].ts.isoformat(),
                },
            )
        )
    return aggregated


def enrich_local_change_fields(bars: list[LocalKlineBar]) -> list[LocalKlineBar]:
    enriched: list[LocalKlineBar] = []
    previous_close: Decimal | None = None
    for bar in bars:
        base_close = bar.previous_close or previous_close
        change_amount = bar.change_amount
        change_percent = bar.change_percent
        if (
            bar.close is not None
            and base_close is not None
            and base_close != 0
        ):
            calculated_amount = bar.close - base_close
            change_amount = change_amount if change_amount is not None else calculated_amount
            change_percent = (
                change_percent
                if change_percent is not None
                else (calculated_amount / base_close) * Decimal("100")
            )
        enriched.append(
            bar.model_copy(
                update={
                    "previous_close": base_close,
                    "change_amount": change_amount,
                    "change_percent": change_percent,
                }
            )
        )
        previous_close = bar.close
    return enriched


async def get_local_kline(
    *,
    symbol: str,
    timeframe: str = "daily",
    adjustment: str = "qfq",
    provider: str | None = None,
    limit: int = 240,
    include_metadata: bool = False,
) -> LocalKlineResponse:
    normalized_limit = max(1, min(limit, 2000))
    query_timeframe = "daily" if timeframe in {"weekly", "monthly"} else timeframe
    source_limit = 8000 if timeframe in {"weekly", "monthly"} else normalized_limit

    async with await connect() as connection, connection.cursor(row_factory=dict_row) as cursor:
        await cursor.execute(
            """
            WITH ranked_bars AS (
              SELECT
                stock_bars.*,
                row_number() OVER (
                  PARTITION BY stock_bars.symbol, stock_bars.timeframe, stock_bars.adjustment,
                               stock_bars.ts
                  ORDER BY
                    CASE
                      WHEN stock_bars.provider = %s THEN 0
                      WHEN stock_bars.provider = 'eastmoney' THEN 1
                      WHEN stock_bars.provider = 'baostock' THEN 2
                      WHEN stock_bars.provider = 'akshare' THEN 3
                      ELSE 4
                    END,
                    stock_bars.created_at DESC
                ) AS provider_rank
              FROM quant.stock_bars
              WHERE stock_bars.symbol = %s
                AND stock_bars.timeframe = %s
                AND stock_bars.adjustment = %s
                AND (COALESCE(%s::text, '') = '' OR stock_bars.provider = %s)
            ),
            matching_bars AS (
              SELECT ranked_bars.*
              FROM ranked_bars
              WHERE ranked_bars.provider_rank = 1
            ),
            coverage_summary AS (
              SELECT
                count(*)::INT AS coverage_row_count,
                min(ts) AS coverage_first_ts,
                max(ts) AS coverage_last_ts
              FROM matching_bars
            ),
            selected_bars AS (
              SELECT matching_bars.*
              FROM matching_bars
              ORDER BY matching_bars.ts DESC
              LIMIT %s
            )
            SELECT
              selected_bars.ts,
              selected_bars.timeframe,
              selected_bars.adjustment,
              selected_bars.open,
              selected_bars.high,
              selected_bars.low,
              selected_bars.close,
              selected_bars.previous_close,
              selected_bars.volume,
              selected_bars.amount,
              selected_bars.amplitude,
              selected_bars.change_percent,
              selected_bars.change_amount,
              selected_bars.turnover,
              selected_bars.trade_status,
              selected_bars.is_st,
              selected_bars.limit_up,
              selected_bars.limit_down,
              selected_bars.provider AS data_provider,
              selected_bars.metadata AS bar_metadata,
              coverage_summary.coverage_row_count,
              coverage_summary.coverage_first_ts,
              coverage_summary.coverage_last_ts,
              securities.symbol,
              securities.code,
              securities.name,
              securities.exchange,
              securities.asset_type,
              securities.currency,
              securities.timezone,
              securities.secid,
              securities.provider
            FROM selected_bars
            CROSS JOIN coverage_summary
            LEFT JOIN quant.securities securities
              ON securities.symbol = selected_bars.symbol
            ORDER BY selected_bars.ts ASC
            """,
            (
                provider,
                symbol,
                query_timeframe,
                adjustment,
                provider,
                provider,
                source_limit,
            ),
        )
        rows = await cursor.fetchall()

    if not rows:
        return LocalKlineResponse(
            symbol=symbol,
            timeframe=timeframe,
            adjustment=adjustment,
            bars=[],
            summary=LocalKlineSummary(),
        )

    source_bars: list[LocalKlineBar] = []
    for row in rows:
        metadata = json_object(row["bar_metadata"])
        source_bars.append(
            LocalKlineBar(
                ts=row["ts"],
                open=row["open"],
                high=row["high"],
                low=row["low"],
                close=row["close"],
                previous_close=first_decimal(row["previous_close"], metadata.get("previous_close")),
                volume=row["volume"],
                amount=row["amount"],
                amplitude=first_decimal(row["amplitude"], metadata.get("amplitude")),
                change_percent=first_decimal(
                    row["change_percent"],
                    metadata.get("change_percent"),
                ),
                change_amount=first_decimal(
                    row["change_amount"],
                    metadata.get("change_amount"),
                ),
                turnover=first_decimal(row["turnover"], metadata.get("turnover")),
                trade_status=first_text(row["trade_status"], metadata.get("trade_status")),
                is_st=(
                    bool_or_none(row["is_st"])
                    if row["is_st"] is not None
                    else bool_or_none(metadata.get("is_st"))
                ),
                limit_up=(
                    bool_or_none(row["limit_up"])
                    if row["limit_up"] is not None
                    else bool_or_none(metadata.get("limit_up"))
                ),
                limit_down=(
                    bool_or_none(row["limit_down"])
                    if row["limit_down"] is not None
                    else bool_or_none(metadata.get("limit_down"))
                ),
                provider=str(row["data_provider"]),
                metadata=metadata if include_metadata else {},
            )
        )
    enriched_source_bars = enrich_local_change_fields(source_bars)
    aggregated_bars = enrich_local_change_fields(
        aggregate_local_bars(enriched_source_bars, timeframe)
    )
    all_bars = aggregated_bars if timeframe in {"weekly", "monthly"} else enriched_source_bars
    bars = all_bars[-normalized_limit:]
    latest = bars[-1] if bars else None
    previous = bars[-2] if len(bars) > 1 else None
    first_row = rows[0]
    summary_first_ts = all_bars[0].ts if all_bars else None
    summary_last_ts = all_bars[-1].ts if all_bars else None
    if timeframe not in {"weekly", "monthly"}:
        summary_first_ts = first_row["coverage_first_ts"] or summary_first_ts
        summary_last_ts = first_row["coverage_last_ts"] or summary_last_ts
    summary = LocalKlineSummary(
        row_count=(
            len(all_bars)
            if timeframe in {"weekly", "monthly"}
            else int(first_row["coverage_row_count"] or len(bars))
        ),
        first_ts=summary_first_ts,
        last_ts=summary_last_ts,
        latest_close=latest.close if latest else None,
        previous_close=(previous.close if previous else latest.previous_close if latest else None),
        return_pct=calculate_return_pct(
            latest.close if latest else None,
            previous.close if previous else latest.previous_close if latest else None,
        ),
        high=max((bar.high for bar in bars), default=None),
        low=min((bar.low for bar in bars), default=None),
        total_volume=sum((bar.volume for bar in bars), Decimal("0")),
        total_amount=sum((bar.amount or Decimal("0") for bar in bars), Decimal("0")),
    )
    return LocalKlineResponse(
        symbol=str(first_row["symbol"] or symbol),
        code=first_row["code"],
        name=first_row["name"],
        exchange=first_row["exchange"] or "UNKNOWN",
        asset_type=first_row["asset_type"] or "stock",
        currency=first_row["currency"] or "CNY",
        timezone=first_row["timezone"] or "Asia/Shanghai",
        secid=first_row["secid"],
        provider=str(first_row["data_provider"] or first_row["provider"]),
        timeframe=timeframe,
        adjustment=str(first_row["adjustment"] or adjustment),
        bars=bars,
        summary=summary,
    )


async def create_ingestion_job(
    *,
    job_id: str,
    universe_id: str | None,
    provider: str,
    timeframe: str,
    adjustment: str,
    total_symbols: int,
    metadata: dict[str, Any],
) -> None:
    async with await connect() as connection, connection.cursor() as cursor:
        await cursor.execute(
            """
                INSERT INTO quant.market_data_ingestion_jobs (
                  id, universe_id, provider, timeframe, adjustment, status, total_symbols,
                  metadata, started_at, created_at, updated_at
                )
                VALUES (%s, %s, %s, %s, %s, 'running', %s, %s, now(), now(), now())
                ON CONFLICT (id) DO UPDATE SET
                  provider = EXCLUDED.provider,
                  status = 'running',
                  total_symbols = EXCLUDED.total_symbols,
                  metadata = quant.market_data_ingestion_jobs.metadata || EXCLUDED.metadata,
                  started_at = now(),
                  updated_at = now()
                """,
            (job_id, universe_id, provider, timeframe, adjustment, total_symbols, Jsonb(metadata)),
        )


async def finish_ingestion_job(response: HistoryIngestionResponse) -> None:
    errors = [
        {"symbol": item.symbol, "error": item.error}
        for item in response.symbols
        if item.status == "failed" and item.error
    ]
    async with await connect() as connection, connection.cursor() as cursor:
        await cursor.execute(
            """
                UPDATE quant.market_data_ingestion_jobs
                SET
                  status = %s,
                  completed_symbols = %s,
                  failed_symbols = %s,
                  rows_received = %s,
                  rows_upserted = %s,
                  error = %s,
                  metadata = metadata || %s,
                  completed_at = %s,
                  updated_at = now()
                WHERE id = %s
                """,
            (
                response.status,
                response.completed_symbols,
                response.failed_symbols,
                response.rows_received,
                response.rows_upserted,
                "; ".join(f"{item['symbol']}: {item['error']}" for item in errors)[:2000]
                or None,
                Jsonb(
                    {
                        "symbol_results": [
                            item.model_dump(mode="json") for item in response.symbols
                        ],
                        "batch_offset": response.batch_offset,
                        "batch_size": response.batch_size,
                        "next_offset": response.next_offset,
                        "universe_total_symbols": response.universe_total_symbols,
                    }
                ),
                response.completed_at,
                response.job_id,
            ),
        )


async def update_ingestion_job_progress(
    *,
    job_id: str,
    status: str | None = None,
    completed_symbols: int | None = None,
    failed_symbols: int | None = None,
    rows_received: int | None = None,
    rows_upserted: int | None = None,
    error: str | None = None,
    metadata: dict[str, Any] | None = None,
    completed_at: datetime | None = None,
) -> None:
    updates = ["updated_at = now()"]
    params: list[Any] = []
    if status is not None:
        updates.append("status = %s")
        params.append(status)
    if completed_symbols is not None:
        updates.append("completed_symbols = %s")
        params.append(completed_symbols)
    if failed_symbols is not None:
        updates.append("failed_symbols = %s")
        params.append(failed_symbols)
    if rows_received is not None:
        updates.append("rows_received = %s")
        params.append(rows_received)
    if rows_upserted is not None:
        updates.append("rows_upserted = %s")
        params.append(rows_upserted)
    if error is not None:
        updates.append("error = %s")
        params.append(error[:2000])
    if metadata:
        updates.append("metadata = metadata || %s")
        params.append(Jsonb(metadata))
    if completed_at is not None:
        updates.append("completed_at = %s")
        params.append(completed_at)

    params.append(job_id)
    async with await connect() as connection, connection.cursor() as cursor:
        await cursor.execute(
            f"""
                UPDATE quant.market_data_ingestion_jobs
                SET {", ".join(updates)}
                WHERE id = %s
                """,
            tuple(params),
        )


async def control_ingestion_job(
    *,
    job_id: str,
    control: str,
    reason: str | None = None,
) -> IngestionJobSummary:
    now_iso = datetime.now(UTC).isoformat()
    metadata = {
        "control": control,
        "control_reason": reason,
        "control_updated_at": now_iso,
    }
    async with await connect() as connection, connection.cursor(row_factory=dict_row) as cursor:
        await cursor.execute(
            """
                UPDATE quant.market_data_ingestion_jobs
                SET
                  metadata = metadata || %s,
                  updated_at = now()
                WHERE id = %s
                RETURNING
                  id,
                  universe_id,
                  provider,
                  timeframe,
                  adjustment,
                  status,
                  total_symbols,
                  completed_symbols,
                  failed_symbols,
                  rows_received,
                  rows_upserted,
                  error,
                  metadata,
                  started_at,
                  completed_at,
                  created_at,
                  updated_at
                """,
            (Jsonb(metadata), job_id),
        )
        row = await cursor.fetchone()

    if not row:
        raise DatabaseError(f"补数任务不存在：{job_id}")
    return ingestion_job_summary_from_row(row)


async def reconcile_stale_ingestion_jobs(
    *,
    universe_id: str | None = None,
    heartbeat_timeout_seconds: int = INGESTION_JOB_STALE_SECONDS,
    stop_grace_seconds: int = INGESTION_JOB_STOP_GRACE_SECONDS,
) -> int:
    """Close running ingestion jobs that no longer have a live worker behind them."""
    now_iso = datetime.now(UTC).isoformat()
    universe_sql = "AND universe_id = %s" if universe_id else ""
    params: list[Any] = [stop_grace_seconds, heartbeat_timeout_seconds]
    if universe_id:
        params.append(universe_id)
    params.append(now_iso)

    async with await connect() as connection, connection.cursor(row_factory=dict_row) as cursor:
        await cursor.execute(
            f"""
                WITH stale AS (
                  SELECT
                    id,
                    CASE
                      WHEN metadata->>'control' = 'stop'
                        THEN '补数任务已请求停止，心跳未继续，已自动收口。'
                      ELSE '补数任务心跳过期，已自动标记为部分完成。'
                    END AS reason
                  FROM quant.market_data_ingestion_jobs
                  WHERE status = 'running'
                    AND (
                      (
                        metadata->>'control' = 'stop'
                        AND COALESCE(
                          NULLIF(metadata->>'control_updated_at', '')::timestamptz,
                          updated_at
                        )
                          < now() - (%s * interval '1 second')
                      )
                      OR (
                        COALESCE(
                          NULLIF(metadata->>'last_heartbeat_at', '')::timestamptz,
                          updated_at
                        )
                          < now() - (%s * interval '1 second')
                      )
                    )
                    {universe_sql}
                )
                UPDATE quant.market_data_ingestion_jobs AS job
                SET
                  status = 'partial',
                  completed_at = COALESCE(job.completed_at, now()),
                  error = COALESCE(job.error, stale.reason),
                  metadata = COALESCE(job.metadata, '{{}}'::jsonb) || jsonb_build_object(
                    'control', 'idle',
                    'active_child_job_id', NULL,
                    'stop_reason',
                      CASE
                        WHEN job.metadata->>'control' = 'stop' THEN 'stopped'
                        ELSE 'stale_heartbeat'
                      END,
                    'stale_reconciled_at', %s::text
                  ),
                  updated_at = now()
                FROM stale
                WHERE job.id = stale.id
                RETURNING job.id
                """,
            tuple(params),
        )
        rows = await cursor.fetchall()
    return len(rows)


async def list_ingestion_jobs(
    *,
    universe_id: str | None = None,
    limit: int = 20,
) -> list[IngestionJobSummary]:
    normalized_limit = max(1, min(limit, 100))
    params: tuple[Any, ...]
    where_sql = ""
    if universe_id:
        where_sql = "WHERE universe_id = %s"
        params = (universe_id, normalized_limit)
    else:
        params = (normalized_limit,)

    await reconcile_stale_ingestion_jobs(universe_id=universe_id)

    async with await connect() as connection, connection.cursor(row_factory=dict_row) as cursor:
        await cursor.execute(
            f"""
                SELECT
                  id,
                  universe_id,
                  provider,
                  timeframe,
                  adjustment,
                  status,
                  total_symbols,
                  completed_symbols,
                  failed_symbols,
                  rows_received,
                  rows_upserted,
                  error,
                  metadata,
                  started_at,
                  completed_at,
                  created_at,
                  updated_at
                FROM quant.market_data_ingestion_jobs
                {where_sql}
                ORDER BY created_at DESC
                LIMIT %s
                """,
            params,
        )
        rows = await cursor.fetchall()

    return [ingestion_job_summary_from_row(row) for row in rows]


def ingestion_job_summary_from_row(row: dict[str, Any]) -> IngestionJobSummary:
    return IngestionJobSummary(
        id=str(row["id"]),
        universe_id=row["universe_id"],
        provider=str(row["provider"]),
        timeframe=str(row["timeframe"]),
        adjustment=str(row["adjustment"]),
        status=str(row["status"]),
        total_symbols=int(row["total_symbols"] or 0),
        completed_symbols=int(row["completed_symbols"] or 0),
        failed_symbols=int(row["failed_symbols"] or 0),
        rows_received=int(row["rows_received"] or 0),
        rows_upserted=int(row["rows_upserted"] or 0),
        error=row["error"],
        metadata=json_object(row["metadata"]),
        started_at=row["started_at"],
        completed_at=row["completed_at"],
        created_at=row["created_at"],
        updated_at=row["updated_at"],
    )


async def get_ingestion_job_control(job_id: str) -> str | None:
    async with await connect() as connection, connection.cursor(row_factory=dict_row) as cursor:
        await cursor.execute(
            """
                SELECT metadata->>'control' AS control
                FROM quant.market_data_ingestion_jobs
                WHERE id = %s
                """,
            (job_id,),
        )
        row = await cursor.fetchone()
    return str(row["control"]) if row and row["control"] else None


async def get_history_ingestion_preflight(
    *,
    targets: list[dict[str, str]],
    timeframe: str,
    adjustment: str,
    lookback_years: int | None,
    start: str | None = None,
    end: str | None = None,
    require_fields: list[str] | None = None,
) -> dict[str, IngestionPreflightCoverage]:
    if not targets:
        return {}

    cutoff = date_cutoff_datetime(start) or lookback_cutoff_datetime(lookback_years)
    if cutoff is None:
        cutoff = datetime.min.replace(tzinfo=UTC)
    end_cutoff = date_cutoff_datetime(end)
    symbols = [str(target["symbol"]) for target in targets if target.get("symbol")]
    require_fields = require_fields or []
    if not symbols:
        return {}

    async with await connect() as connection, connection.cursor(row_factory=dict_row) as cursor:
        await cursor.execute(
            """
                WITH target_symbols(symbol) AS (
                  SELECT unnest(%s::text[])
                ),
                benchmark_dates AS (
                  SELECT DISTINCT bars.ts
                  FROM quant.stock_bars bars
                  WHERE bars.timeframe = %s
                    AND bars.adjustment = %s
                    AND bars.ts >= %s
                    AND (%s::TIMESTAMPTZ IS NULL OR bars.ts <= %s)
                ),
                benchmark_summary AS (
                  SELECT
                    count(*)::INT AS expected_rows_since_cutoff,
                    max(ts) AS benchmark_last_ts
                  FROM benchmark_dates
                ),
                requested_range AS (
                  SELECT %s::TIMESTAMPTZ AS requested_end_ts
                ),
                bar_summary AS (
                  SELECT
                    bars.symbol,
                    min(bars.ts) AS first_ts,
                    max(bars.ts) AS last_ts,
                    count(*)::INT AS row_count,
                    count(*) FILTER (
                      WHERE bars.ts >= %s
                        AND (%s::TIMESTAMPTZ IS NULL OR bars.ts <= %s)
                    )::INT AS rows_since_cutoff,
                    count(*) FILTER (
                      WHERE bars.ts >= %s
                        AND (%s::TIMESTAMPTZ IS NULL OR bars.ts <= %s)
                        AND (%s::BOOLEAN IS FALSE OR bars.amount IS NOT NULL)
                        AND (%s::BOOLEAN IS FALSE OR bars.turnover IS NOT NULL)
                        AND (%s::BOOLEAN IS FALSE OR bars.trade_status IS NOT NULL)
                        AND (%s::BOOLEAN IS FALSE OR bars.is_st IS NOT NULL)
                        AND (%s::BOOLEAN IS FALSE OR bars.limit_up IS NOT NULL)
                        AND (%s::BOOLEAN IS FALSE OR bars.limit_down IS NOT NULL)
                    )::INT AS complete_rows_since_cutoff
                  FROM quant.stock_bars bars
                  JOIN target_symbols
                    ON target_symbols.symbol = bars.symbol
                  WHERE bars.timeframe = %s
                    AND bars.adjustment = %s
                  GROUP BY bars.symbol
                ),
                factor_summary AS (
                  SELECT
                    factors.symbol,
                    count(*) FILTER (
                      WHERE factors.factor_key = 'pe_ttm'
                        AND factors.ts >= %s
                        AND (%s::TIMESTAMPTZ IS NULL OR factors.ts <= %s)
                    )::INT AS pe_ttm_count,
                    count(*) FILTER (
                      WHERE factors.factor_key = 'pb_mrq'
                        AND factors.ts >= %s
                        AND (%s::TIMESTAMPTZ IS NULL OR factors.ts <= %s)
                    )::INT AS pb_mrq_count,
                    count(*) FILTER (
                      WHERE factors.factor_key = 'ps_ttm'
                        AND factors.ts >= %s
                        AND (%s::TIMESTAMPTZ IS NULL OR factors.ts <= %s)
                    )::INT AS ps_ttm_count,
                    count(*) FILTER (
                      WHERE factors.factor_key = 'pcf_ncf_ttm'
                        AND factors.ts >= %s
                        AND (%s::TIMESTAMPTZ IS NULL OR factors.ts <= %s)
                    )::INT AS pcf_ncf_ttm_count
                  FROM quant.stock_factors factors
                  JOIN target_symbols
                    ON target_symbols.symbol = factors.symbol
                  GROUP BY factors.symbol
                )
                SELECT
                  target_symbols.symbol,
                  bar_summary.first_ts,
                  bar_summary.last_ts,
                  GREATEST(
                    benchmark_summary.benchmark_last_ts,
                    requested_range.requested_end_ts
                  ) AS benchmark_last_ts,
                  COALESCE(bar_summary.row_count, 0) AS row_count,
                  COALESCE(bar_summary.rows_since_cutoff, 0) AS rows_since_cutoff,
                  COALESCE(
                    benchmark_summary.expected_rows_since_cutoff,
                    0
                  ) AS expected_rows_since_cutoff,
                  COALESCE(
                    bar_summary.complete_rows_since_cutoff,
                    0
                  ) AS complete_rows_since_cutoff,
                  COALESCE(factor_summary.pe_ttm_count, 0) AS pe_ttm_count,
                  COALESCE(factor_summary.pb_mrq_count, 0) AS pb_mrq_count,
                  COALESCE(factor_summary.ps_ttm_count, 0) AS ps_ttm_count,
                  COALESCE(factor_summary.pcf_ncf_ttm_count, 0) AS pcf_ncf_ttm_count
                FROM target_symbols
                CROSS JOIN benchmark_summary
                CROSS JOIN requested_range
                LEFT JOIN bar_summary
                  ON bar_summary.symbol = target_symbols.symbol
                LEFT JOIN factor_summary
                  ON factor_summary.symbol = target_symbols.symbol
                """,
            (
                symbols,
                timeframe,
                adjustment,
                cutoff,
                end_cutoff,
                end_cutoff,
                end_cutoff,
                cutoff,
                end_cutoff,
                end_cutoff,
                cutoff,
                end_cutoff,
                end_cutoff,
                "amount" in require_fields,
                "turnover" in require_fields,
                "trade_status" in require_fields,
                "is_st" in require_fields,
                "limit_up" in require_fields,
                "limit_down" in require_fields,
                timeframe,
                adjustment,
                cutoff,
                end_cutoff,
                end_cutoff,
                cutoff,
                end_cutoff,
                end_cutoff,
                cutoff,
                end_cutoff,
                end_cutoff,
                cutoff,
                end_cutoff,
                end_cutoff,
            ),
        )
        rows = await cursor.fetchall()

    result: dict[str, IngestionPreflightCoverage] = {}
    for row in rows:
        result[str(row["symbol"])] = IngestionPreflightCoverage(
            symbol=str(row["symbol"]),
            first_ts=row["first_ts"],
            last_ts=row["last_ts"],
            benchmark_last_ts=row["benchmark_last_ts"],
            row_count=int(row["row_count"] or 0),
            rows_since_cutoff=int(row["rows_since_cutoff"] or 0),
            expected_rows_since_cutoff=int(row["expected_rows_since_cutoff"] or 0),
            complete_rows_since_cutoff=int(row["complete_rows_since_cutoff"] or 0),
            pe_ttm_count=int(row["pe_ttm_count"] or 0),
            pb_mrq_count=int(row["pb_mrq_count"] or 0),
            ps_ttm_count=int(row["ps_ttm_count"] or 0),
            pcf_ncf_ttm_count=int(row["pcf_ncf_ttm_count"] or 0),
        )
    return result


async def upsert_kline_response(
    kline: KlineResponse,
    *,
    universe_id: str | None,
    lookback_years: int | None = 5,
    start: str | None = None,
    end: str | None = None,
) -> tuple[str, int, str | None, str | None]:
    symbol = canonical_symbol(kline.symbol, kline.market)
    cutoff = date_cutoff_datetime(start) or lookback_cutoff_datetime(lookback_years)
    end_cutoff = date_cutoff_datetime(end)
    bars: list[tuple[Any, ...]] = []
    factor_rows: list[tuple[Any, ...]] = []
    first_date: str | None = None
    last_date: str | None = None
    for bar in kline.bars:
        if bar.open is None or bar.high is None or bar.low is None or bar.close is None:
            continue
        ts = parse_bar_datetime(bar.date)
        if cutoff is not None and ts < cutoff:
            continue
        if end_cutoff is not None and ts > end_cutoff:
            continue
        first_date = first_date or bar.date
        last_date = bar.date
        bar_metadata = {
            "secid": kline.secid,
            "name": kline.name,
            "market": kline.market,
            "asset_type": kline.asset_type,
            "currency": kline.currency,
            "timezone": kline.timezone,
            "source": kline.source,
            "source_response": kline.metadata,
            "source_bar": bar.metadata,
            "previous_close": (
                str(bar.previous_close) if bar.previous_close is not None else None
            ),
            "amplitude": str(bar.amplitude) if bar.amplitude is not None else None,
            "change_percent": (
                str(bar.change_percent) if bar.change_percent is not None else None
            ),
            "change_amount": (
                str(bar.change_amount) if bar.change_amount is not None else None
            ),
            "turnover": str(bar.turnover) if bar.turnover is not None else None,
            "trade_status": bar.trade_status,
            "is_st": bar.is_st,
            "limit_up": bar.limit_up,
            "limit_down": bar.limit_down,
            "universe_id": universe_id,
        }
        bars.append(
            (
                symbol,
                ts,
                kline.period,
                kline.adjustment,
                bar.open,
                bar.high,
                bar.low,
                bar.close,
                decimal_or_none(bar.previous_close),
                decimal_or_zero(bar.volume),
                decimal_or_none(bar.amount),
                decimal_or_none(bar.amplitude),
                decimal_or_none(bar.change_percent),
                decimal_or_none(bar.change_amount),
                decimal_or_none(bar.turnover),
                bar.trade_status,
                bar.is_st,
                bar.limit_up,
                bar.limit_down,
                kline.source,
                Jsonb(bar_metadata),
            )
        )
        factors = json_object(bar.metadata.get("factors"))
        for factor_key, factor_value in factors.items():
            parsed_factor = decimal_from_json(factor_value)
            if parsed_factor is None:
                continue
            factor_rows.append(
                (
                    symbol,
                    ts,
                    factor_key,
                    float(parsed_factor),
                    kline.source,
                    Jsonb(
                        {
                            "source": kline.source,
                            "source_bar": bar.metadata,
                            "universe_id": universe_id,
                        }
                    ),
                )
            )

    if not bars:
        return symbol, 0, first_date, last_date

    async with await connect() as connection, connection.cursor() as cursor:
        await cursor.execute(
            """
                INSERT INTO quant.securities (
                  symbol, code, name, exchange, asset_type, currency, timezone, secid, provider,
                  metadata, created_at, updated_at
                )
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, now(), now())
                ON CONFLICT (symbol) DO UPDATE SET
                  code = EXCLUDED.code,
                  name = COALESCE(EXCLUDED.name, quant.securities.name),
                  exchange = EXCLUDED.exchange,
                  asset_type = EXCLUDED.asset_type,
                  currency = EXCLUDED.currency,
                  timezone = EXCLUDED.timezone,
                  secid = EXCLUDED.secid,
                  metadata = quant.securities.metadata || EXCLUDED.metadata,
                  updated_at = now()
                """,
            (
                symbol,
                kline.symbol,
                kline.name,
                kline.market,
                kline.asset_type,
                kline.currency,
                kline.timezone,
                kline.secid,
                kline.source,
                Jsonb({"source": kline.source, "fetched_at": kline.fetched_at.isoformat()}),
            ),
        )
        await cursor.executemany(
            """
                INSERT INTO quant.stock_bars (
                  symbol, ts, timeframe, adjustment, open, high, low, close, previous_close,
                  volume, amount, amplitude, change_percent, change_amount, turnover,
                  trade_status, is_st, limit_up, limit_down, provider, metadata, created_at
                )
                VALUES (
                  %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s,
                  %s, %s, %s, now()
                )
                ON CONFLICT (symbol, timeframe, adjustment, ts) DO UPDATE SET
                  open = EXCLUDED.open,
                  high = EXCLUDED.high,
                  low = EXCLUDED.low,
                  close = EXCLUDED.close,
                  previous_close = COALESCE(
                    EXCLUDED.previous_close,
                    quant.stock_bars.previous_close
                  ),
                  volume = EXCLUDED.volume,
                  amount = COALESCE(EXCLUDED.amount, quant.stock_bars.amount),
                  amplitude = COALESCE(EXCLUDED.amplitude, quant.stock_bars.amplitude),
                  change_percent = COALESCE(
                    EXCLUDED.change_percent,
                    quant.stock_bars.change_percent
                  ),
                  change_amount = COALESCE(
                    EXCLUDED.change_amount,
                    quant.stock_bars.change_amount
                  ),
                  turnover = COALESCE(EXCLUDED.turnover, quant.stock_bars.turnover),
                  trade_status = COALESCE(EXCLUDED.trade_status, quant.stock_bars.trade_status),
                  is_st = COALESCE(EXCLUDED.is_st, quant.stock_bars.is_st),
                  limit_up = COALESCE(EXCLUDED.limit_up, quant.stock_bars.limit_up),
                  limit_down = COALESCE(EXCLUDED.limit_down, quant.stock_bars.limit_down),
                  provider = CASE
                    WHEN EXCLUDED.amount IS NULL
                     AND EXCLUDED.turnover IS NULL
                     AND (
                       quant.stock_bars.amount IS NOT NULL
                       OR quant.stock_bars.turnover IS NOT NULL
                     )
                    THEN quant.stock_bars.provider
                    ELSE EXCLUDED.provider
                  END,
                  metadata = quant.stock_bars.metadata || jsonb_strip_nulls(EXCLUDED.metadata)
            """,
            bars,
        )
        if factor_rows:
            await cursor.executemany(
                """
                    INSERT INTO quant.stock_factors (
                      symbol, ts, factor_key, factor_value, provider, metadata, created_at
                    )
                    VALUES (%s, %s, %s, %s, %s, %s, now())
                    ON CONFLICT (symbol, factor_key, ts) DO UPDATE SET
                      factor_value = EXCLUDED.factor_value,
                      provider = EXCLUDED.provider,
                      metadata = quant.stock_factors.metadata || EXCLUDED.metadata
                    """,
                factor_rows,
            )
        await cursor.execute(
            """
                INSERT INTO quant.market_data_sync_state (
                  symbol, timeframe, adjustment, provider, first_ts, last_ts, row_count,
                  last_success_at, last_error, metadata, created_at, updated_at
                )
                SELECT
                  %s,
                  %s,
                  %s,
                  %s,
                  min(ts),
                  max(ts),
                  count(*)::INT,
                  now(),
                  NULL,
                  %s,
                  now(),
                  now()
                FROM quant.stock_bars
                WHERE symbol = %s
                  AND timeframe = %s
                  AND adjustment = %s
                  AND provider = %s
                ON CONFLICT (symbol, timeframe, adjustment, provider) DO UPDATE SET
                  first_ts = EXCLUDED.first_ts,
                  last_ts = EXCLUDED.last_ts,
                  row_count = EXCLUDED.row_count,
                  last_success_at = now(),
                  last_error = NULL,
                  metadata = quant.market_data_sync_state.metadata || EXCLUDED.metadata,
                  updated_at = now()
                """,
            (
                symbol,
                kline.period,
                kline.adjustment,
                kline.source,
                Jsonb({"name": kline.name, "secid": kline.secid, "universe_id": universe_id}),
                symbol,
                kline.period,
                kline.adjustment,
                kline.source,
            ),
        )

    return symbol, len(bars), first_date, last_date


async def upsert_realtime_quote_snapshot(
    quote: RealtimeQuote,
    *,
    universe_id: str | None,
    trade_date: date | str | None = None,
    adjustment: str = "qfq",
) -> tuple[str, int, str | None, str | None]:
    if quote.open is None or quote.high is None or quote.low is None or quote.price is None:
        return canonical_symbol(quote.symbol, quote.market), 0, None, None

    local_trade_date = (
        date.fromisoformat(trade_date)
        if isinstance(trade_date, str)
        else trade_date
        if trade_date is not None
        else (quote.quote_time or quote.fetched_at).astimezone(SHANGHAI_TZ).date()
    )
    ts = trade_date_datetime(local_trade_date)
    symbol = canonical_symbol(quote.symbol, quote.market)
    change_amount = quote.change_amount or decimal_subtract(quote.price, quote.previous_close)
    amplitude = quote.amplitude or amplitude_percent(quote.high, quote.low, quote.previous_close)
    bar_metadata = {
        "secid": quote.secid,
        "name": quote.name,
        "market": quote.market,
        "asset_type": quote.asset_type,
        "currency": quote.currency,
        "timezone": quote.timezone,
        "source": quote.source,
        "market_cap": str(quote.market_cap) if quote.market_cap is not None else None,
        "float_market_cap": (
            str(quote.float_market_cap) if quote.float_market_cap is not None else None
        ),
        "source_bar": {
            "quote_time": quote.quote_time.isoformat() if quote.quote_time else None,
            "fetched_at": quote.fetched_at.isoformat(),
            "price": str(quote.price) if quote.price is not None else None,
            "previous_close": (
                str(quote.previous_close) if quote.previous_close is not None else None
            ),
            "amplitude": str(amplitude) if amplitude is not None else None,
            "change_percent": (
                str(quote.change_percent) if quote.change_percent is not None else None
            ),
            "change_amount": str(change_amount) if change_amount is not None else None,
            "turnover": str(quote.turnover) if quote.turnover is not None else None,
            "market_cap": str(quote.market_cap) if quote.market_cap is not None else None,
            "float_market_cap": (
                str(quote.float_market_cap) if quote.float_market_cap is not None else None
            ),
        },
        "previous_close": str(quote.previous_close) if quote.previous_close is not None else None,
        "amplitude": str(amplitude) if amplitude is not None else None,
        "change_percent": str(quote.change_percent) if quote.change_percent is not None else None,
        "change_amount": str(change_amount) if change_amount is not None else None,
        "turnover": str(quote.turnover) if quote.turnover is not None else None,
        "universe_id": universe_id,
        "ingestion_mode": "realtime_snapshot",
    }

    async with await connect() as connection, connection.cursor() as cursor:
        await cursor.execute(
            """
                INSERT INTO quant.securities (
                  symbol, code, name, exchange, asset_type, currency, timezone,
                  secid, provider, metadata, created_at, updated_at
                )
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, now(), now())
                ON CONFLICT (symbol) DO UPDATE SET
                  code = EXCLUDED.code,
                  name = COALESCE(EXCLUDED.name, quant.securities.name),
                  exchange = EXCLUDED.exchange,
                  asset_type = EXCLUDED.asset_type,
                  currency = EXCLUDED.currency,
                  timezone = EXCLUDED.timezone,
                  secid = EXCLUDED.secid,
                  metadata = quant.securities.metadata || EXCLUDED.metadata,
                  updated_at = now()
                """,
            (
                symbol,
                quote.symbol,
                quote.name,
                quote.market,
                quote.asset_type,
                quote.currency,
                quote.timezone,
                quote.secid,
                quote.source,
                Jsonb(
                    {
                        "source": quote.source,
                        "fetched_at": quote.fetched_at.isoformat(),
                        "latest_quote": {
                            "quote_time": (
                                quote.quote_time.isoformat() if quote.quote_time else None
                            ),
                            "price": str(quote.price) if quote.price is not None else None,
                            "previous_close": (
                                str(quote.previous_close)
                                if quote.previous_close is not None
                                else None
                            ),
                            "change_percent": (
                                str(quote.change_percent)
                                if quote.change_percent is not None
                                else None
                            ),
                            "change_amount": (
                                str(change_amount) if change_amount is not None else None
                            ),
                            "turnover": (
                                str(quote.turnover) if quote.turnover is not None else None
                            ),
                            "amount": str(quote.amount) if quote.amount is not None else None,
                            "volume": quote.volume,
                        },
                        "market_cap": (
                            str(quote.market_cap) if quote.market_cap is not None else None
                        ),
                        "float_market_cap": (
                            str(quote.float_market_cap)
                            if quote.float_market_cap is not None
                            else None
                        ),
                    }
                ),
            ),
        )
        await cursor.execute(
            """
                INSERT INTO quant.stock_bars (
                  symbol, ts, timeframe, adjustment, open, high, low, close, previous_close,
                  volume, amount, amplitude, change_percent, change_amount, turnover,
                  trade_status, is_st, limit_up, limit_down, provider, metadata, created_at
                )
                VALUES (
                  %s, %s, 'daily', %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s,
                  NULL, NULL, NULL, NULL, %s, %s, now()
                )
                ON CONFLICT (symbol, timeframe, adjustment, ts) DO UPDATE SET
                  open = EXCLUDED.open,
                  high = EXCLUDED.high,
                  low = EXCLUDED.low,
                  close = EXCLUDED.close,
                  previous_close = COALESCE(
                    EXCLUDED.previous_close,
                    quant.stock_bars.previous_close
                  ),
                  volume = EXCLUDED.volume,
                  amount = COALESCE(EXCLUDED.amount, quant.stock_bars.amount),
                  amplitude = COALESCE(EXCLUDED.amplitude, quant.stock_bars.amplitude),
                  change_percent = COALESCE(
                    EXCLUDED.change_percent,
                    quant.stock_bars.change_percent
                  ),
                  change_amount = COALESCE(EXCLUDED.change_amount, quant.stock_bars.change_amount),
                  turnover = COALESCE(EXCLUDED.turnover, quant.stock_bars.turnover),
                  provider = EXCLUDED.provider,
                  metadata = quant.stock_bars.metadata || jsonb_strip_nulls(EXCLUDED.metadata)
                """,
            (
                symbol,
                ts,
                adjustment,
                quote.open,
                quote.high,
                quote.low,
                quote.price,
                decimal_or_none(quote.previous_close),
                decimal_or_zero(quote.volume),
                decimal_or_none(quote.amount),
                decimal_or_none(amplitude),
                decimal_or_none(quote.change_percent),
                decimal_or_none(change_amount),
                decimal_or_none(quote.turnover),
                quote.source,
                Jsonb(bar_metadata),
            ),
        )
        await cursor.execute(
            """
                INSERT INTO quant.market_data_sync_state (
                  symbol, timeframe, adjustment, provider, first_ts, last_ts, row_count,
                  last_success_at, last_error, metadata, created_at, updated_at
                )
                SELECT
                  %s,
                  'daily',
                  %s,
                  %s,
                  min(ts),
                  max(ts),
                  count(*)::INT,
                  now(),
                  NULL,
                  %s,
                  now(),
                  now()
                FROM quant.stock_bars
                WHERE symbol = %s
                  AND timeframe = 'daily'
                  AND adjustment = %s
                  AND provider = %s
                ON CONFLICT (symbol, timeframe, adjustment, provider) DO UPDATE SET
                  first_ts = EXCLUDED.first_ts,
                  last_ts = EXCLUDED.last_ts,
                  row_count = EXCLUDED.row_count,
                  last_success_at = now(),
                  last_error = NULL,
                  metadata = quant.market_data_sync_state.metadata || EXCLUDED.metadata,
                  updated_at = now()
                """,
            (
                symbol,
                adjustment,
                quote.source,
                Jsonb({"name": quote.name, "secid": quote.secid, "universe_id": universe_id}),
                symbol,
                adjustment,
                quote.source,
            ),
        )

    trade_date_text = local_trade_date.isoformat()
    return symbol, 1, trade_date_text, trade_date_text
