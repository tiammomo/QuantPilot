# API 总览

这份文档记录 QuantPilot 当前对外和内部页面使用的主要 API。它不是替代源码的逐行说明，而是帮助维护者快速判断“这个页面读的是哪个入口、后端职责在哪里、出问题先看哪一层”。

## 服务边界

| 服务 | 默认地址 | 代码位置 | 责任 |
| --- | --- | --- | --- |
| Next.js 主应用 API | `http://localhost:3000/api/*` | `src/app/api/` | 项目、聊天、设置、评测、skills、运维和页面聚合数据 |
| 市场数据服务 | `http://127.0.0.1:8000/api/v1/*` | `services/market-data/src/quantpilot_market_data/api.py` | 行情、K 线、财务、公告、补数、基础组件、股票池和回测 |
| 用户记忆服务 | `http://127.0.0.1:38089/*` | 独立 `evolvable-user-memory` 仓库 | 偏好证据、不可变修订、召回 Trace、上下文投影和可归因 Outcome |
| 预览工作空间 | `http://localhost:4100+` | `data/projects/project-*` | AI 生成项目的 Next.js 预览，不承载平台状态 |

页面原则：

- 页面不直接访问外部行情网站；外部源通过市场数据服务采集。
- Next.js API route 只做请求解析、权限/参数校验、聚合和服务调用。
- 长期事实数据最终写入 PostgreSQL/TimescaleDB；Redis 只做短期缓存。
- 生成工作空间里的数据必须从 `data_file/final/` 和 `evidence/` 读取，不把平台 API 当作隐藏 mock。

## Next.js 主应用 API

### 项目与工作空间

| 路由 | 方法 | 调用方 | 责任 |
| --- | --- | --- | --- |
| `/api/projects` | `GET/POST` | 首页工作台 | 项目列表、创建项目和 workspace 索引 |
| `/api/projects/[project_id]` | `GET/PATCH/DELETE` | 首页、项目页 | 单项目状态、元数据和删除 |
| `/api/projects/[project_id]/files` | `GET` | 项目聊天页 | 浏览生成工作空间文件树 |
| `/api/projects/[project_id]/artifact` | `GET` | 预览、运行治理中心 | 读取生成产物或验证报告摘要 |
| `/api/projects/[project_id]/install-dependencies` | `POST` | 项目聊天页 | 生成项目依赖安装 |
| `/api/projects/[project_id]/retry-initialization` | `POST` | 项目聊天页 | 重新初始化失败 workspace |
| `/api/projects/[project_id]/members` | `GET/PUT/DELETE` | 用户管理 | owner/管理员查看、授予和移除项目成员权限 |
| `/api/workspaces/health` | `GET` | 运行治理中心 | 工作空间健康、验证、产物和预览状态 |
| `/api/workspaces/trace` | `GET` | 运行治理中心 | 生成链路 trace、阶段事件和工具调用 |
| `/api/observability/generation` | `GET` | 运行治理中心 | 生成状态、队列、事件和可观测性聚合 |

### 聊天与 Agent Runtime

| 路由 | 方法 | 调用方 | 责任 |
| --- | --- | --- | --- |
| `/api/chat/[project_id]/messages` | `GET/POST` | 项目聊天页 | 消息读取和持久化 |
| `/api/chat/[project_id]/stream` | `GET` | 项目聊天页 | SSE 消息流 |
| `/api/chat/[project_id]/act` | `POST` | 项目聊天页 | 启动 Agent 执行、量化预取数、验证和修复链路 |
| `/api/chat/[project_id]/pause` | `POST` | 项目聊天页 | 暂停当前执行 |
| `/api/chat/[project_id]/active-session` | `GET/POST` | 项目聊天页 | CLI session 状态 |
| `/api/chat/[project_id]/cli-preference` | `GET/POST` | 项目聊天页 | 项目级 CLI 和模型选择 |

核心约束：

