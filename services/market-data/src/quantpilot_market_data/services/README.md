# Service Boundary

`services/` 是市场数据服务的 Use Case 层。

职责：

- 组织一个业务动作，例如获取实时行情、读取本地 K 线、启动补数任务、同步 ClickHouse 或生成基础组件状态。
- 决定 cache-aside、provider fallback、repository 读写顺序和数据质量说明。
- 返回 Pydantic contract 或纯领域结果，供 router 转成 HTTP 响应。

设计约束：

- Service 不直接依赖 FastAPI `Request`。
- Service 可以依赖 provider protocol、repository 函数、cache 和 analytics adapter。
- Service 中的降级路径需要能被测试覆盖。

当前已落地 `analytics.py`、`registry.py`、`foundation.py`、`provider_candidates.py`、`backtests.py`、`indicators.py`、`fundamentals.py`、`events.py`、`quotes.py`、`context.py`、`research.py`、`ingestion_jobs.py` 和共享 `caching.py`。下一批迁移优先级：provider ingestion 执行流。
