---
name: quant-backtest
description: Execute, validate, and explain reproducible single-asset backtests from QuantPilot local bars. Use for MA crossover or comparable long-only strategy research requiring parameters, fees, equity curve, drawdown, trades, local-data coverage, and explicit model limitations.
---

# QuantPilot 可复现回测

基于已校验的本地 bars 执行回测，保存参数、数据口径和逐日净值证据。回测结果用于研究，不是未来收益承诺。

## 执行流程

1. 解析标的，先读取 `/api/v1/research/bars/{symbol}` 并确认本地样本区间、周期和复权。
2. 固化策略参数、费用、信号时点和成交假设；均线交叉必须满足 `fast_window < slow_window`。
3. 在调用 `/api/v1/backtests/ma-crossover/{symbol}` 或本地确定性计算前，读取 [references/backtest-contract.md](references/backtest-contract.md)。
4. 保存原始响应，并把 `summary`、`equity_curve`、`trades`、`data_quality` 与 `localBarsCoverage` 合并到最终数据。
5. 在展示收益或生成页面前执行：

```bash
python3 scripts/validate_backtest.py --input data_file/raw/<run_id>/backtest.json
```

6. 校验失败时不得声称回测完成；校验通过后仍要披露未建模项与数据限制。

## 按需资源

- [references/backtest-contract.md](references/backtest-contract.md)：实现/审查信号、成交、费用、收益、回撤、交易配对或结果解释时必须读取。
- [scripts/validate_backtest.py](scripts/validate_backtest.py)：检查参数、时间顺序、净值、回撤、持仓、交易明细和摘要一致性。

## Workspace 回答协作

- 继承平台五阶段进度，不重复阶段标题、识别表或 Todo。
- 只贡献策略、参数、样本区间、费用、收益、回撤、交易数和未建模限制。
- 不输出隐藏推理、完整工具参数或占位式执行文案。

## 完成门槛

- 数据来源为已确认的本地 bars，样本区间、周期、复权和费用明确。
- 结果同时包含 `summary`、非空 `equity_curve`、`trades` 与 `data_quality`。
- 校验器返回 `ok: true`，摘要与曲线末值一致。
- 明确披露滑点、停牌、涨跌停、分红再投资和冲击成本是否建模。