- `act` 入口要把用户问题转换为 run plan、数据预取、生成、验证和修复事件。
- 投资建议类问题必须保持研究/辅助决策口径，不输出确定性买卖承诺。
- 如果是宽域选股问题，不应因为缺少明确标的而反复澄清，应走本地股票池筛选。

### 量化控制台

| 路由 | 方法 | 调用方 | 责任 |
| --- | --- | --- | --- |
| `/api/quant/strategies` | `GET/POST` | 策略平台 | 策略平台聚合数据、扫描、补数和因子目录 |
| `/api/quant/query/rewrite` | `POST` | 聊天页、运行规划器 | schema v4 LLM-first 问题改写；所有 purpose 均由所选 LLM 解析语义，并在取数前执行安全决策 |
| `/api/quant/capabilities` | `GET` | 业务知识中心 | 业务能力和执行依赖摘要 |
| `/api/quant/capability-center` | `GET` | 业务知识中心 | 业务能力、场景知识、交付契约和支撑资源 |
| `/api/research/reports` | `GET/POST` | 投研情报中心 | 观察池、证据型日报、主题洞察、运行历史和推送记录；`POST` 支持 `run-daily-report` 和 `send-latest-report` |
| `/api/evals` | `GET/POST` | 评测平台 | 用例、评测集、运行队列、模拟链路和定时任务 |
| `/api/evals/runs/[runId]` | `GET` | 评测平台 | 单次评测报告详情 |
| `/api/ops/platform` | `GET` | 运行治理中心 | 基础环境、日志、健康和降级状态 |
| `/api/infrastructure/health` | `GET` | 设置/运维 | PostgreSQL、market-data、Redis、Loki 等组件健康 |
| `/api/infrastructure/service-catalog` | `GET` | 设置/运维 | 服务目录、Python/Node runtime、endpoint、依赖边和配置校验结果 |

`POST /api/quant/query/rewrite` 接收 `query`、可选 `requestedCapabilityId`、`model` 和
`purpose=preview|execution`，未传时默认 `execution`；两种 purpose 都会调用用户选定的 LLM，
因此 `preview` 不再是无模型的关键词预判。聊天输入框不会在用户输入期间频繁调用 preview，正式提交后才执行改写。
LLM 通过 Tool Schema 解析标的原文、时间范围、分析重点和输出意图；时间、宽域范围和 answer-only 意图必须携带原文字面证据。模型只允许返回用户原文中的候选标的文本，
标准代码仍由 `/api/v1/symbols/resolve` 确认。LLM 超时、未配置、网络失败或 Schema/证据不合法时返回
`llm_unavailable` 与 `QUERY_REWRITE_LLM_UNAVAILABLE`，规划和预取随即停止，不会改用关键词或正则结果继续执行。确定性涨停、必赚或保证收益请求返回
`status=refused` 与 `safety.code=GUARANTEED_RETURN_REQUEST`，不会进入取数或 Agent 执行。

### Skills、设置和集成

| 路由 | 方法 | 调用方 | 责任 |
| --- | --- | --- | --- |
| `/api/skills` | `GET/POST` | Skills 管理 | skill 列表、文件读取、保存、发布和回滚 |
| `/api/skills/[skillId]/package` | `GET` | Skills 管理 | 下载 skill 包 |
| `/api/settings` | `GET/POST` | 设置弹窗 | 平台设置聚合入口 |
| `/api/settings/global` | `GET/POST` | 设置弹窗 | 全局设置 |
| `/api/settings/cli-status` | `GET` | 设置/聊天页 | CLI 可用性和模型注册 |
| `/api/env/[project_id]/*` | `GET/POST/DELETE` | 项目设置 | 项目环境变量读取、upsert、冲突检查 |
| `/api/tokens`、`/api/tokens/[...segments]` | `GET/POST/DELETE` | 设置弹窗 | 服务 token 管理 |
| `/api/github/*`、`/api/vercel/*`、`/api/supabase/*` | `GET/POST` | 集成弹窗 | 外部平台连接和项目创建 |

