---
name: quant-market-data
description: Use this skill when the task needs stock, index, ETF, or A-share market data; prefer QuantPilot local PostgreSQL/TimescaleDB data before any external provider.
---

# QuantPilot 行情取数能力

使用 QuantPilot 本地 Python 市场数据后端获取行情。分析、回测、选股和看板任务默认以本地 PostgreSQL/TimescaleDB 为事实库；东方财富、Baostock、AKShare、Yahoo/yfinance 等外部源只作为补数或实时快照入口。这个 skill 只负责取数，不负责设计页面。

## 何时必须使用

当任务涉及以下任意内容时，必须使用这个能力：

- 股票实时价格。
- A 股行情数据。
- 个股、组合、指数等市场数据查询。
- 指数或 ETF 查询优先配合 `quant-index-etf-market`，避免误走个股财务/公告链路。
- 涉及历史 K 线、策略筛选、回测、均线、成交额、换手率、涨跌停、分红标记或本地股票池分析。
- 需要先获取数据再做可视化、HTML 看板或分析的任务。

本 skill 只负责“取数和数据理解”。可视化页面生成必须交给 `dashboard-visualization` skill。

## 本地数据库优先原则

1. 任何股票、指数、ETF、策略或历史分析任务，先用 `quant-data-registry` 查询注册表和数据覆盖，再决定是否需要外部补数。
2. 已入库数据优先读取本地 TimescaleDB 封装接口，不要直接请求外部历史接口：

```bash
curl 'http://127.0.0.1:8000/api/v1/research/universes/summary'
curl 'http://127.0.0.1:8000/api/v1/research/universes/a-share-sample-research-pool/members?page=1&page_size=10'
curl 'http://127.0.0.1:8000/api/v1/research/bars/002156.SZ?timeframe=daily&adjustment=qfq&limit=1260'
curl 'http://127.0.0.1:8000/api/v1/research/bars/002156.SZ?timeframe=weekly&adjustment=qfq&limit=260'
curl 'http://127.0.0.1:8000/api/v1/research/bars/002156.SZ?timeframe=monthly&adjustment=qfq&limit=120'
```

3. `/api/v1/research/bars/{symbol}` 返回本地 `quant.stock_bars` 的标准字段：`open/high/low/close/previous_close/volume/amount/amplitude/change_percent/change_amount/turnover/trade_status/is_st/limit_up/limit_down/provider`，以及 `summary.first_ts/last_ts/row_count`。
4. 日线、周线、月线分析优先从本地日线聚合；只有本地库没有覆盖、字段缺失且用户任务确实需要时，才触发 ingestion 端点补数。
5. 实时行情、最新快照、公告、分红可以使用东方财富直连；但若用于可复现分析，应把 `source`、`quote_time`、`fetched_at` 和是否已入库写清楚。
6. 交互式首页对话不要默认全量调用 `/api/v1/research/data-coverage`；优先用 `universes/summary`、分页 `members` 和指定标的 `bars` 回答。只有做全池数据质量审计时再调用 data-coverage。
7. 外部源调用前必须写明缺口：缺哪些标的、时间范围、字段、以及为什么本地库不足。补数后再从本地 `/research/bars` 读取分析结果。

## 本地后端

服务地址：

```text
http://127.0.0.1:8000
```

健康检查：

```bash
curl http://127.0.0.1:8000/health
```

本地历史 K 线和覆盖查询是分析默认入口；实时行情只用于“最新价格/今日快照/补最新交易日”：

```bash
curl 'http://127.0.0.1:8000/api/v1/quotes/realtime/600519'
curl 'http://127.0.0.1:8000/api/v1/quotes/realtime/000300'
curl 'http://127.0.0.1:8000/api/v1/quotes/realtime/510300'
```

候选免费/免费层信源：

```bash
curl 'http://127.0.0.1:8000/api/v1/provider-candidates'
curl 'http://127.0.0.1:8000/api/v1/provider-candidates/probe?provider_id=stooq-daily'
curl 'http://127.0.0.1:8000/api/v1/provider-candidates/probe?provider_id=yahoo-finance-chart'
```

这些候选源只用于能力评估和后端 provider 规划，不直接替换东方财富主链路。海外股票、ETF、指数等任务后续优先通过 QuantPilot 后端封装 Stooq/Yahoo/yfinance，不要在生成项目中临时安装或直接调用外网接口。

