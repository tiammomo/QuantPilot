---
name: quant-technical-indicators
description: Use this skill when a quantitative task needs standardized technical indicators such as moving averages, returns, drawdown, volatility, and volume metrics, preferably computed from QuantPilot local bars.
---

# QuantPilot 技术指标能力

本 skill 用于从 QuantPilot 本地 K 线获取或计算标准化技术指标，避免在页面中重复临场计算。适用于技术分析、个股诊断、K 线看板、趋势分析和风险摘要。

## API

```bash
curl 'http://127.0.0.1:8000/api/v1/research/bars/600519.SH?timeframe=daily&adjustment=qfq&limit=1260'
curl 'http://127.0.0.1:8000/api/v1/indicators/technical/600519?period=daily&adjustment=qfq&limit=120'
```

优先使用 `/api/v1/research/bars/{symbol}` 读取本地 `quant.stock_bars`，再基于 `bars` 计算 MA5/MA10/MA20/MA30/MA60、收益、回撤、波动、成交额和换手率。`/api/v1/indicators/technical/{symbol}` 是标准化指标兼容接口，只有确认其数据口径满足任务时再使用。

参数与历史 K 线一致：

- `period`: `daily`、`weekly`、`monthly`、`minute1`、`minute5`、`minute15`、`minute30`、`minute60`
- `adjustment`: `none`、`qfq`、`hfq`
- `limit`: 1 到 1000

## 返回内容

接口返回：

- `points`: 每根 K 线对应的 `close`、`volume`、`ma5`、`ma10`、`ma20`、`return_pct`、`drawdown_pct`。
- `summary`: 最新收盘价、区间收益、最大回撤、年化波动率、20 日平均成交量、最新 MA5/MA10/MA20。
- `as_of`、`fetched_at`、`source`、`data_quality`。

## 工作流程

1. 先确认标的已经解析为标准代码。
2. 先用 `quant-data-registry` 和 `/api/v1/research/bars/{symbol}` 获取或确认本地历史 K 线可用。
3. 基于本地 bars 计算指标；如果需要后端标准化指标，再调用 `indicators/technical` 并在数据质量里说明口径。
4. 将指标写入 `data_file/raw/<run_id>/technical-indicators.json` 或 `data_file/final/dashboard-data.json` 的 `technicalIndicators` 字段。
5. 页面生成时优先读取 `technicalIndicators.summary` 展示 MA、收益率、波动率、最大回撤等指标。
6. 样本不足或 `data_quality.status` 不是 `ok` 时，必须在页面或结论中说明限制。

## 禁止事项

- 不要在没有历史 K 线的情况下编造 MA、回撤或波动率。
- 不要把后端返回的百分比再乘 100。
- 不要只展示指标卡，技术分析页面仍应保留 K 线或趋势图。
- 不要为了计算技术指标绕过本地 bars 去请求外部历史接口。