### 用户记忆

| 路由 | 方法 | 调用方 | 责任 |
| --- | --- | --- | --- |
| `/api/projects/[project_id]/memory/preferences` | `GET/POST` | 偏好管理客户端 | 列出或显式新增当前用户的 QuantPilot 偏好 |
| `/api/projects/[project_id]/memory/preferences/[record_id]/corrections` | `POST` | 偏好管理客户端 | 追加不可变纠正 revision |
| `/api/projects/[project_id]/memory/preferences/[record_id]/revisions` | `GET` | 偏好管理客户端 | 查看 revision 历史 |
| `/api/projects/[project_id]/memory/uses/[request_id]` | `GET` | 审计/反馈入口 | 查询本轮实际暴露的 revision 与内容哈希 |
| `/api/projects/[project_id]/memory/outcomes` | `POST` | 显式用户反馈 | 对本轮真实使用过的 revision 记录可归因结果 |

聊天 `/api/chat/[project_id]/act` 会在 Agent 执行前自动调用 Memory 的 `/v1/recall` 和 `/v1/recall-contexts`。浏览器不直接提交 tenant/subject；QuantPilot 在项目授权后使用可信 `actorUserId` 构造 Scope，并再次执行产品、项目、键和长度过滤。完整配置、请求示例、效果状态与安全边界见[用户记忆服务接入、使用与效果验证](user-memory-integration.md)。

### 认证、权限、配额与用户治理

| 路由 | 方法 | 调用方 | 责任 |
| --- | --- | --- | --- |
| `/api/auth/*` | Better Auth methods | 登录页、用户菜单 | 登录、退出和数据库会话合同 |
| `/api/account/password` | `POST` | 账户安全 | 校验当前密码、修改密码、解除首次改密限制并撤销其他会话 |
| `/api/account/sessions` | `GET/DELETE` | 账户安全 | 查看不含 token 的设备摘要，撤销单个或其他全部会话 |
| `/api/account/usage` | `GET` | 账户用量 | 当前用户的有效 capability、权限来源、配额窗口及 `used/reserved/remaining` |
| `/api/admin/users` | `GET/POST/PATCH` | 用户管理 | 查询/创建用户、角色与状态治理、重置密码和撤销会话 |
| `/api/admin/access-control` | `GET` | 权限与配额管理 | capability 目录、权限模板、配额模板和规则；仅管理员可读 |
| `/api/admin/users/[user_id]/access` | `GET/PATCH` | 权限与配额管理 | 查看用户有效策略/用量；使用新鲜管理员会话更新模板和用户覆盖 |
| `/api/admin/audit` | `GET` | 用户管理 | 分页读取脱敏安全审计事件 |

认证启用后，Next.js 代理层对页面、API 和 WebSocket 执行统一的登录与早期授权检查，具体 route/service 对敏感操作再次执行权威校验。项目范围的有效权限是“账号 capability 与 `owner/editor/viewer` 项目角色的交集”；只有一层允许仍会拒绝。不存在或无权访问的项目统一返回 `404`，减少项目 ID 枚举。平台 `admin` 固定拥有全部 capability 和无限用户级配额，但已接入操作仍记录实际用量。

`PATCH /api/admin/users/[user_id]/access` 请求体支持 `permissionProfileId`、`quotaProfileId`、`permissionOverrides` 和 `quotaOverrides`。它必须同时提供 3-500 字的 `reason` 与最近一次读取的 `expectedAccessVersion`；成功后 `accessVersion` 加一并写入 `admin.access_policy_updated` 审计。版本已变化时返回 `409 ACCESS_POLICY_VERSION_CONFLICT`，未知 capability/metric 或不存在的模板返回 `400`，不能通过该接口限制管理员。传入某类 override 数组表示整体替换该类覆盖；省略则保持不变。配额 `limit/used/reserved/remaining` 是 `BIGINT`，JSON 中使用十进制字符串。