A 股历史字段补数：

```bash
curl -X POST 'http://127.0.0.1:8000/api/v1/ingestion/baostock/history' \
  -H 'Content-Type: application/json' \
  -d '{"symbols":["002156.SZ"],"period":"daily","adjustment":"qfq","lookback_years":5,"limit":1260,"request_delay_seconds":1.5}'
```

`amount`、`amplitude`、`change_percent`、`change_amount`、`turnover` 已作为 `quant.stock_bars` 正式列。东方财富历史 K 线可用时是首选源；Baostock 用于当前本地补字段；AKShare 用于聚合接口验证；腾讯 K 线只作为 OHLCV 兜底，不能视为成交额或换手率来源。

批量实时行情：

```bash
curl -X POST 'http://127.0.0.1:8000/api/v1/quotes/realtime' \
  -H 'Content-Type: application/json' \
  -d '{"symbols":["600519","000001","300750"]}'
```

## 返回字段

典型返回：

```json
{
  "symbol": "600519",
  "secid": "1.600519",
  "name": "贵州茅台",
  "market": "SH",
  "asset_type": "stock",
  "source": "eastmoney",
  "price": "1290.2",
  "open": "1310.95",
  "high": "1311.91",
  "low": "1290.12",
  "previous_close": "1311.0",
  "change_percent": "-1.59",
  "volume": 49157,
  "amount": "6372389482.0",
  "market_cap": "1615679031393",
  "float_market_cap": "1615679031393",
  "quote_time": "2026-05-22T08:11:47Z",
  "fetched_at": "2026-05-22T17:37:53.137699Z",
  "fetch": {
    "cache_status": "miss",
    "cache_ttl_seconds": 5
  }
}
```

## 工作流程

1. 从用户问题中识别股票代码、股票名称、指数、ETF、股票池或默认标的。
2. 如果用户没有指定股票，默认使用 `600519`、`000001`、`300750`；如果是策略平台股票池任务，默认使用 `a-share-sample-research-pool`。
3. 先查 `quant-data-registry`、`/api/v1/research/universes/summary`、分页 members 或指定标的 `/api/v1/research/bars/{symbol}`，确认本地库覆盖范围、样本数、最新日期和关键字段。
4. 历史、趋势、回测、选股、均线、涨跌停、流动性和数据分析优先调用 `/api/v1/research/bars/{symbol}`。
5. 实时价格或今日快照再调用 `/api/v1/quotes/realtime/{symbol}` 或批量实时接口。
6. 如果接口失败，先展示真实错误，不要编造数据。
7. 明确记录返回数据中的 `symbol`、`name`、`asset_type`、`provider/source`、`summary.first_ts`、`summary.last_ts`、`summary.row_count`、`fetched_at`、关键字段缺失情况；实时行情还要记录 `price`、`change_percent`、`amount`、`quote_time` 和 `fetch.cache_status`。
8. 如果后续需要页面或看板，必须把已获取的数据作为输入交给 `dashboard-visualization` skill。
9. 如果用户请求海外股票或 ETF，先查询 `/api/v1/provider-candidates` 说明当前可测试的免费源；如果后端主接口尚未支持该市场，要把能力边界写进数据质量，不要编造行情。
10. 如果历史 K 线缺少成交额、换手率、振幅，优先检查 `docs/market-data-source-knowledge.md` 和后端 registry，再决定是否触发 Baostock 或 AKShare 补数。

## 禁止事项

- 不要硬编码行情数据来假装已取数。
- 不要绕过 QuantPilot 市场数据后端直接在生成项目里抓东方财富。
- 不要在本地库已有覆盖时优先请求 `/api/v1/quotes/history/{symbol}` 或外部 provider；先读 `/api/v1/research/bars/{symbol}`。
- 不要在生成项目中 `pip install yfinance` 或用 Bash 临时写爬虫；海外数据源必须先进入 QuantPilot 后端 provider。
- 不要在取数 skill 中设计页面结构；页面结构交给可视化 skill。
- 不要把缺失的成交额或换手率用成交量、涨跌幅硬凑成真实字段。

## 后端启动

如果服务未启动，在 QuantPilot 根目录执行：

```bash
cd backend/market_data
uv sync
uv run quantpilot-market-api
```

不要在生成的 Next.js 项目中重新实现行情抓取逻辑；统一调用 QuantPilot 市场数据后端。
