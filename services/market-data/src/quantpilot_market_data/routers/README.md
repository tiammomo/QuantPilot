# Router Boundary

`routers/` 是市场数据服务的 Controller 层。

职责：

- 定义 FastAPI route、query/body 参数和响应模型。
- 把 HTTPException、状态码、分页参数和请求上下文限制在协议层。
- 调用 `services/` 中的 use case，不直接编排 provider、cache 和 repository。

不放在这里：

- 外部数据源协议和字段映射。
- SQL、事务、批量写入和分页查询细节。
- 复杂指标计算、补数流程和降级策略。

迁移策略：保留 `api.py` 的兼容入口，新增领域优先拆到独立 router，再由 `api.py` 或应用工厂挂载。当前已落地 `analytics.py`、`registry.py`、`foundation.py`、`provider_candidates.py`、`backtests.py`、`indicators.py`、`fundamentals.py`、`events.py`、`quotes.py`、`context.py`、`research.py` 和 `ingestion.py`。
