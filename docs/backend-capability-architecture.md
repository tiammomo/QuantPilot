# 后端能力架构与持续优化边界

这份文档定义 QuantPilot 后端能力的长期形态。它不是要求一次性重构完所有文件，而是给后续新增市场数据、评测分析、生成观测和基础组件能力一个稳定落点，避免逻辑继续堆进单个 route 或数据库文件里。

## 结论

后端继续以 Python 为主线。当前性能瓶颈优先来自外部数据源稳定性、IO 并发、缓存命中、批量写入、查询模型和异步任务组织，而不是 Python 语言本身。

Go 或 Rust 暂不作为默认拆分方向。只有当 profiling 明确证明 Python 运行时成为瓶颈时才引入：

| 语言 | 合适场景 | 当前动作 |
| --- | --- | --- |
| Python | FastAPI 接口、数据源接入、入库、指标编排、任务调度 | 继续作为主后端 |
| Rust | CPU 密集指标、超大回测内核、列式文件解析、复杂表达式引擎 | 暂不引入，等 profiling 证明 |
| Go | 高并发轻量网关、长连接代理、独立 worker fleet | 暂不引入，等并发瓶颈明确 |

优先优化顺序是：批量接口和批量写入、Redis cache-aside、TimescaleDB 查询模型、ClickHouse append-only 分析层、后台队列，最后才是跨语言拆分。

## 目标形态

市场数据服务采用轻量 Hexagonal Architecture。外部 HTTP、外部数据源、缓存、数据库和分析引擎都在边界上，核心能力以 Use Case 组织。

```mermaid
flowchart LR
  HTTP[FastAPI Router / Controller] --> UC[Use Case / Service]
  UC --> Repo[Repository]
  UC --> Provider[Provider Adapter]
  UC --> Cache[Cache Aside]
  UC --> Analytics[Analytics Adapter]
  Repo --> TS[(TimescaleDB)]
  Analytics --> CH[(ClickHouse)]
  Provider --> EXT[EastMoney / Baostock / AKShare / candidates]
  Cache --> Redis[(Redis)]
```

请求进入后只走一条清晰链路：

1. Router/Controller 解析 HTTP、参数和响应码。
2. Service/Use Case 编排缓存、provider、repository、降级和数据质量。
3. Provider Adapter 只负责外部源协议和字段映射。
4. Repository 只负责 TimescaleDB/PostgreSQL 读写。
5. Analytics Adapter 只负责 ClickHouse 同步和分析查询。
6. Pydantic Model 作为输入输出契约，供前端、Agent 和测试复用。

## 模块边界

`services/market-data/src/quantpilot_market_data` 的长期结构如下：

| 目录或文件 | 角色 | 责任 |
| --- | --- | --- |
| `api.py` | Compatibility Facade | 保留历史入口，逐步只挂载 router，不承载新业务编排 |
| `routers/` | Controller | FastAPI route、参数校验、HTTP 错误转换、响应模型 |
| `services/` | Use Case | 行情、K 线、财务、补数、股票池、基础组件、回测和分析编排 |
| `providers/` | Provider Adapter | 外部行情源、财务源、公告源和候选信源适配 |
| `repositories/` | Repository | TimescaleDB/PostgreSQL 查询、ClickHouse 同步、短 TTL 读模型缓存、批量写入、事务和分页 |
| `database_core.py` | Shared Core | 数据库连接、日期规范化、Decimal/JSON 转换、证券元数据解析等无业务状态工具 |
| `analytics/` | Analytics Adapter | ClickHouse 初始化、同步、宽表和分析查询 |
| `cache.py` | Cache Aside | 本地 JSON 缓存和 Redis 短 TTL 缓存 |
| `models.py` | Contract | Pydantic 请求/响应模型和共享枚举 |

当前 `api.py` 仍承担应用装配和少量待迁移路由；旧 `database.py` 兼容门面已经删除。后续新增能力优先落到目标目录，再由 app factory 显式注册 router。

