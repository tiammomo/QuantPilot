# QuantPilot

QuantPilot 是建立在通用 Data Agent 与 MoAgent Framework 之上的金融量化应用。用户用自然语言提出研究问题，Finance Domain Pack 会组合证券解析、真实数据、Skills、工具、Mission 和可视化规则，生成可运行工作空间，并通过自动验证、视觉检查、产物契约和评测链路把结果收敛到“好看、可用、可追溯”。同一套框架可以继续接入零售、运营、制造等业务 Domain Pack，而不把业务规则写回 Agent 内核。

生成内容仅用于研究、复盘和辅助决策，不构成投资建议、收益承诺或即时交易指令。

如果你是第一次打开这个项目，先选择模型与 Memory 运行方式，再把本地环境跑起来。核心链路是：真实数据进入本地库，Agent 基于 skills 生成工作空间，平台再用验证和评测把结果收紧。

## 核心能力

- 通用 Data Agent：使用版本化 Task、Dataset、Connector、Domain Pack、Agent Profile 和 Execution Plan 合同组合业务能力；当前金融实现是 `finance.quant` Domain Pack。完整边界与新业务接入流程见 [Data Agent 平台与 Domain Pack 架构](docs/data-agent-architecture.md)。
- AI 工作台：任务入口、项目聊天、工作空间预览、任务记录和自动修复链路。
- 量化数据底座：PostgreSQL + TimescaleDB + Redis，承载应用状态、时序行情、估值因子、缓存和补数任务状态。
- 市场数据服务：Python/FastAPI 后端，提供行情、K 线、财务、公告、指标、补数、基础组件和策略平台接口。
- 策略平台：股票池、ETF/指数池、策略目录、板块资金、基础组件、金融知识和后续回测入口。
- 投研情报中心：围绕观察池生成证据型日报，沉淀结构化报告、主题洞察、运行历史和推送回执。
- LLM-first Query Rewrite：`preview` 与正式执行都由项目选中的模型生成 schema v4 语义合同，时间范围、宽域范围和 answer-only 意图必须有原文字面证据；证券 Resolver 独立确认代码。模型不可用时停止规划和预取，不以关键词结果冒充成功。
- MoAgent 自研执行层：默认通过 ModelPort 使用本地 Qwen，日常 DeepSeek 经 ModelPort 的 Anthropic 上游 provider，也可为项目显式选择官方 OpenAI-compatible 直连并完全绕过 ModelPort；执行层负责上下文治理、信息增益 Observation Ledger、Prompt Prefix/cache-break 诊断、阶段化类型工具循环、PostgreSQL generation job/事务 outbox、项目编排/AgentRun/Mission 分层 lease 与 fencing、共享文件系统资源锁、durable run/operation ledger、预算、取消和显式结果提交。MoAgent 不内置证券、量化工具或金融 Mission，这些由 Domain Pack 注入；每轮最终回复会展示完整业务耗时与主执行/自动修复累计 Token 用量。
- Skills 能力层：仓库 `.moagent/**` 是唯一权威源，通过 registry/lock、版本与 SHA-256 完整性校验；项目初始化把参考镜像配置到 workspace `.moagent/skills`，Agent 执行按 source-first/package-fallback 规则只读编译有界上下文，不从 workspace 镜像发现能力，也不解析旧 Skill ID。
- 业务与治理：业务知识中心、评测平台和运行治理中心共同覆盖能力知识、交付契约、生成质量、工作空间健康、运行 trace 和集中日志。
- 受治理上下文接入：通过独立 HTTP 契约组合 Memory Usage Receipt 与 AKEP ContextPack，Agent 前落无正文联合清单，Mission 验收后记录 AKEP Usage，用户明确评价后再分别回传 Memory Outcome 与 AKEP Feedback；不共享数据库或源码。

## 快速启动

第一次启动按下面顺序来。`npm install` 的 `postinstall` 会创建缺失的 `.env` 和 `.env.local`；也可以显式执行 `ensure:env`。不要把整份 `.env.example` 复制到 `.env.local`，后者只应保存本机凭据与少量覆盖。

```bash
npm install
npm run ensure:env
```

推荐模式只需在 `.env.local` 添加 ModelPort 签发的受限客户端凭据：

