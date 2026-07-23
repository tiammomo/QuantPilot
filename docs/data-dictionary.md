# 数据字典

这份文档记录 QuantPilot 当前最重要的数据表、字段口径和使用边界。它的目标不是替代 SQL，而是让前端、后端、skills 和评测在同一套事实上工作。

## 存储分层

| 层 | 存储 | 典型表/目录 | 说明 |
| --- | --- | --- | --- |
| 主业务状态 | PostgreSQL public schema | Prisma models | 项目、消息、设置、token、评测、策略扫描状态、投研日报 |
| 量化事实库 | PostgreSQL/TimescaleDB `quant` schema | `stock_bars`、`stock_factors`、`securities` | 行情、因子、股票池、补数、回测 |
| 短期缓存 | Redis | `quantpilot:*` | 板块资金、行情摘要、接口短 TTL，不作为事实库 |
| 生成原件 | 文件系统 | `data/projects/` | 生成工作空间源码、数据文件、证据和验证报告 |
| 临时报表 | 文件系统 / Loki | `tmp/`、Loki | 评测报告、运行日志、视觉截图和队列日志 |

## Prisma 主业务表

| 表 | 来源 | 责任 |
| --- | --- | --- |
| `projects` | `Project` | 首页项目、canonical workspace 路径、Profile ID/版本、Data Agent 组合 SHA-256、模型偏好、预览状态和项目 owner |
| `messages` | `Message` | 用户、助手、工具调用和错误消息 |
| `sessions` | `Session` | 旧版 Agent session 兼容记录；MoAgent 当前运行不依赖 provider session |
| `tool_usages` | `ToolUsage` | 旧版通用工具记录；包含 raw input/output，不得用于 MoAgent durable ledger |
| `user_requests` | `UserRequest` | 用户请求队列和执行状态；`actor_user_id` 记录发起账号并参与 request ID 防串用校验 |
| `agent_runs` | `AgentRun` | MoAgent 物理执行、发起账号、run/workspace 双重 fencing、usage、终态和 provenance hashes |
| `agent_workspace_leases` | `AgentWorkspaceLease` | 每个 project/canonical workspace 的跨进程独占 lease、active run 和单调 fencing token |
| `agent_generation_leases` | `AgentGenerationLease` | 每个 Project 的 planning、prefetch、Agent execution 和 validation 外层编排租约 |
| `agent_generation_jobs` | `AgentGenerationJob` | HTTP 返回前持久化的 generation envelope、attempt、dispatch lease、fencing 和终态 |
| `agent_generation_outbox_events` | `AgentGenerationOutboxEvent` | Job 生命周期的事务 outbox 与可重放投影事件 |
| `agent_worker_slots` | `AgentWorkerSlot` | 跨 Worker 进程共享的全局执行容量槽、活跃 Job、lease 和 fencing |
| `agent_worker_instances` | `AgentWorkerInstance` | Worker 进程注册、主机/PID、单进程与全局容量配置、heartbeat 和存活租约 |
| `agent_events` | `AgentEvent` | 经过安全 projector 的低频生命周期事件；源 sequence 可有间隙 |
| `agent_checkpoints` | `AgentCheckpoint` | 只用于 `replan_required` 的安全边界元数据，不保存 messages/prompt/reasoning |
| `agent_tool_executions` | `AgentToolExecution` | framework operation ID、effect/idempotency、`prepared`/`commit_authorized`/`uncertain` 状态、run/workspace fencing token 与安全 receipt |
| `env_vars` | `EnvVar` | 项目环境变量，写入 workspace `.env` |
| `service_tokens` | `ServiceToken` | 外部服务 token；新写入使用 AES-256-GCM 加密，旧明文记录在读取时渐进迁移 |
| `project_service_connections` | `ProjectServiceConnection` | GitHub/Vercel/Supabase 项目连接 |
| `commits` | `Commit` | 项目关联 commit 元数据 |
| `platform_settings` | `PlatformSetting` | 平台级设置 |
| `strategy_scan_runs` | `StrategyScanRun` | 策略扫描运行结果 |
| `strategy_scan_jobs` | `StrategyScanJob` | 策略扫描单标的任务 |
| `research_watchlists` | `ResearchWatchlist` | 投研日报观察池、市场范围、计划和关联推送通道 |
| `research_report_runs` | `ResearchReportRun` | 日报生成运行记录、状态、错误和证据元信息 |
| `research_reports` | `ResearchReport` | Markdown/JSON 日报、评分、建议、风险等级和 evidence |
| `notification_channels` | `NotificationChannel` | 企业微信、飞书、钉钉、Telegram、Discord、邮件等推送通道配置 |
| `notification_deliveries` | `NotificationDelivery` | 推送或 dry-run 推送记录 |
| `eval_runs` | `EvalRun` | 评测报告索引和摘要 |
| `eval_queue_items` | `EvalQueueItem` | 评测队列任务 |
| `eval_repair_tickets` | `EvalRepairTicket` | 失败修复单 |
| `eval_schedules` | `EvalSchedule` | 定时评测配置 |
| `auth_users` | `AuthUser` | 登录用户、邮箱、`admin/member` 平台角色、停用状态、首次改密和最近登录时间 |
| `auth_accounts` | `AuthAccount` | 本地 credential 账号与 Argon2id 密码哈希；不保存明文密码 |
| `auth_sessions` | `AuthSession` | 数据库登录会话、到期时间和请求设备摘要；与旧 Agent `sessions` 完全独立 |
| `auth_verifications` | `AuthVerification` | 一次性验证记录，为后续验证/重置流程预留 |
| `auth_rate_limits` | `AuthRateLimit` | 跨进程共享的认证接口限流计数 |
| `project_memberships` | `ProjectMembership` | 用户与项目的 `owner/editor/viewer` 权限；同一用户在同一项目唯一 |
| `auth_audit_events` | `AuthAuditEvent` | 登录、改密、用户治理、项目授权和权限拒绝事件；只保存安全摘要，不保存密码/token |
| `permission_profiles` | `PermissionProfile` | 可分配的账号 capability 模板；至多一个默认模板 |
| `permission_profile_grants` | `PermissionProfileGrant` | 模板中的 capability `allow/deny`；同一模板和 key 唯一 |
| `user_permission_overrides` | `UserPermissionOverride` | 用户级 capability `allow/deny`、变更原因和可选到期时间 |
| `quota_profiles` | `QuotaProfile` | 可分配的配额模板；至多一个默认模板 |
| `quota_rules` | `QuotaRule` | 模板 metric 上限、`observe/warn/hard`、窗口与 reservation TTL |
| `user_quota_overrides` | `UserQuotaOverride` | 用户级限额/无限覆盖、执行模式、窗口、原因和可选到期时间 |
| `usage_buckets` | `UsageBucket` | actor + metric + 窗口唯一的 `used/reserved` 聚合计数和并发更新版本 |
| `quota_reservations` | `QuotaReservation` | 执行前资源预留及其策略快照、TTL、结算/释放状态和幂等键 |
| `usage_events` | `UsageEvent` | 实际用量/调整的幂等事实账本，关联 actor、project、reservation、bucket 和业务 source |

