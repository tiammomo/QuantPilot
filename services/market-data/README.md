# QuantPilot 市场数据服务

这个子模块用于给量化分析 Agent 和策略平台提供行情、财务、事件、补数、基础组件和回测数据能力。当前以东方财富为实时行情和事件主源，历史 K 线优先走东方财富，失败时使用 Baostock 补 A 股日线增强字段，AKShare 作为补充聚合层，Yahoo Finance 仅用于海外市场方向。

所有核心响应会保留原有业务字段，同时补充统一数据契约字段，方便 Agent 判断来源和质量：

```json
{
  "asset_type": "stock",
  "source": "eastmoney",
  "as_of": "2026-05-22T08:11:47Z",
  "fetched_at": "2026-05-23T09:46:28Z",
  "currency": "CNY",
  "timezone": "Asia/Shanghai",
  "fetch": {
    "cache_status": "miss",
    "cache_ttl_seconds": 5,
    "cached_at": "2026-05-23T11:07:56.603088Z",
    "expires_at": "2026-05-23T11:08:01.603088Z"
  },
  "data_quality": {
    "status": "ok",
    "missing_fields": [],
    "warnings": []
  }
}
```

## 环境要求

- Python 3.14
- uv

首次初始化：

```bash
cd services/market-data
uv sync
```

从项目根目录执行 `npm run dev` 或 `npm run dev:market` 时会自动启用
Baostock / AKShare。仅在单独运行本服务时，需要手动安装这两个数据扩展：

```bash
uv sync --extra baostock --extra akshare
```

启动服务：

```bash
uv run quantpilot-market-api
```

默认地址：

```text
http://127.0.0.1:8000
```

可选环境变量：

```bash
# 服务监听地址
export QUANTPILOT_MARKET_HOST=127.0.0.1
export QUANTPILOT_MARKET_PORT=8000
# strict 模式或非 loopback 监听时必填；配置后本机写接口也必须携带令牌
export QUANTPILOT_MARKET_ADMIN_TOKEN=replace-with-a-long-random-token

# 东方财富主备域名，按顺序失败重试
export EASTMONEY_BASE_URLS=https://push2.eastmoney.com,https://push2delay.eastmoney.com

# 本地缓存；默认开启，默认目录为 ~/.cache/quantpilot/market_data
export QUANTPILOT_MARKET_CACHE_ENABLED=1
export QUANTPILOT_MARKET_CACHE_DIR=/tmp/quantpilot-market-cache
export QUANTPILOT_QUOTE_CACHE_TTL_SECONDS=5
export QUANTPILOT_KLINE_CACHE_TTL_SECONDS=1800
export QUANTPILOT_FINANCIAL_CACHE_TTL_SECONDS=21600
export QUANTPILOT_ANNOUNCEMENT_CACHE_TTL_SECONDS=600
export QUANTPILOT_SCREENER_CACHE_TTL_SECONDS=60

# Redis 跨进程短期缓存；默认由根目录 docker-compose 拉起
export REDIS_URL=redis://127.0.0.1:6379/0
export REDIS_NAMESPACE=quantpilot
export QUANTPILOT_REDIS_CACHE_ENABLED=1

# ClickHouse 分析加速层；默认关闭，启用后仍以 TimescaleDB 为事实主库
export QUANTPILOT_CLICKHOUSE_ENABLED=1
export CLICKHOUSE_URL=http://127.0.0.1:8123
export CLICKHOUSE_DB=quantpilot
export CLICKHOUSE_USER=quantpilot
export CLICKHOUSE_PASSWORD=quantpilot_dev_password
```

## 接口

### 健康检查

```bash
curl http://127.0.0.1:8000/health
curl http://127.0.0.1:8000/ready
```

`/health` 只确认 FastAPI 进程存活；负载均衡器接流前使用 `/ready`，它会按降级配置检查数据库与 Redis，required 依赖失败时返回 503，且不会返回连接串或内部异常。

### 数据源注册表

```bash
curl http://127.0.0.1:8000/api/v1/registry
```

### ClickHouse 分析加速层

ClickHouse 是可选旁路，只承载全市场筛选、因子宽表和批量分析，不替代 TimescaleDB。启用后，短线筛选会优先读取 ClickHouse；如果分析表落后于 TimescaleDB 目标交易日，会先同步缺口日期并重试，仍不可用时再回退 TimescaleDB。默认“最新交易日”解析读取 `quant.market_data_sync_state`，不要在在线请求里扫描全量 `quant.stock_bars`。

