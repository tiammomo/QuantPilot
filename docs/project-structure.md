# 项目结构与分层边界

QuantPilot 采用一个 Next.js 主应用、一个 Python 市场数据后端和一组本地基础设施脚本。目录分层以“用户入口、业务服务、量化领域、基础设施、生成工作空间”区分。

## 顶层结构

| 路径 | 责任 |
| --- | --- |
| `src/` | 主应用 TypeScript/React 源码边界 |
| `src/app/` | Next.js App Router 页面和 API 路由 |
| `src/components/` | 可复用前端组件，按业务域拆分为 `chat`、`quant`、`settings`、`ui` 等 |
| `src/hooks/`、`src/contexts/` | 前端状态、上下文和浏览器侧 hooks |
| `src/lib/services/` | 主应用业务服务层，封装项目、消息、设置、令牌、预览和外部服务接入 |
| `src/lib/agent/` | MoAgent 自研内核：Provider、Context Manager、运行循环、durable runtime、类型化工具、Skill 编译器和协议类型 |
| `src/lib/quant/` | 量化平台领域层，封装能力中心、评测、策略、工作空间健康、生成观测和验证 |
| `src/lib/db/` | Prisma Client 和数据库访问入口 |
| `src/types/` | 主应用共享类型 |
| `prisma/` | PostgreSQL 主业务 schema |
| `sqls/` | 首次使用需要的 PostgreSQL / TimescaleDB 基础 SQL |
| `config/service-catalog.json` | Python/Node 服务目录、组件 endpoint、依赖边和启动命令 |
| `services/market-data/` | Python/FastAPI 市场数据服务 |
| `deploy/observability/` | Loki、Grafana 和 Alloy 本地可观测性配置 |
| `docker-compose.yml` | 本地 TimescaleDB、Redis、ClickHouse、Loki、Grafana 和 Alloy 容器编排 |
| `scripts/` | 本地开发、诊断、迁移、评测和构建脚本，按职责拆分子目录 |
| `docs/` | 架构、控制台、基础设施、治理和排障文档 |
| `.moagent/skills/` | 受 registry/lock、版本与 SHA-256 完整性校验的历史 skills 源资产，仅供 MoAgent 编译器兼容读取；不参与运行时发现 |
| `data/projects/` | 生成工作空间源码和产物，默认不提交 |
| `tmp/` | 本地评测报告和临时运行文件，默认不提交 |

## 前端边界

`src/app/` 只负责页面组织和 API 入口，复杂业务逻辑应下沉：

- 页面级客户端逻辑放在对应的 `*Client.tsx`。
- 跨页面业务组件放在 `src/components/quant/`、`src/components/settings/` 等目录。
- 通用 UI 原语放在 `src/components/ui/`。
- API route 只做请求解析、权限/参数校验和服务调用。

聊天界面同样按职责拆分：`ChatLog.tsx` 只管理历史与实时状态，`chat-message-runtime.ts` 只处理结构化消息/typed tool 协议，`ChatLogView.tsx`、`ToolMessage.tsx` 和 `LightMarkdown.tsx` 负责展示。纯文本中的 `[Tool: ...]`、`Using tool:` 等内容不会再被猜测为工具事件，工具状态只认 `messageType` 与 metadata 合同。

当前主要页面：

| 页面 | 路径 |
| --- | --- |
| 首页工作台 | `src/app/page.tsx` |
| 项目聊天 | `src/app/[project_id]/chat/` |
| Skills 管理 | `src/app/skills/` |
| 评测平台 | `src/app/eval-platform/` |
| 策略平台 | `src/app/strategy-platform/` |
| 投研情报中心 | `src/app/research-reports/` |
| 量化业务知识中心 | `src/app/business-knowledge/` |
| 运行治理中心 | `src/app/ops-platform/` |

## 服务层边界

`src/lib/services/` 面向主应用通用业务：

- `project.ts`：项目索引、创建、更新和 workspace 关联。
- `settings.ts`：平台级设置，当前已迁入 PostgreSQL 的 `platform_settings`。
- `tokens.ts`：服务令牌，使用 PostgreSQL 的 `service_tokens`，落库值采用版本化 AES-256-GCM 加密。
- `env.ts`：项目环境变量，使用 PostgreSQL 并同步到 workspace `.env`；secret API 默认只返回掩码。
- `preview.ts`：生成项目预览进程管理。
- `cli/moagent.ts`：把 MoAgent 事件接入项目消息、SSE、取消与量化生成编排。