Prisma 表只管理平台状态，不承载大体量 K 线和生成源码。工作空间原件仍在 `data/projects/`。

认证授权以 `projects.owner_id` 和 `project_memberships` 为项目归属事实源。owner 同时保留一条 owner membership，便于列表和审计；服务端判定时 `projects.owner_id` 优先。`auth_users.banned` 表示账号停用，`must_change_password` 会将账号限制在账户安全和退出相关入口，`password_changed_at` 与 `last_login_at` 用于管理员判断账号生命周期。`auth_sessions.token`、`auth_accounts.password` 属于敏感认证数据，任何列表 API、审计 metadata、日志和 Skills 都不得返回或记录原值。

`auth_users.permission_profile_id` 与 `quota_profile_id` 分别指向账号 capability 和配额模板；`access_version` 是非负乐观锁版本。管理员更新权限/配额时必须提交读取到的版本和变更原因，事务成功后版本加一，防止两位管理员静默覆盖。`user_*_overrides.expires_at` 为空表示长期有效，否则只在到期前参与策略解析。权限覆盖与模板合并时任何有效 `deny` 优先；项目范围 capability 还必须与 `owner/editor/viewer` 的角色规则取交集。

### 权限与配额事实模型

| 数据关系 | 不变量 |
| --- | --- |
| `permission_profiles -> permission_profile_grants` | `profile_id + permission_key` 唯一，effect 只能是 `allow/deny`；未知 capability 在应用层失败关闭 |
| `quota_profiles -> quota_rules` | `profile_id + metric` 唯一，limit 必须大于 0；window 只能是 `minute/hour/day/month/fixed/lifetime` |
| `auth_users -> user_*_overrides` | `user_id + permission_key/metric` 唯一；override 可以到期，管理员策略在应用层固定为全权限和无限配额 |
| `usage_buckets` | `actor_user_id + metric + window_start + window_end` 唯一；`used/reserved` 不得为负，版本只递增 |
| `quota_reservations` | `idempotency_key` 全局唯一；状态为 `active/settled/released/expired`，创建时保存 limit、enforcement、window 的策略快照 |
| `usage_events` | `idempotency_key` 唯一且每个 reservation 至多一个结算事件；`quantity` 可用于正向用量或受控冲正，bucket 不得下溢 |