默认权限模板为 `member-default`，只读模板为 `readonly-default`。普通用户会合并有效用户覆盖与分配模板（未分配时使用默认模板）：任何有效 `deny` 优先，无 `deny` 时至少一个 `allow` 才会放行；项目 capability 还要与项目角色取交集。完整 capability 目录、模板边界和 scope 见[用户、权限与会话管理](authentication.md#capability-与项目角色)。

配额支持 `observe/warn/hard`：前两者允许执行并保留是否超额的计量状态，`hard` 在资源预留阶段检查 `used + reserved + requested`。硬配额不足时接口返回 `429 QUOTA_EXCEEDED`，响应包含 `metric`、`enforcement`、`used`、`reserved`、`requested`、`limit`、`remaining`、`resetAt`，并设置 `Retry-After`。可能产生成本或占用并发的入口使用“reservation -> settlement/release”协议；预留和用量事件都使用唯一幂等键，重复相同操作不会二次扣量，复用键提交不同 actor、metric、项目或数量返回 `409 QUOTA_IDEMPOTENCY_CONFLICT`。

默认成员配额共 8 项：`projects.owned=10 hard/lifetime`、`agent.concurrent=2 hard/lifetime`、`agent.requests.daily=100 hard/day`、`llm.total_tokens.monthly=2000000 warn/month`、`query_rewrite.llm.daily=200 hard/day`、`quant.data_units.daily=2000 warn/day`、`research.report_runs.daily=20 hard/day`、`research.report_sends.daily=10 hard/day`。Token 与数据单元只能在结果产生后结算，因此超额时告警而不丢弃已完成结果；请求前可判断的次数执行硬限制。管理员的限额和 `remaining` 为 `null`（表示无限），但 `used/reserved` 仍按真实 actor 记账；个人用量页读取 `/api/account/usage`，管理员查看指定用户则读取 `/api/admin/users/[user_id]/access`。报告生成任务计入 `research.report_runs.daily`；只有非 dry-run 的真实推送才计入 `research.report_sends.daily`。

启用认证时，聊天入口把当前用户写入 `user_requests.actor_user_id`，物理 Agent run 继承为 `agent_runs.actor_user_id`，后续用量事件关联 actor、project 和 source。相同 request ID 不能跨用户或跨项目复用。LLM 问题改写的确定性 `preview` 不消费 `query_rewrite.llm.daily`；只有 execution 实际进入模型链路时才计该指标和模型 Token。

## 市场数据服务 API

### 健康、注册表和基础组件

| 路由 | 方法 | 责任 |
| --- | --- | --- |
| `/health` | `GET` | 进程存活检查，不探测下游依赖 |
| `/ready` | `GET` | 数据库与 Redis 就绪检查；required 依赖失败返回 503 |
| `/api/v1/registry` | `GET` | 数据源注册表和字段契约 |
| `/api/v1/provider-candidates` | `GET` | 候选免费信源池 |
| `/api/v1/provider-candidates/probe` | `GET` | 探测候选信源可达性 |
| `/api/v1/foundation/status` | `GET` | 基础组件状态 |
| `/api/v1/foundation/factors` | `GET` | 因子定义 |
| `/api/v1/foundation/trading-calendar` | `GET` | 交易日历 |
| `/api/v1/foundation/trading-calendar/refresh` | `POST` | 管理员从 Baostock 刷新 CN-A 开市与休市日，默认近 5 年至今天 |
| `/api/v1/foundation/data-quality/scan` | `POST` | 数据质量扫描 |

`POST /api/v1/foundation/trading-calendar/refresh` 的请求体可选传入 ISO 日期
`start`、`end`；两者均省略时刷新上海时区今天往前 5 年的日历，`end` 不允许晚于今天。
服务复用 Baostock 共享会话调用 `query_trade_dates`，将每个自然日按
`CN-A / regular / baostock` 幂等写入 `quant.trading_calendars`。响应会分别返回
`requested_days`、`received_days`、`inserted_days`、`updated_days`、
`unchanged_days`、`written_days`、`open_days`、`closed_days` 以及实际首尾日期。该接口属于写接口，
遵循市场数据管理员令牌校验。

### 股票池、ETF/指数池和本地研究数据

| 路由 | 方法 | 责任 |
| --- | --- | --- |
| `/api/v1/research/universes` | `GET` | 股票池、ETF/指数池列表 |
| `/api/v1/research/universes/summary` | `GET` | 股票池摘要，适合页面首屏 |
| `/api/v1/research/universes/a-share/import` | `POST` | 导入 A 股股票池成员 |
| `/api/v1/research/universes/etf/import` | `POST` | 导入 ETF/指数池成员 |
| `/api/v1/research/universes/{universe_id}/members` | `GET` | 服务端分页查询成员，默认只返回 active；排查历史成员可加 `include_inactive=true` |
| `/api/v1/research/universes/{universe_id}/members` | `POST` | 添加单个证券到池 |
| `/api/v1/research/universes/{universe_id}/hygiene` | `POST` | 可逆清洗股票池成员；默认 `dry_run=true`，正式执行后把无最新交易日数据的成员标记为 inactive |
| `/api/v1/research/data-coverage` | `GET` | K 线覆盖摘要和分页明细，支持 `universe_id`、`page`、`page_size`、`include_inactive` |
| `/api/v1/research/bars/{symbol}` | `GET` | 本地 TimescaleDB K 线，支持日/周/月 |
| `/api/v1/research/screener/a-share-short-term` | `GET` | 本地 A 股短线候选筛选 |
| `/api/v1/research/sector-capital-flow` | `GET` | 板块资金和市场资金概览 |

股票池和覆盖明细页面应优先走服务端分页，避免一次加载 5000+ 标的。K 线详情只在点击行后按 symbol 请求。覆盖明细首屏使用 `page_size=100`，摘要来自 `quant.market_data_sync_state`，不要在线聚合全量 `stock_bars`。默认股票池、覆盖率、筛选器和 ClickHouse 同步只处理 active 成员；诊断全量历史池时显式传 `include_inactive=true`。

### 外部行情和补数

| 路由 | 方法 | 责任 |
| --- | --- | --- |
| `/api/v1/analysis/context/{symbol}` | `GET` | Skills 单标的聚合取数合同；共享依赖并隔离实时、历史、技术、财务、基本面和公告的部分失败 |
| `/api/v1/symbols/resolve` | `GET` | 代码/名称解析 |
| `/api/v1/quotes/realtime/{symbol}` | `GET` | 单标的实时行情 |
| `/api/v1/quotes/realtime` | `POST` | 批量实时行情 |
| `/api/v1/quotes/history/{symbol}` | `GET` | 外部源历史 K 线 |
| `/api/v1/ingestion/eastmoney/history` | `POST` | 东方财富历史 K 线入库 |
| `/api/v1/ingestion/akshare/history` | `POST` | AKShare 补充入库 |
| `/api/v1/ingestion/baostock/history` | `POST` | Baostock 单批历史增强字段补数 |
| `/api/v1/ingestion/baostock/history/batch` | `POST` | Baostock 分批补数 |
| `/api/v1/ingestion/baostock/history/autofill` | `POST` | 低频自动补数任务 |
| `/api/v1/ingestion/eastmoney/realtime-snapshot` | `POST` | 实时快照入库 |
| `/api/v1/ingestion/jobs` | `GET` | 补数任务和日志摘要 |
| `/api/v1/ingestion/jobs/{job_id}/control` | `POST` | 暂停、继续、停止补数任务 |

补数规则：

- 不因为近 5 年补数删除更早历史。
- 本地字段完整时应跳过外部请求。
- Baostock/AKShare 只补缺失字段，不覆盖已有非空增强字段。
- 估值因子默认不参与日常增量补数，需要单独显式启用。

`/api/v1/analysis/context/{symbol}` 的 `include` 接受逗号分隔的数据区块：
`quote,history,technical,financials,fundamental,announcements`。响应固定包含
`schema_version=1`、顶层 `ready/partial/unavailable` 状态，以及每个区块独立的
`status`、`duration_ms`、`data_quality` 和类型化 `error`。其中 technical 复用 history，
fundamental 复用 financials；单个上游故障不会丢弃其他成功区块。

### 指标、回测和事件

| 路由 | 方法 | 责任 |
| --- | --- | --- |
| `/api/v1/indicators/technical/{symbol}` | `GET` | MA5/10/20/30/60、收益、回撤、波动等 |
| `/api/v1/backtests/ma-crossover/{symbol}` | `GET` | 均线交叉回测 |
| `/api/v1/backtests/strategies/{strategy_id}/{symbol}` | `GET` | 策略模板回测 |
| `/api/v1/fundamentals/financials/{symbol}` | `GET` | 财务报表摘要 |
| `/api/v1/indicators/fundamental/{symbol}` | `GET` | 财务衍生指标 |
| `/api/v1/events/announcements/{symbol}` | `GET` | 公告事件 |
| `/api/v1/events/dividends/{symbol}` | `GET` | 分红除权事件 |

财务现金流字段使用稳定合同，不要求 Skills 读取 provider 私有 `raw`：

| 响应位置 | 字段 | 口径 |
| --- | --- | --- |
| `financials.reports[]` | `operating_cash_flow_per_share` | 每股经营活动现金流净额；东方财富源映射自 `MGJYXJJE` |
| `fundamental.points[]` | `operating_cash_flow_per_share` | 与同报告期财务记录一致的每股经营活动现金流净额 |
| `fundamental.points[]` | `operating_cash_flow_per_share_yoy` | 与上年同月同日报告期比较的同比增速，单位 `%`；上期为 0 或缺失时返回 `null` |
| `fundamental.summary` | `latest_operating_cash_flow_per_share` / `latest_operating_cash_flow_per_share_yoy` | 最新报告期的上述两个稳定字段 |

跨期比较必须按 `report_date` 和 `data_type` 对齐，不得把季度累计值与年度值混算。兼容代码可以临时读取 `raw.MGJYXJJE`，但新 Skill 和页面应优先使用正式字段。
财务响应字段升级使用版本化缓存 namespace；新合同不会把旧缓存中缺失的字段静默解析为 `null`。

## 常见排查路径

| 现象 | 先查 API | 再查数据 |
| --- | --- | --- |
| 股票池首屏慢 | `/api/v1/research/universes/{id}/members` | Redis 是否可用、是否服务端分页 |
| K 线只剩一天 | `/api/v1/research/bars/{symbol}` | `quant.stock_bars` 是否只查了最新日，前端是否误用 `limit=1` |
| 成交额/换手率为空 | `/api/v1/ingestion/baostock/history` | `quant.stock_bars.amount`、`turnover` |
| 板块资金慢 | `/api/v1/research/sector-capital-flow` | Redis TTL、后端是否全量扫描 |
| 生成页面验证失败 | `/api/chat/[project_id]/act` | `.quantpilot/validation.json`、`data_file/final/dashboard-data.json` |
| 评测队列卡住 | `/api/evals` | `eval_queue_items`、`tmp/quantpilot-eval-queue/` |

## 维护规则

- 新增页面入口时，同步补充本文件中的调用方和责任。
- 新增市场数据端点时，同步更新 `services/market-data/README.md` 和 `docs/market-data-source-knowledge.md`。
- 改变字段口径时，同步更新 [数据字典](data-dictionary.md)。
- 新增长任务时，必须说明是否写 `quant.platform_jobs` 或专用任务表，以及暂停、继续、停止语义。
