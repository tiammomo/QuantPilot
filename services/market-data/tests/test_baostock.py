from __future__ import annotations

import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from decimal import Decimal
from types import ModuleType, SimpleNamespace

import pytest

from quantpilot_market_data.providers.baostock import (
    BaoStockError,
    baostock_code,
    baostock_volume_hands,
    close_baostock_session,
    fetch_baostock_history_records,
    fetch_baostock_trade_dates,
    is_a_share_stock_code,
    limit_marker_from_pct,
    parse_baostock_records,
    parse_baostock_trade_dates,
)


class FakeHistoryResult:
    def __init__(
        self,
        *,
        rows: list[list[str]] | None = None,
        fields: list[str] | None = None,
        error_code: str = "0",
        error_msg: str = "",
    ) -> None:
        self.error_code = error_code
        self.error_msg = error_msg
        self.fields = fields or ["date", "code", "close"]
        self._rows = list(rows or [])
        self._index = -1

    def next(self) -> bool:
        self._index += 1
        return self._index < len(self._rows)

    def get_row_data(self) -> list[str]:
        return self._rows[self._index]


def install_fake_baostock(
    monkeypatch: pytest.MonkeyPatch,
    *,
    login_responses: list[object] | None = None,
    query_responses: list[object] | None = None,
    calendar_responses: list[object] | None = None,
    query_delay: float = 0,
) -> SimpleNamespace:
    module = ModuleType("baostock")
    logins = list(login_responses or [])
    queries = list(query_responses or [])
    calendar_queries = list(calendar_responses or [])
    state = SimpleNamespace(
        login_calls=0,
        logout_calls=0,
        query_calls=0,
        calendar_query_calls=0,
        active_queries=0,
        max_active_queries=0,
        lock=threading.Lock(),
    )

    def login():
        state.login_calls += 1
        response = logins.pop(0) if logins else SimpleNamespace(error_code="0", error_msg="")
        if isinstance(response, BaseException):
            raise response
        return response

    def logout():
        state.logout_calls += 1
        return SimpleNamespace(error_code="0", error_msg="")

    def query_history_k_data_plus(*args, **kwargs):
        state.query_calls += 1
        with state.lock:
            state.active_queries += 1
            state.max_active_queries = max(state.max_active_queries, state.active_queries)
        try:
            if query_delay:
                time.sleep(query_delay)
            response = queries.pop(0) if queries else FakeHistoryResult()
            if isinstance(response, BaseException):
                raise response
            return response
        finally:
            with state.lock:
                state.active_queries -= 1

    def query_trade_dates(*args, **kwargs):
        state.calendar_query_calls += 1
        response = (
            calendar_queries.pop(0)
            if calendar_queries
            else FakeHistoryResult(fields=["calendar_date", "is_trading_day"])
        )
        if isinstance(response, BaseException):
            raise response
        return response

    module.login = login  # type: ignore[attr-defined]
    module.logout = logout  # type: ignore[attr-defined]
    module.query_history_k_data_plus = query_history_k_data_plus  # type: ignore[attr-defined]
    module.query_trade_dates = query_trade_dates  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "baostock", module)
    return state


@pytest.fixture(autouse=True)
def reset_shared_baostock_session():
    close_baostock_session()
    yield
    close_baostock_session()


def fetch_records() -> list[dict[str, object]]:
    return fetch_baostock_history_records(
        "sh.600519",
        "d",
        "2026-06-01",
        "2026-06-15",
        "2",
    )


def test_baostock_session_login_is_reused(monkeypatch: pytest.MonkeyPatch) -> None:
    state = install_fake_baostock(
        monkeypatch,
        query_responses=[
            FakeHistoryResult(rows=[["2026-06-13", "sh.600519", "1500"]]),
            FakeHistoryResult(rows=[["2026-06-15", "sh.600519", "1510"]]),
        ],
    )

    first = fetch_records()
    second = fetch_records()

    assert first[0]["date"] == "2026-06-13"
    assert second[0]["date"] == "2026-06-15"
    assert state.login_calls == 1
    assert state.query_calls == 2
    assert state.logout_calls == 0