这些模块不直接渲染 UI，也不直接承担量化领域规则。

## 量化领域层

`src/lib/quant/` 和 `src/lib/eval/` 面向 QuantPilot 自身能力：

- `capabilities.ts`、`capability-center.ts`：能力域、数据接口、skills 和验证边界。
- `src/lib/eval/`：评测用例、评测集、运行报告、队列、运行时选项、持久化映射和修复单；`runtime-mappers.ts` 承接纯解析/数据库映射并有单元测试。
- `strategies.ts`、`strategy-types.ts`、`strategy-catalog.ts`、`strategy-scan-repository.ts`、`strategy-readiness.ts`、`strategy-mappers.ts`：股票池、ETF/指数池、策略模板、基础组件、响应契约映射、数据质量扫描、补数任务、扫描报告和策略工作空间关联。
- `research-reports.ts`：投研情报自动化服务，管理观察池、日报运行、报告契约和推送 dry-run 记录。
- `query-rewrite.ts`、`query-rewrite-llm.ts`：schema v4 LLM-first 语义合同、原文字面证据校验和 Resolver 身份核验；模型失败时失败关闭。
- `workspace.ts`、`data-prefetch.ts`：前者只消费 Query Rewrite 生成 run plan，后者只消费 `run_plan.symbols`；两者都不从原始问题二次猜标的或周期。
- `finance-act-preparation.ts`：金融 Query Rewrite、run plan、预取、知识准备和 Mission 创建的应用服务；HTTP route 不复制这些领域事务。
- `generation-runtime.ts`、`finance-generation-executor.ts`：通用 Domain handler 注册表与金融 handler；独立 Worker 和本地 inline 使用完全相同的信封解析、Memory/Knowledge 快照与验证链。
- `workspace-health.ts`、`generation-observability.ts`：工作空间健康和生成链路观测。
- `validation.ts`、`visual-validation.ts`、`artifact-contracts.ts`：生成结果验证。
- `src/lib/utils/scaffold.ts` 负责 workspace 写入与模板选择；`scaffold-base-templates.ts` 保存基础行情看板和生成项目开发脚本，`scaffold-dashboard-templates.ts` 保存 comparison、stock-selection、holding-analysis 三类纯模板；`npm run check:scaffold-templates` 会对四类页面逐个执行真实 Next.js 构建。

策略扫描队列、扫描报告、评测运行、评测队列、评测修复单和平台配置已迁入 PostgreSQL。评测报告、日志和 workspace 产物仍保留文件系统原件，数据库负责索引、摘要和运行状态。

维护者查接口时优先看 [API 总览](api-reference.md)，查字段口径时优先看 [数据字典](data-dictionary.md)。这两份文档是页面、后端、SQL 和 skills 之间的共同契约。

## 数据层

本项目不再保留 SQLite 运行路径。默认数据层为：

| 数据类型 | 存储 |
| --- | --- |
| 主业务表 | PostgreSQL，Prisma 管理 |
| 股票 K 线、因子、策略信号、组合快照 | TimescaleDB hypertable |
| 短期缓存、行情摘要和后续任务进度 | Redis |
| 本地集中日志 | Loki，Alloy 采集 Docker 和本地日志，Grafana 提供查询入口 |
| 生成工作空间源码和大产物 | 文件系统 `data/projects/` |
| 大型临时报表和日志 | 文件系统 `tmp/`，PostgreSQL 记录索引和摘要，后续可接对象存储 |

原则是：平台索引、队列、配置、运行状态进 PostgreSQL；workspace 源码、截图、证据文件和大 JSON 先保留文件系统，必要时把索引和摘要入库。

## 后端边界

`services/market-data/` 是独立 Python 服务，只负责市场数据、指标、财务、公告、基础组件、补数和回测接口。它不直接管理前端项目状态，也不直接写主应用 Prisma 表。长期行情、因子、交易日历、数据质量扫描和补数任务写入 `quant` schema，主应用通过 API 读取。

后端长期按 Controller / Use Case / Repository / Provider Adapter 分层。当前 `api.py` 只作为应用装配入口并继续迁出剩余路由；旧 `database.py` 兼容门面已删除。新增能力优先落到下面这些边界：

