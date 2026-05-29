from __future__ import annotations

from decimal import Decimal

from quantpilot_market_data.providers.akshare import (
    akshare_symbol,
    parse_akshare_hist_records,
)


def test_akshare_symbol_normalizes_common_a_share_codes() -> None:
    assert akshare_symbol("002156.SZ") == "002156"
    assert akshare_symbol("1.600519") == "600519"
    assert akshare_symbol("SH600519") == "600519"


def test_parse_akshare_hist_records_maps_enrichment_fields() -> None:
    bars = parse_akshare_hist_records(
        [
            {
                "日期": "2026-05-28",
                "开盘": 69.50,
                "收盘": 69.30,
                "最高": 70.88,
                "最低": 67.60,
                "成交量": 1961000,
                "成交额": 136200000.5,
                "振幅": 4.61,
                "涨跌幅": -2.99,
                "涨跌额": -2.14,
                "换手率": 1.72,
            }
        ]
    )

    assert len(bars) == 1
    assert bars[0].date == "2026-05-28"
    assert bars[0].open == Decimal("69.5")
    assert bars[0].amount == Decimal("136200000.5")
    assert bars[0].amplitude == Decimal("4.61")
    assert bars[0].change_percent == Decimal("-2.99")
    assert bars[0].change_amount == Decimal("-2.14")
    assert bars[0].turnover == Decimal("1.72")
    assert bars[0].metadata["source"] == "akshare"
    assert bars[0].metadata["fields"]["turnover"] == "1.72"