## 基础组件职责

| 组件 | 当前定位 | 为什么需要 |
| --- | --- | --- |
| TimescaleDB | 事实库 | K 线、因子、交易日历、策略信号等长期可追溯数据 |
| Redis | 短期缓存 | 实时行情、板块资金、任务进度和热点查询降延迟 |
| ClickHouse | 分析加速层 | 全市场筛选、评测事件、生成事件、宽表聚合和大规模扫描 |
| Loki + Alloy + Grafana | 可观测性 | 本地集中日志、生成链路排查、服务状态对照 |
| 文件系统 workspace | 原始产物 | 生成项目源码、证据、大 JSON、截图和验证报告 |
| 服务目录 | 轻量注册表 | Python/Node 服务、基础组件 endpoint、依赖关系和降级边界 |

TimescaleDB 是事实主库，ClickHouse 是旁路分析层。ClickHouse 不替代业务状态，也不承接需要事务一致性的写入。启用 ClickHouse 后，A 股短线筛选会优先读取 `quant_bars_daily`；如果分析表最新交易日落后，会按目标交易日做一次有限增量同步并重试，仍不可用时回退 TimescaleDB，同时在响应 `analytics` 元信息里记录命中、同步和回退原因。最新交易日这类在线读模型优先读取 `quant.market_data_sync_state`，不要在请求链路里聚合全量 `stock_bars`。

筛选器的性能边界是“聚合下推”。ClickHouse 查询应在数据库内完成单标的最新日去重、最近 60 日数组、均线、成交额均值和涨停计数，只把每个标的一行特征返回 Python；Python 侧负责模式过滤、评分和响应组装。不同 `limit` 请求应复用同一批短 TTL 特征行，避免重复扫描横截面。

## 设计模式

| 模式 | 用在这里 | 约束 |
| --- | --- | --- |
| Hexagonal Architecture | HTTP、provider、cache、storage 都作为边界 | 核心服务不直接依赖 FastAPI Request |
| Controller | `routers/` | 只做协议层，不做复杂数据编排 |
| Use Case / Application Service | `services/` | 一个用户动作或接口能力一个服务函数 |
| Repository | `repositories/` | 数据库 SQL 和事务集中管理 |
| Provider Adapter | `providers/` | 外部源字段变化不扩散到页面和 use case |
| Strategy | provider 选择、筛选器、降级路径 | 策略可替换，可测试 |
| Cache Aside | Redis / local JSON cache | 缓存永远不是事实来源 |
| Service Catalog | `config/service-catalog.json` + ops/API | 不引入 Dubbo3，先用轻量目录管理 Python/Node 组件边界 |
| Outbox / Event Log | 评测事件、生成事件、长任务状态 | 后续接 ClickHouse 或队列时可重放 |
| Contract Test | guardrail scripts + backend tests | 防止生成模板、数据口径和接口契约回退 |

## 新增能力落点

| 需求 | 优先落点 |
| --- | --- |
| 新行情源 | `providers/` + `provider_candidates.py` + 数据源文档 |
| 新接口 | `routers/` 新 route + `services/` use case + `models.py` contract |
| 新数据表 | `sqls/` + `repositories/` + 数据字典 |
| 新缓存 | service 内 cache-aside，TTL 写入 README 和 infrastructure |
| 新 ClickHouse 分析 | `analytics/` adapter + init/sync endpoint + 降级说明 |
| 新补数任务 | ingestion service + repository + job/event 记录 |
| 新基础组件 | strategy platform 文档、SQL、后端 registry、运维检查 |

## 迁移计划

