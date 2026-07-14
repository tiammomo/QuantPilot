# 架构总览

QuantPilot 的核心链路是：用户提出量化研究问题，主工作台调度 Agent Runtime，Agent 通过核心 skills 规划任务、获取真实数据、生成工作空间，再由平台执行验证、视觉检查、产物契约检查和评测回归。

```mermaid
flowchart LR
  U[用户问题/图片] --> W[Next.js 工作台 :3000]
  W --> DB[(PostgreSQL / TimescaleDB :5432)]
  W --> R[Agent Runtime]
  R --> S[QuantPilot Skills]
  W --> M[市场数据后端 :8000]
  W --> SC[服务目录 config/service-catalog.json]
  SC --> W
  SC --> M
  M --> DB
  W --> L[(Loki / Grafana / Alloy)]
  R --> P[data/projects/project-*]
  M --> P
  P --> V[生成项目预览 :4100+]
  P --> H[运行治理中心 /ops-platform]
  W --> T[策略平台 /strategy-platform]
  W --> C[量化业务知识中心 /business-knowledge]
  W --> E[评测平台 /eval-platform]
  W --> A[Skills 管理 /skills]
```

## 怎么读这张图

这张图可以按四条线来看。

| 线索 | 你要关注什么 |
| --- | --- |
| 用户线 | 用户从首页提出问题，进入项目聊天，再打开生成项目预览 |
| 数据线 | 市场数据后端把外部源采集到 PostgreSQL/TimescaleDB，页面和 Agent 都优先读本地库 |
| 生成线 | Agent Runtime 使用 skills 规划、取数、写页面，并把事件和产物写入 workspace |
| 质量线 | 验证、视觉检查、产物契约、评测和运维共同判断结果是否可交付 |

如果你在排查问题，可以先判断自己站在哪条线上。比如 K 线没有成交额，多半是数据线；页面生成了但很丑，多半是生成线和 skills；预览打不开，多半是生成线、工作空间契约或基础环境；评测失败，多半要沿着质量线回看产物。

## 主链路

1. 用户输入问题，必要时上传截图。
2. Agent 使用 `run-planner` 判断意图是否清晰。
3. 信息不足时进入澄清，用户补充后自动承接上一轮问题。
4. 信息完整后生成 `.quantpilot/run_plan.json`。
5. 平台根据 run plan 调用 `8000` 后端获取真实数据。
6. 数据、来源和质量报告写入工作空间。
7. Agent 使用可视化 skill 生成 Next.js 看板。
8. 平台执行自动验证、产物契约检查和视觉检查。
9. 失败时生成修复计划并触发自动修复。
10. 工作空间健康、生成观测和评测平台提供运行后的治理入口。

## 运行时

| 执行器 | 模型 | 用途 | Reasoning |
| --- | --- | --- | --- |
| `claude` | `mimo-v2.5-pro` | 默认分析、默认评测 | 不展示 |
| `codex` | `gpt-5.5` | GPT 兼容链路和对照评测 | 默认 `low` |

模型和 CLI 的注册入口：

- `src/lib/constants/cliModels.ts`
- `src/lib/services/cli/claude.ts`
- `src/lib/services/cli/codex.ts`

## 服务目录

QuantPilot 当前采用 Python/Node 长期主线，不引入 Dubbo3 作为配置中心、服务发现或服务注册。对应能力由轻量服务目录承担：

- `config/service-catalog.json` 记录 web、market-data、TimescaleDB、Redis、ClickHouse、Loki、Grafana 和 Alloy 的职责、runtime、endpoint、启动命令和依赖。
- `src/lib/platform/service-catalog.ts` 负责 Node 侧解析、环境变量覆盖、endpoint 脱敏、依赖图和配置校验。
- `/api/infrastructure/service-catalog` 暴露给运行治理中心和设置页，避免页面继续散落硬编码端口。
- `npm run check:service-catalog` 作为 CI guardrail，确保服务目录、Docker、API、ops 页面和文档同步。

这相当于项目内的轻量注册表：足够支撑本地开发、单机部署、可降级组件和运维可视化。只有当后端演进成多服务多副本、跨机器部署、服务自动伸缩和统一流量治理时，才需要评估 Consul、etcd、Kubernetes service discovery 或更重的 RPC/注册中心方案。

## 模块化单体