```bash
curl http://127.0.0.1:8000/api/v1/analytics/clickhouse/health
curl -X POST http://127.0.0.1:8000/api/v1/analytics/clickhouse/init
curl -X POST http://127.0.0.1:8000/api/v1/analytics/clickhouse/sync \
  -H 'Content-Type: application/json' \
  -d '{"universe_id":"a-share-sample-research-pool","timeframe":"daily","adjustment":"qfq","limit":300000}'
```

同步完成后，A 股短线筛选器会优先读取 `clickhouse.quant_bars_daily`；响应中的 `data_basis` 和 `analytics` 会标明本次命中 ClickHouse、自动同步后命中、还是回退 TimescaleDB。健康接口会返回 `table_latest_trade_dates.quant_bars_daily`，用于判断分析层是否追平事实主库。筛选特征在 ClickHouse 内完成去重、最近 60 日聚合、均线和涨停计数计算，Python 侧只做过滤、评分和响应组装；不同 `limit` 请求会复用短 TTL 特征缓存。

### 候选免费信源池

候选信源不会直接替换主链路，先用于测试可达性、字段稳定性和数据质量：

```bash
curl http://127.0.0.1:8000/api/v1/provider-candidates
curl http://127.0.0.1:8000/api/v1/provider-candidates/probe
curl 'http://127.0.0.1:8000/api/v1/provider-candidates/probe?provider_id=tencent-a-share-kline'
```

当前候选方向：

- 腾讯股票 K 线：免 key，可作为 A 股历史 K 线兜底。
- 新浪财经实时行情：免 key，可作为 A 股实时行情兜底，后续需处理编码、Referer 和字段映射。
- Stooq：免 key CSV，适合海外日线和离线回测样本。
- Alpha Vantage / Finnhub / Twelve Data / Marketstack：免费层适合海外股票、ETF、外汇、宏观或公司资料测试，但需要 API key。
- Nasdaq Data Link：适合宏观和公开数据集测试，具体数据集权限以官方为准。

### 证券代码/名称解析

```bash
curl -G 'http://127.0.0.1:8000/api/v1/symbols/resolve' \
  --data-urlencode 'query=茅台' \
  --data-urlencode 'count=5'
```

### 单只股票实时行情

```bash
curl 'http://127.0.0.1:8000/api/v1/quotes/realtime/600519'
curl 'http://127.0.0.1:8000/api/v1/quotes/realtime/000001'
curl 'http://127.0.0.1:8000/api/v1/quotes/realtime/1.600519'
```

### 批量股票实时行情

```bash
curl -X POST 'http://127.0.0.1:8000/api/v1/quotes/realtime' \
  -H 'Content-Type: application/json' \
  -d '{"symbols":["600519","000001","300750"]}'
```

### 历史 K 线

```bash
curl 'http://127.0.0.1:8000/api/v1/quotes/history/600519?period=daily&adjustment=qfq&limit=120'
```

说明：日/周/月 K 线、技术指标和回测统一先读 `quant.stock_bars`；只有覆盖不足或显式 `refresh=true` 才访问外部历史源。响应的 `metadata.data_basis`、`coverage` 和 `freshness` 会说明实际口径。实时快照隔离写入 `quant.realtime_quote_snapshots`，不会覆盖正式复权日线。

所有补数、同步、质量扫描等写接口接受 `Authorization: Bearer ...` 或 `X-QuantPilot-Admin-Token`。本机非 strict 且未配置令牌时保持开发兼容；strict 或非 loopback 监听未配置令牌时写接口关闭。

### 历史 K 线字段补数

Baostock / AKShare 补数端点用于把 `amount`、`amplitude`、`change_percent`、`change_amount`、`turnover`、停牌/ST 和涨跌停字段写入正式列。它不会删除已有更早历史，稀疏源也不会覆盖已有非空增强字段。当前本地优先使用 Baostock，因为它不依赖东方财富历史域名。估值因子默认不参与日常增量补数，需要时传 `include_valuation_factors=true` 单独纳入完整性检查。

```bash
curl -X POST 'http://127.0.0.1:8000/api/v1/ingestion/baostock/history' \
  -H 'Content-Type: application/json' \
  -d '{"symbols":["002156.SZ","002555.SZ"],"period":"daily","adjustment":"qfq","lookback_years":5,"limit":1260,"request_delay_seconds":0.2}'
```

