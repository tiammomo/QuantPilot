from __future__ import annotations

from datetime import UTC, date, datetime, timedelta
from decimal import Decimal
from typing import Any

from psycopg.rows import dict_row

from quantpilot_market_data.cache import RedisJsonCache
from quantpilot_market_data.database_core import (
    bool_or_none,
    connect,
    decimal_or_none,
    percent_change,
    security_sector_fields,
)
from quantpilot_market_data.models import (
    SectorCapitalFlowDetail,
    SectorCapitalFlowItem,
    SectorCapitalFlowMarketSummary,
    SectorCapitalFlowMember,
    SectorCapitalFlowTrendPoint,
)

DEFAULT_UNIVERSE_ID = "a-share-sample-research-pool"
SECTOR_CAPITAL_FLOW_CACHE_TTL_SECONDS = 300
_SECTOR_CAPITAL_FLOW_CACHE: dict[tuple[str, int, str], tuple[datetime, dict[str, Any]]] = {}
_SECTOR_CAPITAL_FLOW_REDIS_CACHE = RedisJsonCache()

__all__ = ["build_sector_capital_flow_detail", "list_sector_capital_flow"]


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
                AND COALESCE(members.role, 'member') <> 'inactive'
                AND COALESCE(securities.status, 'active') NOT IN ('inactive', 'delisted')
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
