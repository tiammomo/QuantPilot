from __future__ import annotations

from datetime import UTC, datetime
from decimal import ROUND_HALF_UP, Decimal

from quantpilot_market_data.models import (
    FinancialReportItem,
    FundamentalIndicatorPoint,
    FundamentalIndicatorsResponse,
    FundamentalIndicatorSummary,
)


def _round(value: Decimal | None, places: int = 4) -> Decimal | None:
    if value is None:
        return None
    quant = Decimal("1").scaleb(-places)
    return value.quantize(quant, rounding=ROUND_HALF_UP)


def _mean(values: list[Decimal]) -> Decimal | None:
    if not values:
        return None
    return sum(values, Decimal("0")) / Decimal(len(values))


def _net_margin(report: FinancialReportItem) -> Decimal | None:
    if report.parent_net_profit is None or report.revenue is None or report.revenue == 0:
        return None
    return (report.parent_net_profit / report.revenue) * Decimal("100")


def build_fundamental_indicators(
    symbol: str,
    reports: list[FinancialReportItem],
) -> FundamentalIndicatorsResponse:
    points = [
        FundamentalIndicatorPoint(
            report_date=report.report_date,
            data_type=report.data_type,
            revenue=report.revenue,
            parent_net_profit=report.parent_net_profit,
            revenue_yoy=report.revenue_yoy,
            net_profit_yoy=report.net_profit_yoy,
            gross_margin=report.gross_margin,
            weighted_roe=report.weighted_roe,
            net_margin=_round(_net_margin(report), 4),
        )
        for report in reports
    ]

    latest = points[0] if points else None
    roe_values = [point.weighted_roe for point in points if point.weighted_roe is not None]
    gross_margin_values = [point.gross_margin for point in points if point.gross_margin is not None]
    net_margin_values = [point.net_margin for point in points if point.net_margin is not None]
    fetched_at = (
        reports[0].notice_date or reports[0].report_date
        if reports
        else datetime.now(UTC)
    )

    summary = FundamentalIndicatorSummary(
        latest_report_date=latest.report_date if latest else None,
        latest_revenue=latest.revenue if latest else None,
        latest_parent_net_profit=latest.parent_net_profit if latest else None,
        latest_revenue_yoy=latest.revenue_yoy if latest else None,
        latest_net_profit_yoy=latest.net_profit_yoy if latest else None,
        latest_gross_margin=latest.gross_margin if latest else None,
        latest_weighted_roe=latest.weighted_roe if latest else None,
        latest_net_margin=latest.net_margin if latest else None,
        avg_roe=_round(_mean(roe_values), 4),
        avg_gross_margin=_round(_mean(gross_margin_values), 4),
        avg_net_margin=_round(_mean(net_margin_values), 4),
        report_count=len(points),
    )

    return FundamentalIndicatorsResponse(
        symbol=symbol,
        points=points,
        summary=summary,
        as_of=summary.latest_report_date,
        fetched_at=fetched_at or datetime.now(UTC),
    )