```dotenv
MODELPORT_API_KEY="replace-with-scoped-modelport-client-key"
```

本地 Qwen 是默认模型，日常 DeepSeek 也经 ModelPort 使用。DeepSeek 上游 Anthropic Key 只配置在 ModelPort；如果明确要绕过 ModelPort，则在 QuantPilot 注入 `DEEPSEEK_API_KEY`，并显式选择 `deepseek-v4-flash`。Memory 是独立可选组件，可用 `QUANTPILOT_MEMORY_ENABLED=0` 完全关闭。

跨平台作用域采用 Consumer + Workspace 两层隔离：ModelPort API Key 固定绑定 QuantPilot 项目账本，Memory 使用 QuantPilot 独占 tenant，AKEP 每轮只查询 shared Space 与当前 `Project.id` 派生的 project Space；统一作用域摘要写入数据库和 workspace evidence。详见 [联合上下文与项目隔离](docs/context-composition.md)。

| 运行方式 | `.env.local` 最小配置 | 额外动作 |
| --- | --- | --- |
| 推荐：Qwen + ModelPort DeepSeek | `MODELPORT_API_KEY=...` | ModelPort 配置 Qwen 与 DeepSeek provider |
| 只使用 Qwen | `MODELPORT_API_KEY=...` | 客户端 Key 只授权 `local_qwen` 即可 |
| DeepSeek 官方直连 | `DEEPSEEK_API_KEY=...` | 项目/全局设置选择 `deepseek-v4-flash` |
| 不启用 Memory | `QUANTPILOT_MEMORY_ENABLED=0` | 无需启动或配置 Memory 服务 |

完整的文件优先级、可复制组合、生产 secret 边界和验证命令见 [配置、模型接入与可选组件指南](docs/configuration.md)。

```bash
npm run db:up
npm run db:init
```

如需集中日志和 Grafana 排查界面，可再启动本地可观测性组件：

```bash
npm run obs:up
```

在项目根目录启动完整开发栈。`npm run dev` 调用 `scripts/dev/run-full.js`，先启动或复用 market-data，再由 `run-web.js` 完成端口选择、环境文件同步、稳定 CSS 生成、数据库 schema 检查、Next dev 缓存清理和 Web 启动：

```bash
npm run dev
```

默认访问 `http://localhost:3000`。如果 `3000` 被占用，启动器会在 `3000-3099` 内选择可用端口并同步 `.env` / `.env.local` 中的 `PORT`、`WEB_PORT` 和 `NEXT_PUBLIC_APP_URL`。生成项目预览端口池从 `4100` 开始；本地 Loki 默认映射到宿主机 `33100`，不要把主前端长期放到这些端口上。

不启动 Loki/Grafana 时，运行治理中心会自动降级到本地文件日志；不启动市场数据后端时，策略平台和业务知识中心只能展示有限兜底信息。

## 常用入口

| 入口 | 地址 | 说明 |
| --- | --- | --- |
| AI 工作台 | `http://localhost:3000` | 创建任务、进入项目聊天和预览 |
| 策略平台 | `http://localhost:3000/strategy-platform` | 股票池、ETF/指数池、板块资金、策略目录、基础组件和金融知识 |
| 投研情报中心 | `http://localhost:3000/research-reports` | 管理观察池、研究证据、报告库、主题洞察和自动化交付 |
| Skills 管理 | `http://localhost:3000/skills` | 编辑、发布、回滚和导入核心 skills |
| 量化业务知识中心 | `http://localhost:3000/business-knowledge` | 查看业务能力、典型场景、交付规范和执行依赖 |
| 运行治理中心 | `http://localhost:3000/ops-platform` | 统一查看服务依赖、工作空间交付、生成链路和运行日志 |
| 评测平台 | `http://localhost:3000/eval-platform` | 运行评测、管理评测集、查看队列和报告 |

## 常用命令