reservation 创建时先把数量原子加入 `usage_buckets.reserved`；settlement 按实际数量减少预留、增加 `used` 并新增 `usage_events`，release/expire 只归还 `reserved`。`hard` 模式使用 `used + reserved + requested <= limit` 的条件更新防止并发超卖；`observe/warn` 允许越过阈值但保留 `exceeded` 状态。管理员和未配置 metric 的策略可无限使用，事件通过 `enforcement_exempt=true` 表示免于拦截，实际数量仍然计入 bucket 和账本。

`agent.pending` 与 `agent.concurrent` 是结构指标，不走上述 reservation 生命周期。前者统计 actor 的非终态、尚未 running 的 UserRequest/GenerationJob，后者统计 actor 的 running GenerationJob；入口和 claim 都先锁 `auth_users` 行再检查用户策略，管理 API 把实时数量投影到 `reserved` 字段，避免队列等待超过 TTL 后出现假释放。

`user_requests.actor_user_id` 在认证启用时来自当前数据库会话，`agent_runs.actor_user_id` 从绑定的 request 继承，`usage_events.actor_user_id` 再由执行或 reservation 传播。它们和业务 `source_type/source_id` 一起回答“谁在什么项目、由哪次执行产生了多少用量”。历史请求/run 可以保留空 actor，迁移不做猜测式回填；`usage_events.actor_user_id`、`project_id`、`reservation_id` 和 `bucket_id` 允许在关联对象删除后置空以保留用量事实。API 输出这些 `BIGINT` 计数时使用十进制字符串。

默认成员模板包含 9 条规则：`projects.owned=10 hard/lifetime`、`agent.pending=4 hard/lifetime`、`agent.concurrent=2 hard/lifetime`、`agent.requests.daily=100 hard/day`、`llm.total_tokens.monthly=2000000 warn/month`、`query_rewrite.llm.daily=200 hard/day`、`quant.data_units.daily=2000 warn/day`、`research.report_runs.daily=20 hard/day`、`research.report_sends.daily=10 hard/day`。两个 Agent 结构指标由 UserRequest/GenerationJob 当前状态计算，不依赖 TTL reservation；管理员解析为无限但仍展示真实结构占用和计量用量。

