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
| `src/lib/quant/` | 量化平台领域层，封装能力中心、评测、策略、工作空间健康、生成观测和验证 |
| `src/lib/db/` | Prisma Client 和数据库访问入口 |
| `src/types/` | 主应用共享类型 |
| `prisma/` | PostgreSQL 主业务 schema |
| `sqls/` | 首次使用需要的 PostgreSQL / TimescaleDB 基础 SQL |
| `services/market-data/` | Python/FastAPI 市场数据服务 |
| `deploy/observability/` | Loki、Grafana 和 Alloy 本地可观测性配置 |
| `docker-compose.yml` | 本地 TimescaleDB、Redis、Loki、Grafana 和 Alloy 容器编排 |
| `scripts/` | 本地开发、诊断、迁移、评测和构建脚本，按职责拆分子目录 |
| `docs/` | 架构、控制台、基础设施、治理和排障文档 |
| `.claude/skills/` | QuantPilot 核心 skills 源码 |
| `data/projects/` | 生成工作空间源码和产物，默认不提交 |
| `tmp/` | 本地评测报告和临时运行文件，默认不提交 |

## 前端边界

`src/app/` 只负责页面组织和 API 入口，复杂业务逻辑应下沉：

- 页面级客户端逻辑放在对应的 `*Client.tsx`。
- 跨页面业务组件放在 `src/components/quant/`、`src/components/settings/` 等目录。
- 通用 UI 原语放在 `src/components/ui/`。
- API route 只做请求解析、权限/参数校验和服务调用。

当前主要页面：

| 页面 | 路径 |
| --- | --- |
| 首页工作台 | `src/app/page.tsx` |
| 项目聊天 | `src/app/[project_id]/chat/` |
| Skills 管理 | `src/app/skills/` |
| 评测平台 | `src/app/eval-platform/` |
| 策略平台 | `src/app/strategy-platform/` |
| 数据平台 | `src/app/data-platform/` |
| 运维平台 | `src/app/ops-platform/` |

## 服务层边界

`src/lib/services/` 面向主应用通用业务：

- `project.ts`：项目索引、创建、更新和 workspace 关联。
- `settings.ts`：平台级设置，当前已迁入 PostgreSQL 的 `platform_settings`。
- `tokens.ts`：服务令牌，当前使用 PostgreSQL 的 `service_tokens`。
- `env.ts`：项目环境变量，使用 PostgreSQL 并同步到 workspace `.env`。
- `preview.ts`：生成项目预览进程管理。
- `cli/`：Claude、Codex、Cursor、Qwen、GLM 等智能体运行时适配。

这些模块不直接渲染 UI，也不直接承担量化领域规则。

## 量化领域层

`src/lib/quant/` 面向 QuantPilot 自身能力：

- `capabilities.ts`、`capability-center.ts`：能力域、数据接口、skills 和验证边界。
- `evals.ts`：评测用例、队列、运行报告和修复单。
- `strategies.ts`：股票池、ETF/指数池、策略模板、基础组件、数据质量扫描、补数任务、扫描报告和策略工作空间关联。
- `workspace-health.ts`、`generation-observability.ts`：工作空间健康和生成链路观测。
- `validation.ts`、`visual-validation.ts`、`artifact-contracts.ts`：生成结果验证。

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

主前端开发入口固定为 `npm run dev`。它会调用 `scripts/dev/run-web.js`，再启动 `npx next dev`；项目不再保留 `next-rspack` 或 bundler 自动切换路径。生成工作空间预览由 `src/lib/services/preview.ts` 管理，默认使用 `4100-4999` 端口池，不应和主前端 `3000-3099` 混用。

## 后续结构优化

建议优先做小步收敛：

- 将 `src/app/strategy-platform/StrategyPlatformClient.tsx` 拆为股票池、ETF/指数池、因子目录、板块资金、补数任务、基础组件和金融知识等页面片段。拆分时先保留现有数据结构和交互，不改变接口语义。
- 将 `src/lib/quant/strategies.ts` 拆为 `types`、`catalog`、`api`、`mappers`、`jobs` 等模块，避免策略目录、因子目录、补数状态和页面聚合互相挤在一个文件里。
- 将 `services/market-data/src/quantpilot_market_data/database.py` 拆为 bars、universes、factors、ingestion、sector_flow、foundation 等 repository 文件，保留同一连接入口。
- 将 `src/lib/utils/scaffold.ts` 中的模板、依赖注入、验证修复和生成策略拆开，降低生成工作空间问题的回归风险。
- 为评测和策略扫描队列补 Redis 执行器，避免长期依赖 Next.js 进程内状态。
- 为 workspace 健康快照增加 PostgreSQL 索引表，但保留原始 workspace 文件。
- 将 `src/app/page.tsx` 中过重的首页逻辑继续拆到 `src/components/home/` 或 `src/app/HomePageClient.tsx`。
- 将大文件日志、截图和历史评测报告逐步接对象存储，数据库继续保存索引和摘要。
