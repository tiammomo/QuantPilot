---
name: quant-data-registry
description: Use this skill to discover QuantPilot local database coverage, market data capabilities, and the right backend endpoint before fetching financial data.
---

# QuantPilot 数据源注册表

先查询 QuantPilot 本地数据注册表和 TimescaleDB 覆盖，再选择具体数据能力。不要凭记忆猜接口，也不要在本地库已有数据时优先调用外部历史接口。

## API

```bash
curl http://127.0.0.1:8000/api/v1/registry
curl 'http://127.0.0.1:8000/api/v1/research/universes/summary'
curl 'http://127.0.0.1:8000/api/v1/research/universes/a-share-sample-research-pool/members?page=1&page_size=10'
curl 'http://127.0.0.1:8000/api/v1/research/data-coverage?universe_id=a-share-sample-research-pool'
curl 'http://127.0.0.1:8000/api/v1/research/bars/002156.SZ?timeframe=daily&adjustment=qfq&limit=1260'
```

## Local-first 数据路线

QuantPilot 的行情链路以 PostgreSQL + TimescaleDB 为事实库。首页对话、生成工作空间、策略平台和可视化任务遇到股票、指数、ETF 或历史分析时，默认路线是：

1. `/api/v1/registry`：确认后端能力和 provider 边界。
2. `/api/v1/research/universes/summary`：快速确认本地股票池、ETF/指数池、成员数、ready 数、bar 数和最新数据时间。
3. 分页 `/api/v1/research/universes/{universe_id}/members`：按页查看股票池成员，避免首页对话全量扫库。
4. `/api/v1/research/bars/{symbol}`：读取本地 `quant.stock_bars` 作为 K 线、均线、涨跌停、换手率、成交额、回测和选股分析主数据。
5. `/api/v1/research/data-coverage`：只在用户明确要求全池覆盖/质量审计时调用；大数据量下不要把它作为每次对话的默认前置请求。
6. 外部 provider 或 `/api/v1/ingestion/**`：只在本地缺标的、缺时间段或缺关键字段时使用；补数后重新读取本地库。
7. `/api/v1/quotes/realtime/**`、公告、分红接口：用于实时快照和事件补充，不替代可复现历史分析。

## 工作流程

1. 任务涉及行情、财务、公告、事件、历史数据、选股、回测或策略解释时，先查注册表。
2. 判断任务是否可以直接由本地库回答：
   - 有明确证券和历史区间：优先查 `/api/v1/research/bars/{symbol}`。
   - 有股票池/全市场筛选：优先查 `/api/v1/research/universes/summary` 和分页 `/api/v1/research/universes/{universe_id}/members`；只有全池质量审计才查 `/api/v1/research/data-coverage`。
   - 要求 MA、涨跌幅、成交额、换手率、涨跌停、ST、趋势强弱：优先使用本地 `stock_bars` 字段或基于本地 bars 计算。
3. 根据用户问题选择能力：
   - 实时价格：`quant-market-data`
   - 股票代码/名称解析：`quant-symbol-resolver`
   - 历史 K 线：`quant-a-share-history`
   - 指数/ETF 行情：`quant-index-etf-market`
   - 财务摘要：`quant-fundamental-financials`
   - 公告事件：`quant-announcement-events`
   - 可视化：`dashboard-visualization`
4. 历史 K 线字段补数按以下优先级判断：
   - 本地 `/api/v1/research/bars/{symbol}` 已覆盖时，直接读取本地数据。
   - 东方财富历史 K 线可用时，优先使用 f57/f58/f59/f60/f61 写入成交额、振幅、涨跌幅、涨跌额和换手率。
   - 东方财富历史端点不可达时，优先使用 Baostock 补数端点 `/api/v1/ingestion/baostock/history` 补 `amount`、`amplitude`、`change_percent`、`change_amount`、`turnover`。
   - AKShare 补数端点 `/api/v1/ingestion/akshare/history` 可用于聚合接口验证；如果底层仍走东方财富且不可达，降级 Baostock。
   - 腾讯 K 线只作为 OHLCV 兜底，通常没有成交额和换手率，不能覆盖已有增强字段。
5. 查询项目知识库 `docs/market-data-source-knowledge.md`，确认字段来源和 provider 边界。
6. 输出分析时标明 `source/provider`、`fetched_at`、`summary.first_ts`、`summary.last_ts`、`summary.row_count`，并说明数据覆盖范围和缺失字段。

## 禁止事项

- 不要跳过注册表直接编造数据源能力。
- 不要跳过本地覆盖检查直接调用外部历史接口。
- 不要把未接入的数据源说成已经可用。
- 不要把腾讯兜底 K 线当成已具备成交额和换手率的数据源。