| 场景 | 命令 |
| --- | --- |
| 完整开发环境（前端 + market-data） | `npm run dev` |
| 仅启动主前端 | `npm run dev:web` |
| 仅启动量化后端 | `npm run dev:market` |
| 指定主前端端口 | `npm run dev -- --port 3000` |
| 单元与后端测试 | `npm test` |
| 确定性发布质量门 | `npm run release:check` |
| 含依赖审计与运行态诊断 | `npm run release:check:full` |
| 数据库启动 | `npm run db:up && npm run db:init` |
| 数据库检查 | `npm run db:doctor` |
| 初始化/维护登录管理员 | `npm run auth:bootstrap` |
| 验证完整用户生命周期 | `npm run auth:verify` |
| 清理过期认证数据与配额预留 | `npm run auth:cleanup` |
| Redis CLI | `npm run redis:cli` |
| 可观测性启动 | `npm run obs:up` |
| 可观测性日志 | `npm run obs:logs` |
| Skills 检查 | `npm run check:skills` |
| 验证修复链路检查 | `npm run check:validation-repair` |
| 首页视觉 smoke | `npm run check:homepage` |
| 全平台响应式视觉 smoke | 启动 Web 后运行 `npm run check:platform-visuals` |
| 量化后端 | `cd services/market-data && uv run quantpilot-market-api` |
| 后端质量门 | `cd services/market-data && uv run ruff check . && uv run pytest` |
| 文档本地链接检查 | `npm run check:docs` |
| 四类生成模板真实构建 | `npm run check:scaffold-templates` |
| 模型配置边界检查 | `npm run check:ai-provider-boundary` |
| 模型目录与凭据连通性检查 | `npm run check:models` |
| Qwen、ModelPort DeepSeek、Memory 基础契约联调 | `npm run check:integrations` |
| ModelPort、Memory、AKEP 30 题真实体验验收 | `npm run check:triad-experience` |
| 四组自然语言变体、共 120 题真实压力验收 | `npm run check:triad-experience:large` |
| 50 题 Qwen + Memory + AKEP 持久闭环验收 | 先在 AKEP 运行 `pnpm seed:quantpilot-acceptance-50 -- --output=<manifest>`，再运行 `npm run check:memory-knowledge-50 -- --manifest=<manifest>`；数据默认保留 |
| 创建真实任务、生成 Workspace 并验收预览 | `npm run check:task-e2e -- --campaign=<批次>`（完整通过后自动清理测试项目） |

## 文档导航

配置、架构和运行文档统一从 [docs/README.md](docs/README.md) 进入；数据库与 E2E 清理先读
[数据生命周期与安全清理](docs/data-lifecycle.md)，不要凭表名或创建时间直接删除数据。

项目知识集中放在 `docs/`。根 README 只放少量入口，完整索引看 [文档总览](docs/README.md)。

| 你要做什么 | 入口 |
| --- | --- |
| 不知道从哪篇开始 | [文档总览与角色路径](docs/README.md) |
| 想选择模型、关闭 Memory 或理解 `.env` | [配置、模型接入与可选组件指南](docs/configuration.md) |
| 想系统学习项目 | [教学路径](docs/learning/README.md) |
| 想参与开发或判断代码放哪 | [项目结构与分层边界](docs/project-structure.md) / [模块边界](docs/module-boundaries.md) |
| 想理解或扩展 Agent 框架 | [MoAgent 架构](docs/moagent.md) |
| 想查接口、字段或数据源口径 | [API 总览](docs/api-reference.md) / [数据字典](docs/data-dictionary.md) / [行情数据源知识库](docs/market-data-source-knowledge.md) |
| 想做每日投研报告和推送 | [投研情报中心与日报自动化指南](docs/research-automation-guide.md) |
| 想排障或做发布前检查 | [运行手册](docs/operations-runbook.md) / [故障排查](docs/troubleshooting.md) |
| 想启用登录或配置权限/用量配额 | [用户、权限、配额与会话管理](docs/authentication.md) |
| 想接入、使用或排查用户记忆 | [用户记忆服务接入、使用与效果验证](docs/user-memory-integration.md) |
| 想理解 Memory、Knowledge 与 QuantPilot 的联合归因 | [联合上下文与结果归因](docs/context-composition.md) |
| 想看后续优先级 | [持续完善路线图](docs/ROADMAP.md) |

## 推荐学习路径

如果是第一次接触项目，建议按这个顺序读：