1. 以当前 HTTP 合同为唯一入口，不再新增旧字段或旧模块兼容层。
2. 新增目录边界和架构检查，先阻止结构继续失控。
3. 把 `api.py` 中的独立域逐步抽成 router：registry、quotes、history、ingestion、analytics、foundation、backtest。
4. `database.py` 已删除；新增 SQL 直接进入对应 repository，基础连接与转换只进入 `database_core.py`。
5. 把 provider 选择逻辑收敛为 strategy，不让 route 直接感知多个 client。
6. 为 Redis、ClickHouse、provider 降级补 contract tests。
7. 当后台任务规模扩大后，引入队列 worker；优先 Python worker，不提前跨语言。

当前已落地：

- ClickHouse 分析能力已从 `api.py` 抽到 `routers/analytics.py` 和 `services/analytics.py`，URL 保持 `/api/v1/analytics/clickhouse/*` 不变。短线筛选已接入 ClickHouse freshness gate，基础组件状态会展示分析日线行数和最新交易日。后续 analytics 新能力继续沿用这个路径。
- 数据源注册表已从 `api.py` 抽到 `routers/registry.py` 和 `services/registry.py`，provider 元数据按 Registry Pattern 维护，`api.py` 只传入当前 TTL 配置。
- 基础组件能力已从 `api.py` 抽到 `routers/foundation.py` 和 `services/foundation.py`，覆盖组件状态、因子定义、交易日历和数据质量扫描。
- 候选信源能力已从 `api.py` 抽到 `routers/provider_candidates.py` 和 `services/provider_candidates.py`，外部源探针继续保持候选池隔离，不进入主业务链路。
- 回测能力已从 `api.py` 抽到 `routers/backtests.py` 和 `services/backtests.py`，HTTP query 参数解析留在 router，回测编排、缓存和领域计算由 service 完成。
- 缓存写入契约已从 `api.py` 抽到 `services/caching.py`，后续 use case 共享 `read_cached_response` 和 `cache_response`。
- 技术指标、财务摘要/财务衍生指标、公告/分红事件已分别抽到 `routers/indicators.py`、`routers/fundamentals.py`、`routers/events.py` 和对应 service。service 依赖 provider protocol，不直接依赖东方财富实现。
- `providers/base.py` 已补充 `FinancialReportProvider`、`AnnouncementProvider` 和 `DividendEventProvider` 协议，作为后续多 provider adapter 的契约。
- 证券解析、实时行情、批量行情、历史 K 线和 Redis 分时缓存已抽到 `routers/quotes.py` 和 `services/quotes.py`。分时缓存 key、TTL、Redis fallback 和重试逻辑不再留在 `api.py`。
- `providers/base.py` 已补充 `SymbolResolverProvider` 和 `RealtimeQuoteProvider` 协议，行情读取 use case 不再依赖具体 provider 类。
- 研究股票池、成员分页、A 股/ETF 批量导入、本地 bars、覆盖率、板块资金和 A 股筛选器已抽到 `routers/research.py` 和 `services/research.py`。
- `providers/base.py` 已补充 `ResearchUniverseProvider` 协议，股票池导入和证券解析不直接依赖东方财富实现。
- ingestion jobs 控制面已抽到 `routers/ingestion.py` 和 `services/ingestion_jobs.py`，任务列表、暂停、恢复、停止不再留在 `api.py`。
- `services/*`、`routers/*` 和 `api.py` 直接依赖领域 repository；已新增 `repositories/analytics.py`、`repositories/bars.py`、`repositories/coverage.py`、`repositories/foundation.py`、`repositories/ingestion.py`、`repositories/sector_flow.py`、`repositories/screener.py`、`repositories/universes.py`、`repositories/upserts.py` 和 `repositories/research.py`。旧 `database.py` 已删除，基础连接/转换函数位于 `database_core.py`。

## 提交前检查

涉及后端能力、基础组件或生成质量时，至少运行：

```bash
npm run check:backend-architecture
npm run check:quant-guardrails
cd services/market-data && uv run ruff check . && uv run pytest
```

如果只改前端 UI，也不应该破坏这些后端边界文档和 npm script，因为它们是项目长期可维护性的护栏。
