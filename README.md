# QuantPilot

QuantPilot 是面向量化投研、金融数据分析和可视化看板生成的 AI 工作台。用户用自然语言提出研究问题，平台会调度 Agent Runtime、读取真实数据、生成可运行工作空间，并通过自动验证、视觉检查、产物契约和评测链路把结果收敛到“好看、可用、可追溯”。

生成内容仅用于研究、复盘和辅助决策，不构成投资建议、收益承诺或即时交易指令。

如果你是第一次打开这个项目，不必急着把所有模块都看完。先把本地环境跑起来，再按下面的学习路径一层一层读。QuantPilot 的能力比较多，但核心脉络其实很清楚：真实数据进入本地库，Agent 基于 skills 生成工作空间，平台再用验证和评测把结果收紧。

## 核心能力

- AI 工作台：任务入口、项目聊天、工作空间预览、任务记录和自动修复链路。
- 量化数据底座：PostgreSQL + TimescaleDB + Redis，承载应用状态、时序行情、估值因子、缓存和补数任务状态。
- 市场数据服务：Python/FastAPI 后端，提供行情、K 线、财务、公告、指标、补数、基础组件和策略平台接口。
- 策略平台：股票池、ETF/指数池、策略目录、板块资金、基础组件、金融知识和后续回测入口。
- 投研情报中心：围绕观察池生成证据型日报，沉淀结构化报告、主题洞察、运行历史和推送回执。
- MoAgent 自研执行层：直接连接 DeepSeek，负责上下文治理、信息增益 Observation Ledger、Prompt Prefix/cache-break 诊断、阶段化类型工具循环、PostgreSQL 双层 lease、共享文件系统资源锁、durable run/operation ledger、预算、取消和显式结果提交。
- Skills 能力层：通过 registry/lock、版本与 SHA-256 完整性校验；项目初始化把参考镜像配置到 `.moagent/skills`，当前 Agent 执行仍从仓库兼容源按 source-first/package-fallback 规则只读编译有界上下文，不从 workspace 镜像发现能力。
- 业务与治理：业务知识中心、评测平台和运行治理中心共同覆盖能力知识、交付契约、生成质量、工作空间健康、运行 trace 和集中日志。

## 快速启动

第一次启动按下面顺序来：依赖、数据库、可选观测组件、市场数据后端、主前端。主前端现在使用 Next.js 默认开发链路；`npm run dev` 会调用 `scripts/dev/run-web.js`，负责端口选择、环境文件同步、稳定 CSS 生成、数据库 schema 检查和 Next dev 缓存清理。

```bash
npm install
cp .env.example .env
cp .env.example .env.local
```

在 `.env.local` 中填写 `DEEPSEEK_API_KEY`，真实密钥不要提交到 Git。当前只启用 `DeepSeek V4 Flash`，服务端固定直连 DeepSeek 官方 API，不读取自定义 Base URL 或第三方中转配置。

```bash
npm run db:up
npm run db:init
```

如需集中日志和 Grafana 排查界面，可再启动本地可观测性组件：

```bash
npm run obs:up
```

在项目根目录启动完整开发栈；命令会自动启用 Baostock / AKShare 数据扩展，
并启动或复用 market-data：

```bash
npm run dev
```

默认访问 `http://localhost:3000`。如果 `3000` 被占用，启动器会在 `3000-3099` 内选择可用端口并同步 `.env` / `.env.local` 中的 `PORT`、`WEB_PORT` 和 `NEXT_PUBLIC_APP_URL`。生成项目预览端口池从 `4100` 开始，Loki 使用 `3100`，不要把主前端长期放到这些端口上。

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

## 文档导航

项目知识集中放在 `docs/`。根 README 只放少量入口，完整索引看 [文档总览](docs/README.md)。

| 你要做什么 | 入口 |
| --- | --- |
| 不知道从哪篇开始 | [文档导读](docs/START_HERE.md) |
| 想系统学习项目 | [教学路径](docs/learning/README.md) |
| 想参与开发或判断代码放哪 | [项目结构与分层边界](docs/project-structure.md) / [模块边界](docs/module-boundaries.md) |
| 想理解或扩展 Agent 框架 | [MoAgent 架构](docs/moagent.md) |
| 想查接口、字段或数据源口径 | [API 总览](docs/api-reference.md) / [数据字典](docs/data-dictionary.md) / [行情数据源知识库](docs/market-data-source-knowledge.md) |
| 想做每日投研报告和推送 | [投研情报中心与日报自动化指南](docs/research-automation-guide.md) |
| 想排障或做发布前检查 | [运行手册](docs/operations-runbook.md) / [故障排查](docs/troubleshooting.md) |
| 想看后续优先级 | [持续完善路线图](docs/ROADMAP.md) |

## 推荐学习路径

如果是第一次接触项目，建议按这个顺序读：

| 阶段 | 文档 | 目标 |
| --- | --- | --- |
| 先找阅读路径 | [文档导读](docs/START_HERE.md) | 按启动、开发、排障、策略、评测、skills 等目标选择阅读顺序 |
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

`npm run obs:up` 会拉起 Loki、Grafana 和 Grafana Alloy。Alloy 会采集 Docker 容器日志，并读取 `tmp/runtime/*.log`、评测队列日志和 Next.js dev 日志写入 Loki。Loki 默认宿主机端口是 `3100`，生成项目预览端口池从 `4100` 开始；Grafana 默认入口是 `http://localhost:3001`，默认账号密码来自 `.env`；运行治理中心的“日志”页会优先展示 Loki 集中日志，同时保留本地文件日志兜底。

## 前端启动模式

主前端不再接入 `next-rspack` 或自定义 bundler 切换逻辑。`npm run dev` 直接启动 `next dev`，Next.js 16 在开发态使用自己的默认链路；项目侧只保留启动前后的工程保护：

- `scripts/dev/setup-env.js`：确保 `.env`、`.env.local`、`data/projects/` 存在，并写入主前端端口、应用 URL 和预览端口池。
- `scripts/dev/run-web.js`：生成稳定 Tailwind CSS，探测降级组件恢复情况，必要时同步 Prisma schema，清理过期 Next dev lock/cache，再启动 `npx next dev`。
- `scripts/build/run-build.js`：生产构建入口；默认跳过耗时的 per-route output tracing，需要桌面或 standalone 产物时使用 `npm run build:standalone`。

## 降级模式

`.env` 中的 `QUANTPILOT_DEGRADATION_MODE` 控制组件缺失时的行为：`auto` 适合本地开发，可选组件缺失时自动降级；`strict` 适合 CI/生产，必需组件缺失会失败；`offline` 会跳过可选外部组件探测，优先使用文件日志、内置数据源注册表和本地兜底数据。可通过 `QUANTPILOT_DATABASE_ENABLED`、`QUANTPILOT_MARKET_API_ENABLED`、`QUANTPILOT_OBSERVABILITY_ENABLED`、`QUANTPILOT_REDIS_CACHE_ENABLED` 等开关精确控制。