| 阶段 | 文档 | 目标 |
| --- | --- | --- |
| 先找阅读路径 | [文档总览与角色路径](docs/README.md) | 按启动、开发、排障、策略、评测、skills 等目标选择阅读顺序 |
| 选择运行拓扑 | [配置、模型接入与可选组件指南](docs/configuration.md) | 选择 ModelPort、官方直连和 Memory 开关 |
| 先建立全局图 | [项目学习地图](docs/learning/00-project-study-map.md) | 知道产品、数据、生成和质量四条主线 |
| 再跑通本地环境 | [本地启动与健康检查](docs/learning/01-quick-start.md) | 拉起数据库、后端、前端和可选观测组件 |
| 理解内部组件 | [内部组件学习指南](docs/internal-components.md) | 把页面、服务、数据、Skills、验证和运维串起来 |
| 学会生成链路 | [AI 工作空间生成链路](docs/learning/02-ai-workspace-generation.md) | 理解 run plan、data、evidence、validation 和 repair plan |
| 学会数据与策略 | [市场数据与策略平台](docs/learning/03-market-data-and-strategy-platform.md) | 理解股票池、K 线、补数、因子和基础组件 |
| 学会查接口和字段 | [API 总览](docs/api-reference.md) / [数据字典](docs/data-dictionary.md) | 知道页面读哪个接口、字段来自哪里 |
| 学会 Skills | [Skills 编写与迭代教程](docs/learning/07-skills-authoring.md) | 知道如何修改、发布、打包和验证 skill |
| 看后续优先级 | [持续完善路线图](docs/ROADMAP.md) | 知道哪些事该先做，哪些事暂时不该做 |

文档维护也算项目能力的一部分。改代码时如果改变了页面入口、组件职责、数据字段、环境变量、SQL 或 skill 行为，请同步更新对应文档；具体写法见 [文档写作风格指南](docs/documentation-style-guide.md)。

## 本地数据与 Git 边界

以下内容默认不进入 Git：`.env`、`.env.local`、`.next/`、`node_modules/`、`data/`、`tmp/`、`public/uploads/`、`public/generated/`、`services/market-data/.venv/`、`services/**/.ruff_cache/`。

首次使用需要的 PostgreSQL / TimescaleDB SQL 放在 `sqls/`。生成工作空间源码和大产物放在 `data/projects/`，平台数据库只保存索引、状态和摘要。

## 本地可观测性

`npm run obs:up` 会拉起 Loki、Grafana 和 Grafana Alloy。Alloy 会采集 Docker 容器日志，并读取 `tmp/runtime/*.log`、评测队列日志和 Next.js dev 日志写入 Loki。Loki 容器端口 `3100` 默认映射到宿主机 `33100`；Grafana 容器端口 `3000` 默认映射到 `http://localhost:33012`，账号密码来自 `.env`。运行治理中心的“日志”页会优先展示 Loki 集中日志，同时保留本地文件日志兜底。

## 前端启动模式

主前端不再接入 `next-rspack` 或自定义 bundler 切换逻辑。`npm run dev` 直接启动 `next dev`，Next.js 16 在开发态使用自己的默认链路；项目侧只保留启动前后的工程保护：

- `scripts/dev/setup-env.js`：确保 `.env`、`.env.local`、`data/projects/` 存在，并写入主前端端口、应用 URL 和预览端口池。
- `scripts/dev/run-web.js`：生成稳定 Tailwind CSS，探测降级组件恢复情况，必要时同步 Prisma schema，清理过期 Next dev lock/cache，再启动 `npx next dev`。
- `scripts/build/run-build.js`：生产构建入口；默认跳过耗时的 per-route output tracing，需要桌面或 standalone 产物时使用 `npm run build:standalone`。

## 降级模式

`.env` 中的 `QUANTPILOT_DEGRADATION_MODE` 控制组件缺失时的行为：`auto` 适合本地开发，可选组件缺失时自动降级；`strict` 适合 CI/生产，必需组件缺失会失败；`offline` 会跳过多项可选外部组件探测，优先使用本地兜底。只关闭一个组件应使用其 `ENABLED=0`，例如不启用 Memory 使用 `QUANTPILOT_MEMORY_ENABLED=0`，不要为了关闭单一组件切到 `offline`。完整开关见 [配置指南](docs/configuration.md)。
