# QuantPilot 市场数据服务

这个子模块用于给量化分析 Agent 提供基础行情、财务和事件数据能力。当前以东方财富为主数据源，已接入实时行情、证券解析、财务摘要和公告事件；历史 K 线接口已预留，但外部源偶发断连，后续会继续接入 AKShare/Tushare 作为降级源。

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

如果需要补 A 股历史 K 线的成交额、振幅、涨跌额和换手率，可安装 Baostock / AKShare 可选依赖：

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

# 东方财富主备域名，按顺序失败重试
export EASTMONEY_BASE_URLS=https://push2.eastmoney.com,https://push2delay.eastmoney.com

# 本地缓存；默认开启，默认目录为 ~/.cache/quantpilot/market_data
export QUANTPILOT_MARKET_CACHE_ENABLED=1
export QUANTPILOT_MARKET_CACHE_DIR=/tmp/quantpilot-market-cache
export QUANTPILOT_QUOTE_CACHE_TTL_SECONDS=5
export QUANTPILOT_KLINE_CACHE_TTL_SECONDS=1800
export QUANTPILOT_FINANCIAL_CACHE_TTL_SECONDS=21600
export QUANTPILOT_ANNOUNCEMENT_CACHE_TTL_SECONDS=600

# Redis 跨进程短期缓存；默认由根目录 docker-compose 拉起
export REDIS_URL=redis://127.0.0.1:6379/0
export REDIS_NAMESPACE=quantpilot
export QUANTPILOT_REDIS_CACHE_ENABLED=1
```

## 接口

### 健康检查

```bash
curl http://127.0.0.1:8000/health
```

### 数据源注册表

```bash
curl http://127.0.0.1:8000/api/v1/registry
```

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

说明：当前东方财富历史 K 线外部源偶发断连，注册表会将能力标记为 `degraded`。调用失败时应展示真实错误，并降级到实时行情、财务摘要和公告事件。

### 历史 K 线字段补数

Baostock / AKShare 补数端点用于把 `amount`、`amplitude`、`change_percent`、`change_amount`、`turnover` 写入 `quant.stock_bars` 正式列。它不会删除已有更早历史，稀疏源也不会覆盖已有非空增强字段。当前本地优先使用 Baostock，因为它不依赖东方财富历史域名。

```bash
curl -X POST 'http://127.0.0.1:8000/api/v1/ingestion/baostock/history' \
  -H 'Content-Type: application/json' \
  -d '{"symbols":["002156.SZ","002555.SZ"],"period":"daily","adjustment":"qfq","lookback_years":5,"limit":1260,"request_delay_seconds":1.5}'
```

更完整的 provider 选择和字段口径见项目根目录的 `docs/market-data-source-knowledge.md`。

### 技术指标

```bash
curl 'http://127.0.0.1:8000/api/v1/indicators/technical/600519?period=daily&adjustment=qfq&limit=120'
```

返回 MA5/MA10/MA20、单日收益率、回撤序列、区间收益、最大回撤、年化波动率和 20 日平均成交量。

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
- `quantpilot_market_data/models.py`：行情数据模型。
- `quantpilot_market_data/api.py`：FastAPI HTTP 服务。
- `quantpilot_market_data/cli.py`：启动入口。

## 说明

东方财富接口不是正式稳定的商业 SDK，这里先按常见的 `push2.eastmoney.com/api/qt/ulist.np/get` 行情接口封装，并内置 `push2delay.eastmoney.com` 作为备用域名。当前已经加入本地 TTL 缓存和响应元信息；后续还需要继续补强限流、更多降级数据源和接口变更监控。
