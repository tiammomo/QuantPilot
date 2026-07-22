# Repository Boundary

`repositories/` 是 TimescaleDB/PostgreSQL 持久化边界。

职责：

- 管理 SQL、连接、事务、批量写入、分页查询和数据库错误转换。
- 把表结构和查询优化细节封装在 repository 内。
- 为 service 层提供稳定函数，例如 bars、universes、factors、ingestion、sector_flow、screener 和 foundation。
- 对板块资金、短线筛选这类读模型，可以在 repository 内保留短 TTL cache-aside；长期状态仍写回 TimescaleDB/ClickHouse。

不放在这里：

- HTTP 状态码和 FastAPI 异常。
- 外部数据源 client。
- 跨业务流程的缓存编排。
- 页面展示字段拼装。

`services/*`、`routers/*` 和 `api.py` 直接依赖领域 repository。旧 `database.py` 聚合门面已删除；新增 SQL、事务和批量写入都进入对应 repository，再由 service 编排。

当前已落地：

- `analytics.py`：ClickHouse 分析日线同步。
- `bars.py`：本地 K 线读取、周/月聚合和收益摘要。
- `coverage.py`：市场数据覆盖摘要、分页明细和 `market_data_sync_state` 在线读模型。
- `foundation.py`：基础组件状态、因子定义、交易日历、数据质量扫描。
- `ingestion.py`：补数任务、控制面、历史补数预检。
- `research.py`：research public facade，保持 service 层稳定导入。
- `screener.py`：A 股短线候选筛选、ClickHouse freshness gate、Redis 查询缓存。
- `sector_flow.py`：板块资金热度、市场摘要、板块趋势详情和 Redis 查询缓存。
- `universes.py`：股票池、成员分页、批量导入和成员读模型。
- `upserts.py`：历史 K 线和实时快照入库。
