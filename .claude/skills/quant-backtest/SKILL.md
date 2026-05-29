---
name: quant-backtest
description: Use this skill when a QuantPilot task needs a reproducible single-asset backtest based on QuantPilot local bars, especially MA crossover strategy review with equity curve, drawdown, trade list, and data limitations.
---

# QuantPilot 回测能力

本 skill 用于基于 QuantPilot 本地 TimescaleDB K 线执行或解释最小可复现回测。当前已接入单标的均线突破策略，适用于策略研究、回测复盘、ETF/指数趋势策略验证和风险摘要。回测前必须确认本地 bars 覆盖，避免外部历史接口变化影响复现。

## API

```bash
curl 'http://127.0.0.1:8000/api/v1/research/bars/510300.SH?timeframe=daily&adjustment=qfq&limit=1260'
curl 'http://127.0.0.1:8000/api/v1/backtests/ma-crossover/510300?fast_window=20&slow_window=60&period=daily&adjustment=qfq&limit=250&fee_bps=5'
```

参数：

- `fast_window`: 快线窗口，默认 `20`。
- `slow_window`: 慢线窗口，默认 `60`，必须大于快线。
- `period`: 当前推荐 `daily`。
- `adjustment`: A 股默认 `qfq`。
- `limit`: 历史样本长度，默认建议 `250`。
- `fee_bps`: 单边费用，单位 bps，默认 `5`。

## 返回内容

- `summary`: 样本区间、最终净值、策略收益、标的收益、超额收益、最大回撤、年化收益、波动率、夏普、交易次数、胜率和持仓暴露。
- `equity_curve`: 每个交易日的收盘价、快慢均线、持仓、策略日收益、净值和回撤。
- `trades`: 每笔交易的买入日、买入价、卖出日、卖出价、收益率、持有天数和状态。
- `data_quality`: 样本、交易信号和数据质量提示。

## 工作流程

1. 先解析标的代码，指数/ETF 可以直接使用代码或常见中文名。
2. 先用 `/api/v1/research/bars/{symbol}` 读取本地 bars，确认样本区间、行数、复权口径、成交额/换手率缺失情况。
3. 调用回测接口或基于本地 bars 做确定性计算时，都必须把本地 bars 的样本区间写入结果。
4. 如果回测接口返回的数据源不是本地库或无法确认来源，必须在数据质量里说明“回测接口仍需后端 local-first 改造”，不要把结果描述成完全本地可复现。
5. 将原始结果保存到 `data_file/raw/<run_id>/backtest-ma-crossover.json`。
6. 将结果合并到 `data_file/final/dashboard-data.json` 的 `backtest` 字段，并保留 `backtest.localBarsCoverage`。
7. 页面必须展示净值曲线、最大回撤、交易次数、胜率、样本区间和交易明细。
8. 结论必须说明当前回测暂未建模滑点、停牌、分红再投资和冲击成本。

## 禁止事项

- 不要编造交易明细或净值曲线。
- 不要把回测收益描述成未来收益承诺。
- 不要隐藏样本区间、费用参数和数据限制。
- 不要在没有 `backtest.summary` 和 `backtest.equity_curve` 的情况下声称已完成回测。
- 不要跳过本地 bars 覆盖检查直接调用外部历史 K 线。
