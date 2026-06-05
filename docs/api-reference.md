# API 总览

这份文档记录 QuantPilot 当前对外和内部页面使用的主要 API。它不是替代源码的逐行说明，而是帮助维护者快速判断“这个页面读的是哪个入口、后端职责在哪里、出问题先看哪一层”。

## 服务边界

| 服务 | 默认地址 | 代码位置 | 责任 |
| --- | --- | --- | --- |
| Next.js 主应用 API | `http://localhost:3000/api/*` | `src/app/api/` | 项目、聊天、设置、评测、skills、运维和页面聚合数据 |
| 市场数据服务 | `http://127.0.0.1:8000/api/v1/*` | `services/market-data/src/quantpilot_market_data/api.py` | 行情、K 线、财务、公告、补数、基础组件、股票池和回测 |
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
| `/api/projects/[project_id]/artifact` | `GET` | 预览、运维平台 | 读取生成产物或验证报告摘要 |
| `/api/projects/[project_id]/install-dependencies` | `POST` | 项目聊天页 | 生成项目依赖安装 |
| `/api/projects/[project_id]/retry-initialization` | `POST` | 项目聊天页 | 重新初始化失败 workspace |
| `/api/workspaces/health` | `GET` | 运维平台 | 工作空间健康、验证、产物和预览状态 |
| `/api/workspaces/trace` | `GET` | 运维平台 | 生成链路 trace、阶段事件和工具调用 |
| `/api/observability/generation` | `GET` | 运维平台 | 生成状态、队列、事件和可观测性聚合 |

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
| `/api/quant/capabilities` | `GET` | 数据平台 | 能力域和数据接口摘要 |
| `/api/quant/capability-center` | `GET` | 数据平台 | 能力中心、数据源、契约和验证边界 |
| `/api/evals` | `GET/POST` | 评测平台 | 用例、评测集、运行队列、模拟链路和定时任务 |
| `/api/evals/runs/[runId]` | `GET` | 评测平台 | 单次评测报告详情 |
| `/api/ops/platform` | `GET` | 运维平台 | 基础环境、日志、健康和降级状态 |
| `/api/infrastructure/health` | `GET` | 设置/运维 | PostgreSQL、market-data、Redis、Loki 等组件健康 |
| `/api/infrastructure/service-catalog` | `GET` | 设置/运维 | 服务目录、Python/Node runtime、endpoint、依赖边和配置校验结果 |

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

## 市场数据服务 API

### 健康、注册表和基础组件

| 路由 | 方法 | 责任 |
| --- | --- | --- |
| `/health` | `GET` | 服务健康检查 |
| `/api/v1/registry` | `GET` | 数据源注册表和字段契约 |
| `/api/v1/provider-candidates` | `GET` | 候选免费信源池 |
| `/api/v1/provider-candidates/probe` | `GET` | 探测候选信源可达性 |
| `/api/v1/foundation/status` | `GET` | 基础组件状态 |
| `/api/v1/foundation/factors` | `GET` | 因子定义 |
| `/api/v1/foundation/trading-calendar` | `GET` | 交易日历 |
| `/api/v1/foundation/data-quality/scan` | `POST` | 数据质量扫描 |

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