QuantPilot 当前采用模块化单体，而不是微服务化。运行态继续保持 `Next.js + Python market-data`，代码侧按模块治理：

- `config/module-boundaries.json` 定义 shared-kernel、ui-kit、product-shell、platform-core、agent-runtime、quant-core、eval-core、ops-core 和 market-data-backend。
- `npm run check:module-boundaries` 检查反向依赖、通用 UI 污染和大文件预算。
- 领域模块不能反向依赖 `src/app/**` 页面层。
- `ui-kit` 只能承载无领域知识组件，不直接依赖量化、运维或运行时服务。
- Python 后端只通过 HTTP/API 契约和 Node 侧协作，不依赖 Next.js 源码。

详细规则见 [模块边界与模块化单体治理](module-boundaries.md)。

## 数据层

后端位于 `services/market-data`，当前默认以东方财富为主数据源，并提供候选免费信源探针。核心响应统一携带：

- `source`
- `asset_type`
- `as_of`
- `fetched_at`
- `fetch`
- `data_quality`

主要接口见 [量化数据后端 README](../services/market-data/README.md)。

后端代码按 Controller / Use Case / Repository / Core Helper 分层推进：

- `routers/` 只处理 HTTP 参数、状态码和响应模型。
- `services/` 编排 provider、缓存策略、降级和响应聚合。
- `repositories/` 承接 TimescaleDB/PostgreSQL SQL、ClickHouse 同步、分页、批量写入和读模型缓存。
- `database_core.py` 只保留连接、日期、Decimal、JSON 和证券元数据解析等无业务状态基础函数。
- `database.py` 目前是兼容门面，只导出历史 public surface；新增 SQL 不再写入这个文件。

本地基础设施默认使用 Docker 中的 PostgreSQL + TimescaleDB + Redis + Loki/Grafana/Alloy：

- PostgreSQL 承载 Prisma 管理的主业务表，包括工作空间、项目、评测、设置和运行记录。
- TimescaleDB 承载 `quant.stock_bars`、`quant.stock_factors`、`quant.strategy_signals` 和 `quant.portfolio_snapshots` 等时序表。
- Redis 承载短期缓存，优先用于板块资金、行情摘要和后续任务进度。
- Loki/Grafana/Alloy 承载集中日志采集和运维排查；Loki 未启动时运行治理中心会降级读取本地文件日志。
- 行情字段来源、补数优先级和 provider 边界见 [行情数据源采集知识库](market-data-source-knowledge.md)。
- 根目录 `sqls/` 保存组件默认需要的基础 SQL，Docker 首次创建容器时会执行；已有数据库可通过 `npm run db:init` 补齐 SQL 对象并同步 Prisma 应用表。

更多细节见 [基础设施配置](infrastructure.md)。后端能力分层、设计模式和持续优化路线见 [后端能力架构与持续优化边界](backend-capability-architecture.md)。

## 设计取舍

QuantPilot 当前最重要的取舍是“本地事实库优先”。外部接口可以不稳定，也可能字段不完整，但只要数据已经进入本地 TimescaleDB，策略、生成页面和评测都应该优先复用同一份事实。

| 取舍 | 原因 |
| --- | --- |
| PostgreSQL + TimescaleDB 作为核心底座 | 应用状态和时序数据都能在同一个 PostgreSQL 连接体系下管理 |
| 文件系统继续保存 workspace 原件 | 生成项目源码、截图和大 JSON 适合保留原始文件，数据库保存索引和摘要 |
| Redis 先做短期缓存 | 股票池摘要、板块资金和任务进度适合缓存，但长期结果仍写回数据库 |
| Loki 可选但推荐 | 本地开发可以降级到文件日志，排复杂问题时集中日志更省时间 |
| Skills 作为生成规则层 | 同类页面问题不应每次只修代码，要沉淀成下一次生成能复用的规则 |
| Python 作为市场数据后端主语言 | 当前瓶颈主要是外部数据源、IO、缓存、批处理和存储形态，不是 CPU 密集计算；优先强化 FastAPI + async/批处理 + Redis/TimescaleDB/ClickHouse，而不是过早引入 Go 或 Rust |

这个架构允许组件分阶段增强：没有 Loki 时平台还能看本地日志；没有 Redis 时可以直读数据库；没有市场数据后端时部分页面会降级展示注册表。但数据库和生成工作空间契约是核心，一旦缺失就很难保证结果可追溯。

