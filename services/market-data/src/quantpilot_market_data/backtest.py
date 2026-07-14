from __future__ import annotations

from datetime import UTC, datetime
from decimal import ROUND_HALF_UP, Decimal
from math import sqrt
from typing import Any

from quantpilot_market_data.models import (
    BacktestEquityPoint,
    BacktestResponse,
    BacktestSummary,
    BacktestTrade,
    KlineResponse,
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


def _rolling_mean(closes: list[Decimal | None], end_index: int, window: int) -> Decimal | None:
    if end_index + 1 < window:
        return None
    values = closes[end_index + 1 - window : end_index + 1]
    if any(value is None for value in values):
        return None
    return _mean([value for value in values if value is not None])


def _rolling_high(values: list[Decimal | None], end_index: int, window: int) -> Decimal | None:
    if end_index < 0 or end_index + 1 < window:
        return None
    sample = values[end_index + 1 - window : end_index + 1]
    if any(value is None for value in sample):
        return None
    return max(value for value in sample if value is not None)


def _rolling_low(values: list[Decimal | None], end_index: int, window: int) -> Decimal | None:
    if end_index < 0 or end_index + 1 < window:
        return None
    sample = values[end_index + 1 - window : end_index + 1]
    if any(value is None for value in sample):
        return None
    return min(value for value in sample if value is not None)


def _rolling_std(values: list[Decimal | None], end_index: int, window: int) -> Decimal | None:
    if end_index + 1 < window:
        return None
    sample = values[end_index + 1 - window : end_index + 1]
    if any(value is None for value in sample):
        return None
    clean = [value for value in sample if value is not None]
    mean = _mean(clean)
    if mean is None:
        return None
    variance = sum((value - mean) ** 2 for value in clean) / Decimal(len(clean))
    return Decimal(str(sqrt(float(variance))))


def _rolling_volume_mean(
    values: list[int | None],
    end_index: int,
    window: int,
) -> Decimal | None:
    if end_index + 1 < window:
        return None
    sample = values[end_index + 1 - window : end_index + 1]
    if any(value is None for value in sample):
        return None
    clean = [Decimal(value) for value in sample if value is not None]
    return _mean(clean)


def _rsi(closes: list[Decimal | None], end_index: int, window: int) -> Decimal | None:
    if end_index < window:
        return None
    gains: list[Decimal] = []
    losses: list[Decimal] = []
    for index in range(end_index - window + 1, end_index + 1):
        current = closes[index]
        previous = closes[index - 1]
        if current is None or previous is None:
            return None
        change = current - previous
        if change >= 0:
            gains.append(change)
            losses.append(Decimal("0"))
        else:
            gains.append(Decimal("0"))
            losses.append(abs(change))
    average_gain = _mean(gains)
    average_loss = _mean(losses)
    if average_gain is None or average_loss is None:
        return None
    if average_loss == 0:
        return Decimal("100")
    relative_strength = average_gain / average_loss
    return Decimal("100") - (Decimal("100") / (Decimal("1") + relative_strength))


def _true_range(
    high: Decimal | None,
    low: Decimal | None,
    previous_close: Decimal | None,
) -> Decimal | None:
    if high is None or low is None:
        return None
    if previous_close is None:
        return high - low
    return max(high - low, abs(high - previous_close), abs(low - previous_close))


def _atr(
    highs: list[Decimal | None],
    lows: list[Decimal | None],
    closes: list[Decimal | None],
    end_index: int,
    window: int,
) -> Decimal | None:
    if end_index + 1 < window:
        return None
    ranges: list[Decimal] = []
    for index in range(end_index + 1 - window, end_index + 1):
        value = _true_range(
            highs[index],
            lows[index],
            closes[index - 1] if index > 0 else None,
        )
        if value is None:
            return None
        ranges.append(value)
    return _mean(ranges)


def _rolling_return_pct(
    closes: list[Decimal | None],
    end_index: int,
    window: int,
) -> Decimal | None:
    if end_index < window:
        return None
    return _return_pct(closes[end_index], closes[end_index - window])


def _annualized_price_volatility_pct(
    closes: list[Decimal | None],
    end_index: int,
    window: int,
) -> Decimal | None:
    if end_index < window:
        return None
    returns: list[Decimal] = []
    for index in range(end_index - window + 1, end_index + 1):
        value = _return_pct(closes[index], closes[index - 1])
        if value is None:
            return None
        returns.append(value)
    return _annualized_volatility_pct(returns)


def _return_pct(current: Decimal | None, previous: Decimal | None) -> Decimal | None:
    if current is None or previous is None or previous == 0:
        return None
    return ((current - previous) / previous) * Decimal("100")


def _annualized_return_pct(final_equity: Decimal, sample_count: int) -> Decimal | None:
    if sample_count <= 1 or final_equity <= 0:
        return None
    value = (float(final_equity) ** (252 / (sample_count - 1)) - 1) * 100
    return Decimal(str(value))


def _annualized_volatility_pct(returns: list[Decimal]) -> Decimal | None:
    if len(returns) < 2:
        return None
    mean_return = _mean(returns)
    if mean_return is None:
        return None
    variance = sum((value - mean_return) ** 2 for value in returns) / Decimal(len(returns))
    return Decimal(str(sqrt(float(variance)))) * Decimal(str(sqrt(252)))


def _safe_decimal(value: int | float | Decimal | str) -> Decimal:
    return value if isinstance(value, Decimal) else Decimal(str(value))


def _int_param(
    parameters: dict[str, Any],
    key: str,
    default: int,
    *,
    minimum: int = 1,
    maximum: int = 300,
) -> int:
    try:
        value = int(Decimal(str(parameters.get(key, default))))
    except Exception:
        value = default
    return max(minimum, min(maximum, value))


def _decimal_param(
    parameters: dict[str, Any],
    key: str,
    default: Decimal | int | str,
    *,
    minimum: Decimal | int | str | None = None,
    maximum: Decimal | int | str | None = None,
) -> Decimal:
    try:
        value = Decimal(str(parameters.get(key, default)))
    except Exception:
        value = Decimal(str(default))
    if minimum is not None:
        value = max(Decimal(str(minimum)), value)
    if maximum is not None:
        value = min(Decimal(str(maximum)), value)
    return value


def _canonical_strategy_id(strategy_id: str) -> str:
    normalized = strategy_id.strip().lower().replace("-", "_")
    aliases = {
        "ma": "ma_crossover",
        "ma_cross": "ma_crossover",
        "moving_average_crossover": "ma_crossover",
        "donchian": "donchian_breakout",
        "turtle": "turtle_trend",
        "rsi": "rsi_reversion",
        "bollinger": "bollinger_reversion",
        "momentum": "momentum_trend",
        "volume_breakout": "volume_price_breakout",
        "atr_breakout": "atr_trailing_breakout",
        "low_vol": "low_volatility_trend",
        "pullback": "ma_pullback_reclaim",
        "gap": "gap_reversal",
    }
    return aliases.get(normalized, normalized)


STRATEGY_NAMES = {
    "ma_crossover": "均线交叉趋势",
    "donchian_breakout": "Donchian 通道突破",
    "turtle_trend": "海龟中期趋势",
    "volume_price_breakout": "放量价格突破",
    "atr_trailing_breakout": "ATR 突破追踪",
    "rsi_reversion": "RSI 回撤反转",
    "bollinger_reversion": "布林带均值回归",
    "momentum_trend": "动量趋势过滤",
    "low_volatility_trend": "低波动趋势持有",
    "ma_pullback_reclaim": "均线回踩再启动",
    "gap_reversal": "跳空回补反转",
}


def build_ma_crossover_backtest(
    kline: KlineResponse,
    *,
    fast_window: int = 20,
    slow_window: int = 60,
    initial_cash: Decimal | int | float | str = Decimal("1"),
    fee_bps: Decimal | int | float | str = Decimal("5"),
) -> BacktestResponse:
    return build_strategy_backtest(
        kline,
        strategy_id="ma_crossover",
        parameters={
            "fast_window": fast_window,
            "slow_window": slow_window,
            "fee_bps": fee_bps,
        },
        initial_cash=initial_cash,
        fee_bps=fee_bps,
    )


def build_strategy_backtest(
    kline: KlineResponse,
    *,
    strategy_id: str,
    parameters: dict[str, Any] | None = None,
    initial_cash: Decimal | int | float | str = Decimal("1"),
    fee_bps: Decimal | int | float | str = Decimal("5"),
) -> BacktestResponse:
    params = dict(parameters or {})
    normalized_strategy_id = _canonical_strategy_id(strategy_id)
    if normalized_strategy_id not in STRATEGY_NAMES:
        raise ValueError(f"暂不支持的策略：{strategy_id}")

    if normalized_strategy_id == "ma_crossover":
        fast_window = _int_param(params, "fast_window", 20, minimum=2, maximum=120)
        slow_window = _int_param(params, "slow_window", 60, minimum=3, maximum=250)
        if fast_window >= slow_window:
            raise ValueError("fast_window 必须小于 slow_window。")
    elif normalized_strategy_id == "turtle_trend":
        fast_window = _int_param(params, "breakout_window", 55, minimum=5, maximum=250)
        slow_window = _int_param(params, "exit_window", 20, minimum=3, maximum=120)
    else:
        fast_window = _int_param(
            params,
            "fast_window",
            _int_param(params, "lookback_window", _int_param(params, "breakout_window", 20)),
            minimum=2,
            maximum=250,
        )
        slow_window = _int_param(
            params,
            "slow_window",
            _int_param(params, "trend_window", _int_param(params, "exit_window", 60)),
            minimum=2,
            maximum=300,
        )

    params["fee_bps"] = str(fee_bps)
    cash = _safe_decimal(initial_cash)
    if cash <= 0:
        raise ValueError("initial_cash 必须大于 0。")

    fee_rate = _safe_decimal(fee_bps) / Decimal("10000")
    closes = [bar.close for bar in kline.bars]
    highs = [bar.high for bar in kline.bars]
    lows = [bar.low for bar in kline.bars]
    opens = [bar.open for bar in kline.bars]
    volumes = [bar.volume for bar in kline.bars]
    equity = cash
    peak_equity = cash
    position = 0
    trades: list[BacktestTrade] = []
    current_trade: BacktestTrade | None = None
    equity_curve: list[BacktestEquityPoint] = []
    strategy_returns: list[Decimal] = []
    position_days = 0
    entry_index: int | None = None
    highest_close_since_entry: Decimal | None = None

    for index, bar in enumerate(kline.bars):
        close = bar.close
        previous_close = closes[index - 1] if index > 0 else None
        primary_indicator: Decimal | None = None
        secondary_indicator: Decimal | None = None
        benchmark_return = _return_pct(close, previous_close)
        strategy_return = Decimal("0")
        if position == 1 and benchmark_return is not None:
            strategy_return = benchmark_return / Decimal("100")
            equity *= Decimal("1") + strategy_return
            position_days += 1
            if close is not None:
                highest_close_since_entry = (
                    close
                    if highest_close_since_entry is None
                    else max(highest_close_since_entry, close)
                )

        enter_signal = False
        exit_signal = False

        if normalized_strategy_id == "ma_crossover":
            primary_indicator = _rolling_mean(closes, index, fast_window)
            secondary_indicator = _rolling_mean(closes, index, slow_window)
            previous_fast_ma = (
                _rolling_mean(closes, index - 1, fast_window) if index > 0 else None
            )
            previous_slow_ma = (
                _rolling_mean(closes, index - 1, slow_window) if index > 0 else None
            )
            enter_signal = (
                close is not None
                and previous_fast_ma is not None
                and previous_slow_ma is not None
                and primary_indicator is not None
                and secondary_indicator is not None
                and previous_fast_ma <= previous_slow_ma
                and primary_indicator > secondary_indicator
            )
            exit_signal = (
                close is not None
                and previous_fast_ma is not None
                and previous_slow_ma is not None
                and primary_indicator is not None
                and secondary_indicator is not None
                and previous_fast_ma >= previous_slow_ma
                and primary_indicator < secondary_indicator
            )
        elif normalized_strategy_id in {"donchian_breakout", "turtle_trend"}:
            breakout_window = _int_param(
                params,
                "breakout_window",
                55 if normalized_strategy_id == "turtle_trend" else 20,
                minimum=5,
                maximum=250,
            )
            exit_window = _int_param(
                params,
                "exit_window",
                20 if normalized_strategy_id == "turtle_trend" else 10,
                minimum=3,
                maximum=120,
            )
            primary_indicator = _rolling_high(highs, index - 1, breakout_window)
            secondary_indicator = _rolling_low(lows, index - 1, exit_window)
            enter_signal = (
                close is not None
                and primary_indicator is not None
                and close > primary_indicator
            )
            exit_signal = (
                close is not None
                and secondary_indicator is not None
                and close < secondary_indicator
            )
        elif normalized_strategy_id == "rsi_reversion":
            rsi_window = _int_param(params, "rsi_window", 14, minimum=3, maximum=60)
            trend_window = _int_param(params, "trend_window", 60, minimum=10, maximum=250)
            entry_rsi = _decimal_param(params, "entry_rsi", 35, minimum=5, maximum=60)
            exit_rsi = _decimal_param(params, "exit_rsi", 55, minimum=40, maximum=95)
            rsi_value = _rsi(closes, index, rsi_window)
            trend_ma = _rolling_mean(closes, index, trend_window)
            primary_indicator = rsi_value
            secondary_indicator = trend_ma
            enter_signal = (
                close is not None
                and rsi_value is not None
                and rsi_value <= entry_rsi
                and (trend_ma is None or close >= trend_ma)
            )
            exit_signal = (
                close is not None
                and rsi_value is not None
                and (rsi_value >= exit_rsi or (trend_ma is not None and close < trend_ma))
            )
        elif normalized_strategy_id == "bollinger_reversion":
            lookback_window = _int_param(params, "lookback_window", 20, minimum=10, maximum=120)
            entry_z = _decimal_param(params, "entry_z", 2, minimum=0.5, maximum=4)
            exit_z = _decimal_param(params, "exit_z", 0, minimum=-1, maximum=2)
            middle = _rolling_mean(closes, index, lookback_window)
            std = _rolling_std(closes, index, lookback_window)
            z_score = None
            if close is not None and middle is not None and std is not None and std > 0:
                z_score = (close - middle) / std
            primary_indicator = middle
            secondary_indicator = (
                middle - entry_z * std if middle is not None and std is not None else None
            )
            enter_signal = z_score is not None and z_score <= -entry_z
            exit_signal = z_score is not None and z_score >= exit_z
        elif normalized_strategy_id == "momentum_trend":
            momentum_window = _int_param(params, "momentum_window", 60, minimum=10, maximum=250)
            trend_window = _int_param(params, "trend_window", 120, minimum=20, maximum=300)
            min_momentum_pct = _decimal_param(
                params,
                "min_momentum_pct",
                8,
                minimum=-20,
                maximum=80,
            )
            exit_momentum_pct = _decimal_param(
                params,
                "exit_momentum_pct",
                0,
                minimum=-30,
                maximum=30,
            )
            momentum = _rolling_return_pct(closes, index, momentum_window)
            trend_ma = _rolling_mean(closes, index, trend_window)
            primary_indicator = momentum
            secondary_indicator = trend_ma
            enter_signal = (
                close is not None
                and momentum is not None
                and trend_ma is not None
                and momentum >= min_momentum_pct
                and close > trend_ma
            )
            exit_signal = (
                close is not None
                and momentum is not None
                and trend_ma is not None
                and (momentum <= exit_momentum_pct or close < trend_ma)
            )
        elif normalized_strategy_id == "volume_price_breakout":
            breakout_window = _int_param(params, "breakout_window", 20, minimum=5, maximum=120)
            exit_window = _int_param(params, "exit_window", 10, minimum=3, maximum=80)
            volume_window = _int_param(params, "volume_window", 20, minimum=5, maximum=120)
            volume_ratio = _decimal_param(params, "volume_ratio", "1.4", minimum="1", maximum="5")
            channel_high = _rolling_high(highs, index - 1, breakout_window)
            channel_low = _rolling_low(lows, index - 1, exit_window)
            volume_mean = _rolling_volume_mean(volumes, index - 1, volume_window)
            current_volume = Decimal(volumes[index]) if volumes[index] is not None else None
            primary_indicator = channel_high
            secondary_indicator = channel_low
            enter_signal = (
                close is not None
                and channel_high is not None
                and current_volume is not None
                and volume_mean is not None
                and close > channel_high
                and current_volume >= volume_mean * volume_ratio
            )
            exit_signal = close is not None and channel_low is not None and close < channel_low
        elif normalized_strategy_id == "atr_trailing_breakout":
            breakout_window = _int_param(params, "breakout_window", 20, minimum=5, maximum=120)
            atr_window = _int_param(params, "atr_window", 14, minimum=5, maximum=60)
            atr_multiplier = _decimal_param(
                params,
                "atr_multiplier",
                "2.5",
                minimum="0.5",
                maximum="8",
            )
            channel_high = _rolling_high(highs, index - 1, breakout_window)
            atr_value = _atr(highs, lows, closes, index, atr_window)
            trailing_stop = (
                highest_close_since_entry - atr_value * atr_multiplier
                if highest_close_since_entry is not None and atr_value is not None
                else None
            )
            primary_indicator = channel_high
            secondary_indicator = trailing_stop
            enter_signal = close is not None and channel_high is not None and close > channel_high
            exit_signal = close is not None and trailing_stop is not None and close < trailing_stop
        elif normalized_strategy_id == "low_volatility_trend":
            trend_window = _int_param(params, "trend_window", 60, minimum=20, maximum=250)
            vol_window = _int_param(params, "vol_window", 20, minimum=10, maximum=120)
            max_volatility_pct = _decimal_param(
                params,
                "max_volatility_pct",
                35,
                minimum=5,
                maximum=120,
            )
            exit_volatility_pct = _decimal_param(
                params,
                "exit_volatility_pct",
                max_volatility_pct * Decimal("1.25"),
                minimum=5,
                maximum=150,
            )
            trend_ma = _rolling_mean(closes, index, trend_window)
            volatility = _annualized_price_volatility_pct(closes, index, vol_window)
            primary_indicator = trend_ma
            secondary_indicator = volatility
            enter_signal = (
                close is not None
                and trend_ma is not None
                and volatility is not None
                and close > trend_ma
                and volatility <= max_volatility_pct
            )
            exit_signal = (
                close is not None
                and trend_ma is not None
                and volatility is not None
                and (close < trend_ma or volatility > exit_volatility_pct)
            )
        elif normalized_strategy_id == "ma_pullback_reclaim":
            pullback_window = _int_param(params, "pullback_window", 20, minimum=5, maximum=80)
            trend_window = _int_param(params, "trend_window", 60, minimum=20, maximum=250)
            stop_loss_pct = _decimal_param(params, "stop_loss_pct", 8, minimum=1, maximum=30)
            pullback_ma = _rolling_mean(closes, index, pullback_window)
            previous_pullback_ma = (
                _rolling_mean(closes, index - 1, pullback_window) if index > 0 else None
            )
            trend_ma = _rolling_mean(closes, index, trend_window)
            primary_indicator = pullback_ma
            secondary_indicator = trend_ma
            trade_return_pct = (
                _return_pct(close, current_trade.entry_price)
                if close is not None and current_trade is not None
                else None
            )
            stop_triggered = (
                trade_return_pct is not None and trade_return_pct <= -stop_loss_pct
            )
            enter_signal = (
                close is not None
                and previous_close is not None
                and pullback_ma is not None
                and previous_pullback_ma is not None
                and trend_ma is not None
                and close > trend_ma
                and previous_close <= previous_pullback_ma
                and close > pullback_ma
            )
            exit_signal = (
                close is not None
                and trend_ma is not None
                and (close < trend_ma or stop_triggered)
            )
        elif normalized_strategy_id == "gap_reversal":
            gap_down_pct = _decimal_param(params, "gap_down_pct", 3, minimum=0.5, maximum=12)
            max_holding_days = _int_param(params, "max_holding_days", 5, minimum=1, maximum=30)
            stop_loss_pct = _decimal_param(params, "stop_loss_pct", 6, minimum=1, maximum=30)
            open_price = opens[index]
            gap_pct = _return_pct(open_price, previous_close)
            holding_days = index - entry_index if entry_index is not None else 0
            primary_indicator = gap_pct
            secondary_indicator = Decimal(holding_days)
            trade_return_pct = (
                _return_pct(close, current_trade.entry_price)
                if close is not None and current_trade is not None
                else None
            )
            stop_triggered = (
                trade_return_pct is not None and trade_return_pct <= -stop_loss_pct
            )
            enter_signal = (
                close is not None
                and open_price is not None
                and gap_pct is not None
                and gap_pct <= -gap_down_pct
                and close > open_price
            )
            exit_signal = (
                close is not None
                and previous_close is not None
                and (close >= previous_close or holding_days >= max_holding_days or stop_triggered)
            )

        if position == 0 and enter_signal and close is not None:
            equity *= Decimal("1") - fee_rate
            position = 1
            entry_index = index
            highest_close_since_entry = close
            current_trade = BacktestTrade(entry_date=bar.date, entry_price=close, holding_days=0)
            trades.append(current_trade)
        elif position == 1 and exit_signal and close is not None:
            equity *= Decimal("1") - fee_rate
            position = 0
            if current_trade is not None:
                current_trade.exit_date = bar.date
                current_trade.exit_price = close
                current_trade.holding_days = max(
                    0,
                    index - _trade_entry_index(kline, current_trade.entry_date),
                )
                current_trade.return_pct = _round(_return_pct(close, current_trade.entry_price), 4)
                current_trade.status = "closed"
                current_trade = None
            entry_index = None
            highest_close_since_entry = None

        peak_equity = max(peak_equity, equity)
        drawdown_pct = (
            ((equity - peak_equity) / peak_equity) * Decimal("100") if peak_equity else None
        )
        strategy_return_pct = strategy_return * Decimal("100")
        if index > 0:
            strategy_returns.append(strategy_return_pct)

        equity_curve.append(
            BacktestEquityPoint(
                date=bar.date,
                close=close,
                fast_ma=_round(primary_indicator, 4),
                slow_ma=_round(secondary_indicator, 4),
                position=position,
                daily_return_pct=_round(benchmark_return, 4),
                strategy_return_pct=_round(strategy_return_pct, 4),
                equity=_round(equity, 6) or equity,
                drawdown_pct=_round(drawdown_pct, 4),
            )
        )

    closed_trades = [trade for trade in trades if trade.status == "closed"]
    winning_trades = [
        trade for trade in closed_trades if trade.return_pct is not None and trade.return_pct > 0
    ]
    first_close = next((close for close in closes if close is not None), None)
    latest_close = next((close for close in reversed(closes) if close is not None), None)
    total_return = _return_pct(equity, cash)
    benchmark_return = _return_pct(latest_close, first_close)
    max_drawdown = min(
        [point.drawdown_pct for point in equity_curve if point.drawdown_pct is not None],
        default=None,
    )
    volatility = _annualized_volatility_pct(strategy_returns)
    annualized_return = _annualized_return_pct(equity / cash, len(equity_curve))

    sharpe = None
    if annualized_return is not None and volatility is not None and volatility != 0:
        sharpe = annualized_return / volatility

    summary = BacktestSummary(
        start_date=equity_curve[0].date if equity_curve else None,
        end_date=equity_curve[-1].date if equity_curve else None,
        sample_count=len(equity_curve),
        initial_cash=_round(cash, 6) or cash,
        final_equity=_round(equity, 6) or equity,
        total_return_pct=_round(total_return, 4),
        benchmark_return_pct=_round(benchmark_return, 4),
        excess_return_pct=_round(
            total_return - benchmark_return
            if total_return is not None and benchmark_return is not None
            else None,
            4,
        ),
        max_drawdown_pct=_round(max_drawdown, 4),
        annualized_return_pct=_round(annualized_return, 4),
        volatility_annualized_pct=_round(volatility, 4),
        sharpe=_round(sharpe, 4),
        trade_count=len(closed_trades),
        win_rate_pct=_round(
            (Decimal(len(winning_trades)) / Decimal(len(closed_trades))) * Decimal("100")
            if closed_trades
            else None,
            4,
        ),
        exposure_pct=_round(
            (Decimal(position_days) / Decimal(len(equity_curve))) * Decimal("100")
            if equity_curve
            else None,
            4,
        ),
    )

    return BacktestResponse(
        symbol=kline.symbol,
        name=kline.name,
        secid=kline.secid,
        asset_type=kline.asset_type,
        market=kline.market,
        source=kline.source,
        strategy_id=normalized_strategy_id,
        strategy_name=STRATEGY_NAMES[normalized_strategy_id],
        fast_window=fast_window,
        slow_window=slow_window,
        fee_bps=_round(fee_rate * Decimal("10000"), 4) or fee_rate * Decimal("10000"),
        parameters=params,
        period=kline.period,
        adjustment=kline.adjustment,
        equity_curve=equity_curve,
        trades=trades,
        summary=summary,
        as_of=kline.as_of,
        fetched_at=datetime.now(UTC),
        metadata=kline.metadata,
    )


def _trade_entry_index(kline: KlineResponse, entry_date: str) -> int:
    for index, bar in enumerate(kline.bars):
        if bar.date == entry_date:
            return index
    return 0