更完整的 provider 选择、字段口径和 API 总览见项目根目录的 `docs/market-data-source-knowledge.md`、`docs/data-dictionary.md` 和 `docs/api-reference.md`。

### 基础组件

策略平台“基础组件”页使用这些接口查看数据底座状态和口径：

```bash
curl 'http://127.0.0.1:8000/api/v1/foundation/status'
curl 'http://127.0.0.1:8000/api/v1/foundation/factors'
curl 'http://127.0.0.1:8000/api/v1/foundation/trading-calendar?market=CN-A&limit=30'
curl -X POST 'http://127.0.0.1:8000/api/v1/foundation/trading-calendar/refresh' \
  -H 'Content-Type: application/json' \
  -d '{"start":"2021-01-01","end":"2026-07-14"}'
curl -X POST 'http://127.0.0.1:8000/api/v1/foundation/data-quality/scan' \
  -H 'Content-Type: application/json' \
  -d '{"universe_id":"a-share-sample-research-pool","lookback_years":5,"timeframe":"daily","adjustment":"qfq"}'
```

交易日历刷新复用 Baostock 进程级共享会话，幂等写入 `CN-A / regular` 的开市与休市日；省略日期时默认覆盖近 5 年至上海时区今天。该写接口遵循统一管理员令牌要求。

对应 SQL 位于根目录 `sqls/007-quant-foundation-components.sql`，包括交易日历、因子定义、数据质量扫描和通用平台任务表。

### 技术指标

```bash
curl 'http://127.0.0.1:8000/api/v1/indicators/technical/600519?period=daily&adjustment=qfq&limit=120'
```

返回 MA5/MA10/MA20/MA30/MA60、单日收益率、回撤序列、区间收益、最大回撤、年化波动率和 20 日平均成交量。

### 指数与 ETF

```bash
curl 'http://127.0.0.1:8000/api/v1/symbols/resolve?query=沪深300&count=10'
curl 'http://127.0.0.1:8000/api/v1/quotes/realtime/000300'
curl 'http://127.0.0.1:8000/api/v1/quotes/realtime/510300'
curl 'http://127.0.0.1:8000/api/v1/quotes/history/399006?period=daily&adjustment=qfq&limit=120'
```

常见别名会自动映射到东方财富 secid，例如沪深300 -> `1.000300`，创业板指 -> `0.399006`，沪深300ETF -> `1.510300`。响应里的 `asset_type` 会标识 `index` 或 `etf`；这类标的默认不提供个股财务摘要和公告事件。

### 财务摘要

```bash
curl 'http://127.0.0.1:8000/api/v1/fundamentals/financials/600519?limit=8'
```

### 财务衍生指标

```bash
curl 'http://127.0.0.1:8000/api/v1/indicators/fundamental/600519?limit=8'
```

返回净利率、平均 ROE、平均毛利率、平均净利率和最近报告期核心指标。

### 公告事件

```bash
curl 'http://127.0.0.1:8000/api/v1/events/announcements/600519?limit=20'
```

## 代码结构

- `quantpilot_market_data/cache.py`：本地 JSON 缓存、Redis JSON 缓存、TTL 和 fetch 元信息。
- `quantpilot_market_data/providers/eastmoney.py`：东方财富数据源客户端。
- `quantpilot_market_data/providers/baostock.py`：Baostock A 股历史字段补数 provider。
- `quantpilot_market_data/providers/akshare.py`：AKShare 可选补数字段 provider。
- `quantpilot_market_data/database_core.py`：数据库连接、日期和序列化等共享基础函数。
- `quantpilot_market_data/repositories/`：TimescaleDB/PostgreSQL 查询、事务、批量写入与分页；不存在聚合 `database.py` 兼容入口。
- `quantpilot_market_data/models.py`：行情数据模型。
- `quantpilot_market_data/api.py`：FastAPI HTTP 服务。
- `quantpilot_market_data/cli.py`：启动入口。

## 说明

东方财富接口不是正式稳定的商业 SDK，这里先按常见的 `push2.eastmoney.com/api/qt/ulist.np/get` 行情接口封装，并内置 `push2delay.eastmoney.com` 作为备用域名。当前已经加入本地 TTL 缓存和响应元信息；后续还需要继续补强限流、更多降级数据源和接口变更监控。