## 后端语言边界

`services/market-data` 继续以 Python 为主线。短期不要为了“可能的性能问题”拆出 Go 或 Rust 服务，除非已经通过 profiling 证明瓶颈是 Python 运行时本身。

优先优化顺序：

1. 批量接口和批量写入，减少逐标的串行 IO。
2. Redis 做短 TTL 热点缓存，TimescaleDB 做事实库。
3. ClickHouse 承接短线筛选、append-only 的评测事件、生成事件和大规模研究分析；启用时优先查询 ClickHouse，按需补齐分析表新鲜度，失败后显式回退 TimescaleDB。
4. 后台队列拆分长任务，避免阻塞请求链路。
5. 只有在 CPU 密集计算、极高并发网关或二进制协议服务成为明确瓶颈后，再考虑 Rust/Go。

Go/Rust 的合理引入场景：

- Rust：高频指标计算、列式文件解析、极重 CPU 回测内核。
- Go：高并发轻量网关、长连接代理、独立任务 worker。

在这些场景出现前，保持 Python 单后端可以减少部署、调试、类型契约和团队认知成本。

## 工作空间产物

每个生成项目都应形成一组可检查的产物：

- `.quantpilot/run_plan.json`
- `.quantpilot/events.jsonl`
- `.quantpilot/generation-state.json`
- `.quantpilot/generation-queue.json`
- `.quantpilot/validation.json`
- `.quantpilot/validation-repair-plan.json`
- `.quantpilot/artifact-contracts.json`
- `.quantpilot/visual-validation.json`
- `data_file/final/dashboard-data.json`
- `evidence/sources.json`
- `evidence/data_quality.json`

更详细的文件契约见 [生成工作空间契约](generated-workspace-contract.md)。

## 控制台

| 控制台 | 路径 | 责任 |
| --- | --- | --- |
| 首页工作台 | `/` | 创建任务、进入项目、管理主工作流 |
| Skills 管理 | `/skills` | 编辑、发布、回滚和导入核心 skills |
| 策略平台 | `/strategy-platform` | 管理股票池、ETF/指数池、策略模板、板块资金、基础组件、金融知识、扫描队列和回测入口 |
| 量化业务知识中心 | `/business-knowledge` | 查看业务能力、典型场景、交付契约和支撑依赖 |
| 运行治理中心 | `/ops-platform` | 查看服务契约与依赖、workspace 交付、生成链路、阶段事件和集中/本地日志 |
| 评测平台 | `/eval-platform` | 管理用例、评测集、运行队列、报告和失败修复 |

项目目录和分层边界见 [项目结构与分层边界](project-structure.md)。

## 构建与开发模式

主应用通过脚本统一启动和构建：

- `scripts/dev/setup-env.js`：创建本地目录，补齐 `.env` / `.env.local`，选择主前端端口和生成项目预览端口池。
- `scripts/dev/run-web.js`：开发服务入口，负责稳定 CSS、降级恢复探测、数据库检查、Next dev lock/cache 清理和 `npx next dev` 启动。
- `scripts/build/run-build.js`：生产构建，构建前会停止根项目 `3000` 开发服务。

当前主应用使用 Next.js 默认开发与构建链路，不再接入 `next-rspack` 或额外 bundler 切换逻辑。日常开发直接运行：

```bash
npm run dev
```

启动器默认优先使用 `3000`，占用时扫描 `3000-3099`；生成工作空间预览使用 `4100-4999`；Loki 使用 `3100`，Grafana 使用 `3001`。这几个端口池分别服务不同组件，不要混用。

`npm run build` 默认跳过服务端 route 的 per-route output tracing，避免在 `.git`、`.next`、`data/projects` 等目录上做耗时追踪。需要完整 standalone 输出时使用：

```bash
npm run build:standalone
```

## 质量门

GitHub Actions 当前包含：

- 前端：`npm ci`、`npm run lint`、`npm run type-check`、`npm run check:quant-guardrails`、`npm run check:backend-architecture`、`npm run build`。
- 后端：`uv sync --locked --all-groups`、`uv run ruff check .`、`uv run pytest`。

Dependabot 每周检查：

- 根目录 npm 依赖。
- `services/market-data` uv 依赖。
- GitHub Actions。