MoAgent durable JSON 通过 deny-by-default 策略校验，禁止 reasoning、完整 messages、system prompt、raw provider payload、凭据和 raw cause。工具原始参数/结果只以 SHA-256、UTF-8 字节数和受控计数进入 `agent_events`/`agent_tool_executions`；文件内容仍以工作空间为事实源。`agent_runs.workspace_key` 与 `agent_workspace_leases.workspace_key` 都是 deployment namespace 与 canonical realpath 的 `sha256:<64 hex>` 身份，不保存宿主绝对路径，也不等同于会随内容变化的 `workspace_hash`。`agent_runs.workspace_key` 没有数据库默认值，调用方必须显式提供；数据库 check constraint 和启动 readiness 会拒绝格式漂移。

## 量化时序表

### `quant.stock_bars`

股票、ETF、指数 K 线事实表。唯一口径是：

```text
symbol + timeframe + adjustment + ts
```

| 字段 | 类型/口径 | 来源 | 使用位置 |
| --- | --- | --- | --- |
| `symbol` | 规范代码，如 `002156.SZ` | 证券主数据/解析器 | 股票池、K 线、回测 |
| `ts` | 交易时间，日线通常是交易日 | provider | K 线图、回测窗口 |
| `timeframe` | `daily`、`weekly`、`monthly` | 请求参数/聚合 | 日/周/月切换 |
| `adjustment` | `qfq`、`hfq`、`none` | 请求参数 | 复权口径隔离 |
| `open/high/low/close` | OHLC 价格 | 东方财富/Baostock/AKShare | K 线、MA、回测 |
| `previous_close` | 前收盘 | Baostock/腾讯/推导 | 涨跌幅、涨跌停 |
| `volume` | 成交量 | provider | 成交量柱、流动性 |
| `amount` | 成交额，CNY | 东方财富 f57、Baostock/AKShare | 流动性、资金代理 |
| `amplitude` | 振幅，% | 东方财富 f58、AKShare | 波动判断 |
| `change_percent` | 涨跌幅，% | 东方财富 f59、AKShare/Baostock | 涨跌、涨跌停 |
| `change_amount` | 涨跌额 | 东方财富 f60、AKShare | 行情摘要 |
| `turnover` | 换手率，% | 东方财富 f61、Baostock/AKShare | 流动性、活跃度 |
| `trade_status` | 交易状态 | Baostock | 停牌过滤 |
| `is_st` | 是否 ST | Baostock | 风险过滤、涨跌停规则 |
| `limit_up/limit_down` | 涨停/跌停标记 | 由涨跌幅和板块规则推导 | K 线标记、短线策略 |
| `provider` | 入库来源 | provider | 数据质量和溯源 |
| `metadata` | 原始字段和扩展字段 | provider | 口径追溯、兜底 |

不要用空值或 0 假装字段已采集。缺失时应在页面和 `data_quality` 中说明缺口。

### `quant.stock_factors`

因子值事实表，保存某个 symbol 某天某个因子的值。

| 字段 | 口径 |
| --- | --- |
| `symbol` | 规范证券代码 |
| `ts` | 因子生效日期或交易日 |
| `factor_key` | 因子键，如 `ma5`、`ret_20d`、`pb_mrq` |
| `factor_value` | 数值型结果 |
| `provider` | `quantpilot`、`baostock`、`eastmoney` 等 |
| `metadata` | 行业中性化、窗口、原始字段等扩展 |

因子解释不放在这里，放在 `quant.factor_definitions`。

### `quant.strategy_signals`

策略信号表，保存策略在某个标的某个时间点输出的信号。