| 路径 | 责任 |
| --- | --- |
| `services/market-data/src/quantpilot_market_data/routers/` | FastAPI controller，只处理 HTTP 参数、状态码和响应模型 |
| `services/market-data/src/quantpilot_market_data/services/` | use case 编排，处理缓存、降级、provider 选择和数据质量 |
| `services/market-data/src/quantpilot_market_data/repositories/` | TimescaleDB/PostgreSQL 查询、ClickHouse 同步、读模型缓存、事务、批量写入和分页 |
| `services/market-data/src/quantpilot_market_data/database_core.py` | 数据库连接、日期、Decimal、JSON 和证券元数据解析等无业务状态基础函数 |
| `services/market-data/src/quantpilot_market_data/providers/` | 东方财富、Baostock、AKShare 和候选信源 adapter |
| `services/market-data/src/quantpilot_market_data/analytics/` | ClickHouse 等分析加速 adapter |
| `services/market-data/src/quantpilot_market_data/cache.py` | 本地 JSON 和 Redis cache-aside |

完整规则见 [后端能力架构与持续优化边界](backend-capability-architecture.md)。

## 脚本边界

根项目脚本按执行目的分层：

| 路径 | 责任 |
| --- | --- |
| `scripts/dev/` | 本地开发入口、端口选择、环境文件初始化、降级恢复探测和 Next dev 启动保护 |
| `scripts/build/` | Next.js 构建和稳定 CSS 生成 |
| `scripts/db/` | PostgreSQL / TimescaleDB 检查、迁移和 workspace 索引同步 |
| `scripts/checks/` | lint 以外的工程契约、评测契约和视觉 smoke 检查 |
| `scripts/evals/` | Agent benchmark / 评测执行入口 |
| `scripts/skills/` | skills 打包和发布辅助脚本 |

`package.json` 只暴露稳定 npm 命令，其他代码应优先调用 npm scripts 或领域服务函数，避免散落硬编码脚本路径。

完整开发入口固定为 `npm run dev`：`run-full.js` 启动或复用 market-data，再调用 `run-web.js` 和 `npx next dev`；仅启动主前端使用 `npm run dev:web`。项目不再保留 `next-rspack` 或 bundler 自动切换路径。生成工作空间预览由 `src/lib/services/preview.ts` 管理，默认使用 `4100-4999` 端口池，不应和主前端 `3000-3099` 混用。

## 后续结构优化

后续优化以 [持续完善路线图](ROADMAP.md) 和 [模块边界与模块化单体治理](module-boundaries.md) 为准。这里保留和项目结构直接相关的拆分方向：

- `src/app/strategy-platform/StrategyPlatformClient.tsx` 已拆出 helpers、金融知识、股票池、K 线详情、板块资金、因子目录和基础组件视图；后续继续拆弹窗、hooks 和扫描编排。
- `src/lib/quant/strategies.ts` 已拆出 types、catalog、readiness、scan repository 和 response mappers；后续继续拆 market API client 和 dashboard service。
- 市场数据持久化已经按 analytics、bars、coverage、foundation、ingestion、sector_flow、screener、universes、upserts repository 拆分，禁止恢复 `database.py` 聚合门面。
- 将 `services/market-data/src/quantpilot_market_data/api.py` 拆为 `routers/registry.py`、`routers/quotes.py`、`routers/history.py`、`routers/ingestion.py`、`routers/analytics.py`、`routers/foundation.py` 和对应 `services/` use case。
- `src/lib/utils/scaffold.ts` 的基础/专用模板已经迁出；后续继续拆 dependency planner、repair adapter 和 workspace writer 的文件写入策略。
- 生成链路已落 PostgreSQL durable job/outbox、claim/attempt/fencing、独立 polling worker 和 replan 重试；下一步让评测、策略扫描复用同一调度合同。Redis 只承担可丢失的唤醒与进度缓存，锁和完成态权威始终留在 PostgreSQL。
- 为 workspace 健康快照增加 PostgreSQL 索引表，但保留原始 workspace 文件。
- 将 `src/app/page.tsx` 中过重的首页逻辑继续拆到 `src/components/home/` 或 `src/app/HomePageClient.tsx`。
- 将大文件日志、截图和历史评测报告逐步接对象存储，数据库继续保存索引和摘要。