def test_trade_calendar_reuses_session_and_maps_open_closed_days(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    state = install_fake_baostock(
        monkeypatch,
        query_responses=[
            FakeHistoryResult(rows=[["2026-07-13", "sh.600519", "1510"]])
        ],
        calendar_responses=[
            FakeHistoryResult(
                fields=["calendar_date", "is_trading_day"],
                rows=[
                    ["2026-07-12", "0"],
                    ["2026-07-13", "1"],
                ],
            )
        ],
    )

    fetch_records()
    days = fetch_baostock_trade_dates("2026-07-12", "2026-07-13")

    assert [(day.trade_date.isoformat(), day.is_open) for day in days] == [
        ("2026-07-12", False),
        ("2026-07-13", True),
    ]
    assert {day.market for day in days} == {"CN-A"}
    assert {day.session for day in days} == {"regular"}
    assert {day.source for day in days} == {"baostock"}
    assert state.login_calls == 1
    assert state.query_calls == 1
    assert state.calendar_query_calls == 1


def test_trade_calendar_rejects_invalid_provider_flag() -> None:
    with pytest.raises(
        BaoStockError,
        match=r"is_trading_day='yes'",
    ):
        parse_baostock_trade_dates(
            [{"calendar_date": "2026-07-13", "is_trading_day": "yes"}]
        )


def test_second_query_disconnect_reconnects_once(monkeypatch: pytest.MonkeyPatch) -> None:
    state = install_fake_baostock(
        monkeypatch,
        query_responses=[
            FakeHistoryResult(rows=[["2026-06-13", "sh.600519", "1500"]]),
            FakeHistoryResult(error_code="10001001", error_msg="网络接收错误"),
            FakeHistoryResult(rows=[["2026-06-15", "sh.600519", "1510"]]),
        ],
    )

    fetch_records()
    recovered = fetch_records()

    assert recovered[0]["date"] == "2026-06-15"
    assert state.login_calls == 2
    assert state.query_calls == 3
    assert state.logout_calls == 1


def test_failed_login_cleans_partial_socket_before_retry(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    state = install_fake_baostock(
        monkeypatch,
        login_responses=[
            SimpleNamespace(error_code="10002007", error_msg="网络接收错误"),
            SimpleNamespace(error_code="0", error_msg=""),
        ],
        query_responses=[
            FakeHistoryResult(rows=[["2026-06-15", "sh.600519", "1510"]])
        ],
    )

    recovered = fetch_records()

    assert recovered[0]["date"] == "2026-06-15"
    assert state.login_calls == 2
    assert state.logout_calls == 1


def test_query_failure_after_retry_preserves_error_contract(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    state = install_fake_baostock(
        monkeypatch,
        query_responses=[
            FakeHistoryResult(error_code="10001001", error_msg="第一次网络接收错误"),
            ConnectionError("第二次 socket 已断开"),
        ],
    )

    with pytest.raises(
        BaoStockError,
        match=r"^Baostock 历史行情请求失败：第二次 socket 已断开（已重连重试 1 次）$",
    ):
        fetch_records()

    assert state.login_calls == 2
    assert state.query_calls == 2
    assert state.logout_calls == 2


def test_baostock_global_socket_queries_are_serialized(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    state = install_fake_baostock(
        monkeypatch,
        query_responses=[FakeHistoryResult(), FakeHistoryResult()],
        query_delay=0.02,
    )

    with ThreadPoolExecutor(max_workers=2) as executor:
        results = list(executor.map(lambda _: fetch_records(), range(2)))

    assert results == [[], []]
    assert state.login_calls == 1
    assert state.query_calls == 2
    assert state.max_active_queries == 1


def test_close_baostock_session_is_idempotent(monkeypatch: pytest.MonkeyPatch) -> None:
    state = install_fake_baostock(
        monkeypatch,
        query_responses=[FakeHistoryResult()],
    )
    fetch_records()

    close_baostock_session()
    close_baostock_session()

    assert state.logout_calls == 1


def test_baostock_code_normalizes_common_a_share_codes() -> None:
    assert baostock_code("002156.SZ") == "sz.002156"
    assert baostock_code("1.600519") == "sh.600519"
    assert baostock_code("SH600519") == "sh.600519"


def test_baostock_volume_is_converted_from_shares_to_hands() -> None:
    assert baostock_volume_hands({"volume": "198689180"}) == 1986892


def test_parse_baostock_records_maps_enrichment_fields() -> None:
    bars = parse_baostock_records(
        [
            {
                "date": "2026-05-28",
                "code": "sz.002156",
                "open": "69.50",
                "high": "70.88",
                "low": "67.60",
                "close": "69.30",
                "preclose": "71.44",
                "volume": "196100000",
                "amount": "136200000.50",
                "turn": "1.72",
                "pctChg": "-2.9969",
                "tradestatus": "1",
                "isST": "0",
                "peTTM": "65.346712",
                "pbMRQ": "6.036094",
            }
        ]
    )

    assert len(bars) == 1
    assert bars[0].date == "2026-05-28"
    assert bars[0].volume == 1961000
    assert bars[0].amount == Decimal("136200000.50")
    assert bars[0].turnover == Decimal("1.72")
    assert bars[0].change_percent == Decimal("-2.9969")
    assert bars[0].change_amount == Decimal("-2.14")
    assert bars[0].amplitude == Decimal("4.59126540")
    assert bars[0].previous_close == Decimal("71.44")
    assert bars[0].trade_status == "1"
    assert bars[0].is_st is False
    assert bars[0].limit_up is False
    assert bars[0].limit_down is False
    assert bars[0].metadata["factors"]["pe_ttm"] == "65.346712"
    assert bars[0].metadata["factors"]["pb_mrq"] == "6.036094"
    assert bars[0].metadata["volume_unit"] == "hands"


def test_limit_marker_uses_a_share_board_thresholds() -> None:
    assert (
        limit_marker_from_pct(code="sz.002156", change_percent=Decimal("9.91"), is_st=False)
        == "up"
    )
    assert (
        limit_marker_from_pct(code="sz.300750", change_percent=Decimal("10.01"), is_st=False)
        is None
    )
    assert (
        limit_marker_from_pct(code="sz.300750", change_percent=Decimal("20.01"), is_st=False)
        == "up"
    )
    assert (
        limit_marker_from_pct(code="sh.600745", change_percent=Decimal("-4.96"), is_st=True)
        == "down"
    )


def test_baostock_ignores_etf_is_st_flag() -> None:
    assert is_a_share_stock_code("sh.510300") is False
    bars = parse_baostock_records(
        [
            {
                "date": "2026-05-28",
                "code": "sh.510300",
                "open": "4.85",
                "high": "4.90",
                "low": "4.80",
                "close": "4.88",
                "preclose": "4.86",
                "volume": "100000",
                "amount": "488000.00",
                "turn": "0.12",
                "pctChg": "0.41",
                "tradestatus": "1",
                "isST": "1",
            }
        ]
    )
    assert bars[0].is_st is False