| 字段 | 口径 |
| --- | --- |
| `strategy_id` | 策略唯一键 |
| `symbol` | 标的 |
| `ts` | 信号时间 |
| `signal` | `buy`、`sell`、`hold`、`watch` 等 |
| `strength` | 信号强度 |
| `price` | 参考价格 |
| `metadata` | 触发因子、阈值、排除原因 |

信号不等于投资建议，页面必须展示风控和限制说明。

### `quant.portfolio_snapshots`

组合净值快照。

| 字段 | 口径 |
| --- | --- |
| `portfolio_id` | 组合 ID |
| `ts` | 快照时间 |
| `total_value` | 总资产 |
| `cash` | 现金 |
| `exposure` | 风险暴露 |
| `drawdown` | 回撤 |
| `metadata` | 持仓、费用、滑点等 |

## 证券主数据与股票池

### `quant.securities`

证券主数据。

| 字段 | 口径 | 说明 |
| --- | --- | --- |
| `symbol` | `002156.SZ` | 主键 |
| `code` | `002156` | 原始代码 |
| `name` | 通富微电 | 页面主显示 |
| `exchange` | `SZ`、`SH` 等 | 交易所 |
| `asset_type` | `stock`、`etf`、`index` | 股票池拆分关键字段 |
| `currency` | `CNY` | 币种 |
| `timezone` | `Asia/Shanghai` | 时区 |
| `secid` | 东方财富 secid | 实时/历史接口 |
| `provider` | 主数据来源 | 默认 `eastmoney` |
| `listed_at` | 上市日期 | 样本覆盖判断 |
| `status` | `active` 等 | 可交易性过滤 |
| `metadata` | 行业、地区、概念、板块标签 | 股票池展示和筛选 |

所属板块优先从 `metadata` 中稳定字段读取，例如行业、概念、地区和交易所板块。

### `quant.security_universes`

股票池/ETF 池定义表。

| 字段 | 口径 |
| --- | --- |
| `id` | 池 ID，如 `a-share-stocks`、`etf-index-pool` |
| `name` | 页面显示名 |
| `description` | 用途说明 |
| `status` | `active`、`archived` |
| `source` | `eastmoney`、`manual`、`quantpilot` |
| `tags` | 分组标签 |
| `metadata` | 池规则、统计摘要 |

### `quant.security_universe_members`

池成员关系表。拆分股票池和 ETF/指数池时只改这张表的成员关系，不删除 `stock_bars` 历史。当前可交易研究池以 `role <> 'inactive'` 且 `quant.securities.status` 不是 `inactive`/`delisted` 为默认边界。

| 字段 | 口径 |
| --- | --- |
| `universe_id` | 股票池 ID |
| `symbol` | 证券代码 |
| `role` | `member`、`benchmark`、`inactive` 等；`inactive` 表示保留历史但默认业务入口不再扫描 |
| `weight` | 可选权重 |
| `metadata` | 加入原因、来源；自动清洗会写入 `metadata.hygiene`，记录原因、目标交易日、原 role/status 和新状态 |
| `added_at` | 加入时间 |

## 补数、覆盖和回测表

| 表/视图 | 责任 |
| --- | --- |
| `quant.market_data_ingestion_jobs` | 市场数据补数任务，记录 provider、范围、状态、进度、错误和统计 |
| `quant.market_data_sync_state` | 单标的同步水位，记录 first/last ts、行数、最近成功和错误；在线覆盖接口优先读取这张表 |
| `quant.market_data_coverage` | 基于 `stock_bars` 聚合的数据覆盖视图，适合离线核对，不作为页面首屏默认读模型 |
| `quant.backtest_runs` | 回测任务和指标摘要 |
| `quant.backtest_orders` | 回测成交明细 |

补数任务状态建议使用：

```text
queued -> running -> completed
queued/running -> paused
queued/running -> stopped
running -> failed
```

`paused` 和 `stopped` 都不删除已入库事实数据。

## 基础组件表

