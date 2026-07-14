from __future__ import annotations

from dataclasses import dataclass

from quantpilot_market_data.clickhouse import is_clickhouse_enabled
from quantpilot_market_data.models import DataProviderInfo, DataRegistryResponse


@dataclass(frozen=True)
class ProviderRegistryTtls:
    quote: int
    symbol: int
    kline: int
    financial: int
    announcement: int
    screener: int


def build_data_registry(ttls: ProviderRegistryTtls) -> DataRegistryResponse:
    return DataRegistryResponse(providers=build_data_providers(ttls))


def build_data_providers(ttls: ProviderRegistryTtls) -> list[DataProviderInfo]:
    return [
        DataProviderInfo(
            id="eastmoney-realtime",
            name="东方财富实时行情",
            category="market-data",
            status="available",
            description="A 股实时价格、成交额、市值等快照数据。",
            endpoints=["/api/v1/quotes/realtime/{symbol}", "/api/v1/quotes/realtime"],
            cache_ttl_seconds=ttls.quote,
            limitations=[
                "实时行情使用短 TTL 缓存，盘中价格可能存在数秒延迟。",
                "可通过 /api/v1/ingestion/eastmoney/realtime-snapshot 隔离保存实时观察值。",
            ],
        ),
        DataProviderInfo(
            id="eastmoney-symbol-resolver",
            name="东方财富证券搜索",
            category="symbol",
            status="available",
            description="按股票代码、简称或中文名称解析证券标识和 secid。",
            endpoints=["/api/v1/symbols/resolve"],
            cache_ttl_seconds=ttls.symbol,
        ),
        DataProviderInfo(
            id="eastmoney-kline",
            name="东方财富历史 K 线 / 指数 / ETF",
            category="market-data",
            status="degraded",
            description=(
                "A 股个股、常见指数和 ETF 的日线、周线、月线和常用分钟线历史行情；"
                "当前环境到 push2his 历史域名直连和代理均被断开，保留为优先源但需要降级。"
            ),
            endpoints=["/api/v1/quotes/history/{symbol}"],
            cache_ttl_seconds=ttls.kline,
            limitations=[
                "实时行情、分红和公告接口可用；历史 K 线 push2his 当前在本机不可达。",
                "历史入库默认严格东方财富，不会静默回落到腾讯，避免成交额和换手率缺失被误判。",
            ],
        ),
        DataProviderInfo(
            id="eastmoney-intraday-redis",
            name="东方财富分时行情 Redis 缓存",
            category="market-data",
            status="available",
            description=(
                "按需拉取 A 股 1/5/15/30/60 分钟分时行情，不写入 TimescaleDB；"
                "命中 Redis 直接返回，未命中直连东方财富，缓存到次日 09:00（Asia/Shanghai）。"
            ),
            endpoints=["/api/v1/quotes/history/{symbol}?period=minute1&adjustment=none"],
            cache_ttl_seconds=None,
            limitations=[
                "分时数据用于盘中看盘和即时分析，不参与长期历史回测入库。",
                "Redis 不可用时会降级为直连东方财富，返回数据但不保留临时缓存。",
            ],
        ),
        DataProviderInfo(
            id="quantpilot-technical-indicators",
            name="QuantPilot 技术指标",
            category="indicator",
            status="available",
            description=(
                "基于个股、指数或 ETF 历史 K 线计算 MA5/MA10/MA20、"
                "区间收益、最大回撤和年化波动率。"
            ),
            endpoints=["/api/v1/indicators/technical/{symbol}"],
            cache_ttl_seconds=ttls.kline,
        ),
        DataProviderInfo(
            id="quantpilot-ma-crossover-backtest",
            name="QuantPilot 策略回测",
            category="backtest",
            status="available",
            description=(
                "基于历史 K 线运行单标的趋势、突破、均值回归和波动率策略，"
                "输出净值、回撤、交易明细、胜率、夏普和相对标的收益。"
            ),
            endpoints=[
                "/api/v1/backtests/ma-crossover/{symbol}",
                "/api/v1/backtests/strategies/{strategy_id}/{symbol}",
            ],
            cache_ttl_seconds=ttls.kline,
            limitations=["当前为单标的、全仓/空仓、日线级回测，暂不包含滑点、停牌和分红再投资建模。"],
        ),
        DataProviderInfo(
            id="quantpilot-research-universe",
            name="QuantPilot 策略研究股票池",
            category="research-config",
            status="available",
            description=(
                "读取本地 PostgreSQL/TimescaleDB 中的策略研究股票池、"
                "成员证券和行情覆盖状态。"
            ),
            endpoints=[
                "/api/v1/research/universes",
                "/api/v1/research/a-share/import-batch",
                "/api/v1/research/etf/import-batch",
                "/api/v1/research/data-coverage",
                "/api/v1/research/bars/{symbol}",
                "/api/v1/research/screeners/a-share/short-term-candidates",
                "/api/v1/ingestion/jobs",
            ],
            cache_ttl_seconds=None,
        ),
        DataProviderInfo(
            id="quantpilot-a-share-screener",
            name="QuantPilot A 股选股筛选器",
            category="strategy-screener",
            status="available",
            description=(
                "通过本地 TimescaleDB 的日线行情、涨跌停、均线、强弱和流动性字段，"
                "输出短线候选列表；skills 通过 API 调用，不直接访问数据库。"
            ),
            endpoints=["/api/v1/research/screeners/a-share/short-term-candidates"],
            cache_ttl_seconds=ttls.screener,
            limitations=["DDE 大单金额/大单净量尚未落库，当前筛选为日线量价代理。"],
        ),
        DataProviderInfo(
            id="quantpilot-clickhouse-analytics",
            name="QuantPilot ClickHouse 分析加速层",
            category="analytics",
            status="available" if is_clickhouse_enabled() else "planned",
            description=(
                "可选单节点 ClickHouse OLAP 旁路，用于全市场筛选、因子宽表和批量分析；"
                "TimescaleDB 仍是事实主库。"
            ),
            endpoints=[
                "/api/v1/analytics/clickhouse/health",
                "/api/v1/analytics/clickhouse/init",
                "/api/v1/analytics/clickhouse/sync",
            ],
            cache_ttl_seconds=None,
            limitations=[
                "默认关闭，需要设置 QUANTPILOT_CLICKHOUSE_ENABLED=1。",
                "当前使用显式同步，不替代 TimescaleDB 入库状态。",
            ],
        ),
        DataProviderInfo(
            id="eastmoney-history-ingestion",
            name="东方财富历史行情入库",
            category="ingestion",
            status="degraded",
            description=(
                "按股票池或指定标的拉取东方财富历史 K 线，并幂等写入 TimescaleDB；"
                "当前历史域名不可达。"
            ),
            endpoints=["/api/v1/ingestion/eastmoney/history"],
            cache_ttl_seconds=None,
            limitations=[
                "默认写入前复权日线；分钟线和多复权口径会按 adjustment 单独落库。",
                "支持 request_delay_seconds、max_retries 和 allow_fallback；"
                "allow_fallback 默认关闭。",
            ],
        ),
        DataProviderInfo(
            id="eastmoney-realtime-snapshot-ingestion",
            name="东方财富实时行情快照入库",
            category="ingestion",
            status="available",
            description="把东方财富实时行情写入隔离快照表，不覆盖正式复权日线。",
            endpoints=["/api/v1/ingestion/eastmoney/realtime-snapshot"],
            cache_ttl_seconds=None,
            limitations=[
                "trade_date 必须与 quote_time 的上海日期一致，禁止借实时接口回填历史。",
                "快照是未复权观察值，不写 quant.stock_bars/stock_factors。",
                "实时行情不稳定提供全部 ETF 换手率时，换手率字段会保留为空。",
            ],
        ),
        DataProviderInfo(
            id="tencent-a-share-kline",
            name="腾讯 A 股 K 线兜底",
            category="fallback-provider",
            status="available",
            description=(
                "腾讯公开 K 线端点当前探针可通，"
                "适合在东方财富历史 K 线失败时兜底量价样本。"
            ),
            endpoints=[
                "https://web.ifzq.gtimg.cn/appstock/app/fqkline/get",
                "/api/v1/provider-candidates/probe?provider_id=tencent-a-share-kline",
            ],
            cache_ttl_seconds=ttls.kline,
            limitations=[
                "非官方稳定 API，字段可能变化。",
                "当前只提供 OHLCV 和可推导涨跌幅，成交额、换手率通常为空。",
            ],
        ),
        DataProviderInfo(
            id="ths-public-kline",
            name="同花顺公开 K 线端点",
            category="candidate-provider",
            status="available",
            description=(
                "同花顺网页历史线数据端点当前探针可通，"
                "可作为 A 股历史 K 线候选源继续解析验证。"
            ),
            endpoints=[
                "https://d.10jqka.com.cn/v6/line/hs_{symbol}/01/all.js",
                "/api/v1/provider-candidates/probe?provider_id=ths-public-kline",
            ],
            cache_ttl_seconds=ttls.kline,
            limitations=[
                "网页公开端点不是正式 SLA，返回为压缩 JavaScript，需要单独解析和字段校验。",
                "接入入库前需要确认复权口径、成交额、换手率和停牌样本。",
            ],
        ),
        DataProviderInfo(
            id="baostock-a-share-history",
            name="Baostock A 股历史行情",
            category="enrichment-provider",
            status="available",
            description="独立 A 股历史数据服务，已接入用于补日线成交额、换手率、涨跌幅和复权字段。",
            endpoints=[
                "/api/v1/ingestion/baostock/history",
                "/api/v1/ingestion/baostock/history/batch",
                "Python SDK: baostock.query_history_k_data_plus",
            ],
            cache_ttl_seconds=None,
            limitations=[
                "适合 A 股日/周/月历史补数，不用于实时行情主链路。",
                "当前已沉淀成交额、换手率、停牌/ST、涨跌停和 PE/PB/PS/PCF 等估值字段。",
                "Baostock volume 为股数，入库时折算成手，避免破坏现有 K 线量能展示口径。",
            ],
        ),
        DataProviderInfo(
            id="akshare-provider",
            name="AKShare 聚合数据源",
            category="enrichment-provider",
            status="degraded",
            description=(
                "Python 聚合数据源；当前用于补 A 股历史 K 线的成交额、振幅、"
                "涨跌额和换手率，作为东方财富历史端点不可达时的字段增强层。"
            ),
            endpoints=[
                "/api/v1/ingestion/akshare/history",
                "Python SDK: akshare.stock_zh_a_hist",
            ],
            cache_ttl_seconds=None,
            limitations=[
                "需要安装可选依赖：cd services/market-data && uv sync --extra akshare。",
                "部分 AKShare 接口本质仍依赖东方财富或网页公开端点，需要低频补数和字段质量检查。",
            ],
        ),
        DataProviderInfo(
            id="yahoo-finance-chart",
            name="Yahoo Finance Chart API / yfinance",
            category="fallback-provider",
            status="available",
            description=(
                "Yahoo Finance Chart API 当前探针可通，适合海外股票、ETF 和指数历史行情；"
                "后续可用 yfinance 封装。"
            ),
            endpoints=[
                "https://query1.finance.yahoo.com/v8/finance/chart/{symbol}",
                "/api/v1/provider-candidates/probe?provider_id=yahoo-finance-chart",
            ],
            cache_ttl_seconds=ttls.kline,
            limitations=[
                "非官方接口，可能限流或调整返回结构。",
                "主要用于海外市场，不作为 A 股历史行情主源。",
            ],
        ),
        DataProviderInfo(
            id="ths-ifind-quantapi",
            name="同花顺 iFinD / QuantAPI",
            category="licensed-provider",
            status="planned",
            description=(
                "同花顺正式数据接口，覆盖历史行情、基本面和指标数据，"
                "通常需要 iFinD 终端或授权账号。"
            ),
            endpoints=["同花顺 iFinD QuantAPI"],
            cache_ttl_seconds=None,
            limitations=[
                "需要商业授权、终端环境或账号登录，当前本地未配置凭证。",
                "适合正式生产数据源评估，不应和网页公开端点混为一类。",
            ],
        ),
        DataProviderInfo(
            id="eastmoney-index-etf-market",
            name="东方财富指数与 ETF 行情",
            category="index-etf",
            status="available",
            description=(
                "常见指数和 ETF 的实时行情、历史 K 线与技术指标，"
                "支持沪深300、创业板指、中证500、科创50、510300 等。"
            ),
            endpoints=[
                "/api/v1/symbols/resolve",
                "/api/v1/research/etf/import-batch",
                "/api/v1/quotes/realtime/{symbol}",
                "/api/v1/quotes/history/{symbol}",
                "/api/v1/indicators/technical/{symbol}",
            ],
            cache_ttl_seconds=ttls.kline,
            limitations=["指数/ETF 默认不提供个股财务摘要和公告事件。"],
        ),
        DataProviderInfo(
            id="eastmoney-financial-summary",
            name="东方财富财务摘要",
            category="fundamental",
            status="available",
            description="上市公司主要财务指标、营收、归母净利润、ROE、毛利率等。",
            endpoints=["/api/v1/fundamentals/financials/{symbol}"],
            cache_ttl_seconds=ttls.financial,
        ),
        DataProviderInfo(
            id="quantpilot-fundamental-indicators",
            name="QuantPilot 财务衍生指标",
            category="fundamental",
            status="available",
            description="基于财务摘要计算净利率、平均 ROE、平均毛利率和最近报告期核心指标。",
            endpoints=["/api/v1/indicators/fundamental/{symbol}"],
            cache_ttl_seconds=ttls.financial,
        ),
        DataProviderInfo(
            id="eastmoney-announcements",
            name="东方财富公告事件",
            category="event",
            status="available",
            description="上市公司公告标题、公告日期、栏目和详情链接。",
            endpoints=["/api/v1/events/announcements/{symbol}"],
            cache_ttl_seconds=ttls.announcement,
            limitations=["公告列表按东方财富公开接口返回，公告全文解析后续单独增强。"],
        ),
        DataProviderInfo(
            id="eastmoney-dividend-events",
            name="东方财富分红送配事件",
            category="event",
            status="available",
            description="上市公司分红送配、股权登记日和除权除息日事件。",
            endpoints=["/api/v1/events/dividends/{symbol}"],
            cache_ttl_seconds=ttls.financial,
            limitations=["分红送配来自东方财富数据中心公开接口，图表默认用除权除息日对齐 K 线。"],
        ),
        DataProviderInfo(
            id="tushare-akshare-openbb",
            name="免费/免费层候选信源测试池",
            category="planned-provider",
            status="available",
            description=(
                "用于评估腾讯、新浪、同花顺公开端点、Stooq、Yahoo Finance、Alpha Vantage、"
                "Finnhub、Twelve Data 等候选信源。"
            ),
            endpoints=["/api/v1/provider-candidates", "/api/v1/provider-candidates/probe"],
            limitations=["候选源不会直接替换主链路，必须先通过探针和数据质量评估。"],
        ),
    ]
