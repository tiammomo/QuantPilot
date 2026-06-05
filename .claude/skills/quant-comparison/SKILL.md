---
name: quant-comparison
description: Use this skill for multi-symbol stock, ETF, index, portfolio, or relative-strength comparison tasks before visualization.
---

# QuantPilot 多标的对比能力

本 skill 用于把多个标的的真实行情、历史 K 线和指标数据整理成可比较的分析结果。它必须建立在真实数据之上，不能只基于主标的生成结论。

## 何时必须使用

当用户问题包含以下意图时，必须使用本 skill：

- 对比、横向比较、相对强弱、谁更强、组合或多标的分析。
- 同时出现多只股票、指数或 ETF。
- 页面需要展示收益、波动、回撤、成交量、成交额、估值或财务质量的横向比较。

## 数据输入

优先读取平台已经预取的最终数据：

```text
data_file/final/dashboard-data.json
```

多标的任务的最终数据应包含：

- `requestedSymbols`: 用户问题解析出的全部标的。
- `assets[]`: 每个标的的真实数据对象，结构与单标的看板兼容，包含 `quote`、`kline`、`technicalIndicators`、`financials`、`computedMetrics` 等字段。
- `comparison.rows[]`: 标准化后的对比行，包含 `symbol`、`name`、`period_return`、`max_drawdown`、`volatility20d`、`avg_volume_20d`、`amount`、`as_of` 和 `source`。
- `comparison.leaders`: 收益、回撤、波动等维度的领先标的。

如果 `assets[]` 不存在或未覆盖 `.quantpilot/run_plan.json` 中的全部 `symbols`，必须先补取数据或明确失败，不能用主标的数据代表全部标的。

## 分析要求

1. 逐只标的核对 `symbol`、`name`、`quote_time/as_of`、`fetched_at`、`source`。
2. 使用同一时间窗口比较区间收益、最大回撤、年化/区间波动、成交量或成交额。
3. 如果财务数据存在，可补充盈利质量、ROE、毛利率、净利率等横向指标；如果缺失，要展示限制。
4. 明确区分事实数据、计算结果和分析推断。
5. 不构成投资建议，不输出确定性买卖结论。

## 可视化交付

调用 `dashboard-visualization` 生成页面时，多标的看板至少包含：

- 顶部：全部标的、样本区间、数据更新时间。
- 指标矩阵：最新价、当日涨跌幅、区间收益、最大回撤、波动、成交额。
- 对比图表：收益对比、波动/回撤对比、成交额或成交量对比。
- 相对强弱摘要：表现最好、回撤最小、波动最低等。
- 数据来源与质量：每个标的的来源、时间和缺失字段。

## 禁止事项

- 不要只展示第一只标的。
- 不要把 `assets[]` 里的多标的压缩成单个 `quote/kline` 后冒充对比。
- 不要编造缺失标的数据。
- 不要用静态样例数据或说明文字替代真实对比图表。