| 表 | 责任 | 页面 |
| --- | --- | --- |
| `quant.trading_calendars` | 交易日历、预期样本、补数跳过和回测窗口 | 策略平台基础组件 |
| `quant.factor_definitions` | 因子公式、依赖、解释和状态 | 策略平台因子目录 |
| `quant.data_quality_scans` | 数据质量扫描摘要和 issue | 策略平台基础组件 |
| `quant.platform_jobs` | 通用平台任务表，后续承载独立 worker | 运维/策略任务 |

## 当前高价值因子

### 财务与基本面 API 字段

| 字段 | 位置 | 单位/口径 | 缺失处理 |
| --- | --- | --- | --- |
| `operating_cash_flow_per_share` | `financials.reports[]`、`fundamentalIndicators.points[]` | 每股经营活动现金流净额；东方财富原始字段 `MGJYXJJE` | 不得以 0 补缺；兼容读取 raw 时需保留来源 |
| `operating_cash_flow_per_share_yoy` | `fundamentalIndicators.points[]` | 同一月日、上一会计年度报告期的同比，百分点值，如 `8.71` 表示 `8.71%` | 上期缺失或为 0 时返回 `null`，不猜测 |
| `latest_operating_cash_flow_per_share` | `fundamentalIndicators.summary` | 最新报告期每股经营活动现金流净额 | 没有有效报告时为 `null` |
| `latest_operating_cash_flow_per_share_yoy` | `fundamentalIndicators.summary` | 最新报告期每股经营活动现金流同比 | 没有可比上期时为 `null` |

经营现金流增速与净利润增速比较必须使用同一报告期。结论属于确定性派生结果，应同时保存两个输入值、报告期、来源和缺失说明。

| 因子 | 类型 | 数据依赖 | 状态 |
| --- | --- | --- | --- |
| `ma5/ma10/ma20/ma30/ma60` | 技术趋势 | `stock_bars.close` | 可计算 |
| `ret_20d/ret_60d` | 相对强弱 | `stock_bars.close` | 可计算 |
| `ma_stack_score` | 均线多头质量 | MA 族 | 可计算 |
| `amount_ratio_20d` | 成交额放大倍数 | `stock_bars.amount` | 字段完整后可计算 |
| `realized_vol_20d` | 实现波动 | 日收益率 | 可计算 |
| `max_drawdown_60d` | 60 日最大回撤 | `stock_bars.close` | 可计算 |
| `pe_ttm/pb_mrq/ps_ttm/pcf_ncf_ttm` | 估值 | `stock_factors` 或 provider | 部分可用 |
| `value_composite` | 复合估值 | 估值族 | 依赖覆盖 |
| `profitability_quality` | 盈利质量 | 财报质量字段 | 待补财报 |
| `growth_acceleration` | 成长加速度 | 财报同比字段 | 待补财报 |
| `sector_flow_heat` | 板块资金热度 | 板块资金/成交额代理 | 部分可用 |

## 数据质量口径

| 检查 | 判定 |
| --- | --- |
| K 线覆盖 | first/last ts、row_count 与交易日历期望对齐 |
| 字段完整 | `amount`、`turnover`、`change_percent`、`previous_close` 等关键字段非空率 |
| 复权隔离 | `qfq`、`hfq`、`none` 不互相覆盖 |
| 股票池边界 | `stock` 不混 ETF/指数，ETF/指数不参与默认个股策略 |
| 涨跌停/ST | `is_st`、`limit_up`、`limit_down` 不能粗暴全按 10% |
| 估值因子 | ETF/指数为空正常，普通个股缺失需记录缺口 |

## 维护规则

- 新增 SQL 表或字段后，同步更新本文件和 `sqls/README.md`。
- 新增 provider 字段后，同步更新 `docs/market-data-source-knowledge.md`。
- 页面新增指标时，必须能在本文件找到来源和口径。
- 缓存字段不能作为长期事实；会影响回测或选股的结果必须落库或写入 evidence。
