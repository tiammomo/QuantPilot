---
name: quant-a-share-history
description: Use this skill to read A-share historical K-line data from QuantPilot local TimescaleDB first for trend analysis, returns, drawdown, volatility, strategy screening, and dashboard visualizations.
---

# QuantPilot A 股历史行情能力

从 QuantPilot 后端优先读取本地 TimescaleDB 历史 K 线。适用于趋势、收益率、回撤、成交额、换手率、涨跌停、策略筛选、回测和波动分析。外部源只用于本地缺口补数，补数后再回读本地库。

## API

```bash
curl 'http://127.0.0.1:8000/api/v1/research/bars/600519.SH?timeframe=daily&adjustment=qfq&limit=1260'
curl 'http://127.0.0.1:8000/api/v1/research/bars/600519.SH?timeframe=weekly&adjustment=qfq&limit=260'
curl 'http://127.0.0.1:8000/api/v1/research/bars/600519.SH?timeframe=monthly&adjustment=qfq&limit=120'
curl 'http://127.0.0.1:8000/api/v1/quotes/history/600519?period=daily&adjustment=qfq&limit=120'
curl 'http://127.0.0.1:8000/api/v1/indicators/technical/600519?period=daily&adjustment=qfq&limit=120'
curl 'http://127.0.0.1:8000/api/v1/quotes/history/000300?period=daily&adjustment=qfq&limit=240'
```

参数：

- `period`: `daily`、`weekly`、`monthly`、`minute1`、`minute5`、`minute15`、`minute30`、`minute60`
- `adjustment`: `none`、`qfq`、`hfq`
- `limit`: 1 到 1000

`/api/v1/research/bars/{symbol}` 是历史分析默认入口；`/api/v1/quotes/history/{symbol}` 是外部历史接口兼容入口，只在本地库缺数据或需要补数验证时使用。

## 工作流程

1. 必要时先使用 `quant-symbol-resolver` 解析证券。
2. 先使用 `quant-data-registry` 确认历史行情能力和本地覆盖；如果本地库已有目标标的、时间范围和关键字段，直接读取本地 bars。
3. 选择合适周期：默认 `daily`，长期趋势用 `weekly/monthly`，盘中分析用分钟线。
4. 默认使用前复权 `qfq`，除非用户明确要求不复权或后复权。
5. 基于本地返回 `bars` 计算收益、回撤、波动、MA5/MA10/MA20/MA30/MA60、成交额、换手率、涨跌停和样本覆盖。
6. 只有本地 bars 不足或标准化指标接口已确认读取同一口径数据时，才调用 `indicators/technical`；不要为了算均线绕过本地 bars 请求外部历史数据。
7. 指数或 ETF 任务配合 `quant-index-etf-market`，不要强制请求个股财务或公告。
8. 如果本地历史行情失败，可降级结合实时行情、财务摘要和公告事件做分析，但必须说明缺少历史序列；不要把实时快照当作历史样本。
9. 需要页面时，把 K 线和指标交给 `dashboard-visualization`。
10. 如果 `amount`、`turnover`、`amplitude` 缺失，优先通过后端 Baostock 补数端点 `/api/v1/ingestion/baostock/history` 增强本地 `quant.stock_bars`；AKShare 作为聚合接口验证，不要在页面中临时抓外部接口。补数完成后重新请求 `/api/v1/research/bars/{symbol}`。

## 禁止事项

- 不要编造历史价格。
- 不要把实时行情当历史行情使用。
- 不要把腾讯兜底 K 线当成成交额或换手率来源。
- 不要在本地 TimescaleDB 已有覆盖时优先请求外部历史 K 线。
