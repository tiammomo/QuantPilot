# 可复现回测契约

## 数据与信号时间

- 输入必须来自已确认的本地 bars，并记录 symbol、period/timeframe、adjustment、首尾时间和样本数。
- 策略只能使用当时已知信息。以收盘价生成信号时，默认从下一根 bar 才能成交；若接口采用同收盘成交，必须明确标注潜在前视偏差。
- 均线交叉要求正整数 `fast_window < slow_window`，热身期不得计入可交易收益。

## 费用与成交

- `fee_bps` 为单边费率，必须非负；一次完整买卖需要分别扣费。
- 明确成交价格、滑点、停牌、涨跌停、分红再投资和冲击成本假设。
- 未建模项必须进入 `data_quality.limitations[]`，不能只留在自然语言结论。

## 最小结果结构

```json
{
  "parameters": {
    "fast_window": 2,
    "slow_window": 3,
    "fee_bps": 5,
    "period": "daily",
    "adjustment": "qfq"
  },
  "summary": {
    "start": "2026-07-10",
    "end": "2026-07-14",
    "final_equity": 1.02,
    "strategy_return": 0.02,
    "max_drawdown": 0.0,
    "trade_count": 1
  },
  "equity_curve": [
    {"ts": "2026-07-10", "equity": 1.0, "drawdown": 0.0, "position": 0},
    {"ts": "2026-07-14", "equity": 1.02, "drawdown": 0.0, "position": 1}
  ],
  "trades": [
    {"entry_ts": "2026-07-14", "entry_price": 10.0, "status": "open"}
  ],
  "data_quality": {
    "source": "quant.stock_bars",
    "limitations": ["slippage_not_modeled"]
  }
}
```

字段可使用 `date/timestamp` 代替 `ts`，但一个序列内必须语义一致。

## 数值不变量

- equity curve 非空且时间严格递增；净值必须有限且大于 0。
- `position` 限定为 0 或 1（当前 long-only 契约）。
- drawdown 必须在 `[-1, 0]`；`summary.max_drawdown` 应等于曲线最小 drawdown（允许浮点误差）。
- `summary.final_equity` 应等于曲线末值；若基准初始净值为 1，`strategy_return` 应约等于 `final_equity - 1`。
- `trade_count` 应等于 `trades` 长度。已关闭交易必须有退出时间、退出价格，且退出不早于进入。
- 价格、费用和持有天数不得为负。

## 摘要解释

收益、年化收益、波动率、夏普和胜率必须给出计算口径。小样本或无已关闭交易时，胜率应为 `null` 而不是虚构的 0%。净值和回撤曲线是摘要事实依据，不能只保留 summary。

## 验证与交付

运行 `scripts/validate_backtest.py`。结构或一致性错误退出 1；不可读 JSON 退出 2。通过后仍需在页面同时展示样本区间、费用、收益、最大回撤、交易次数和限制，不得把历史结果写成未来承诺。
