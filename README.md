# QuantPilot

QuantPilot 是面向量化投研、金融数据分析和可视化看板生成的 AI 工作台。用户用自然语言发起分析任务，Agent 会先澄清和规划，再取数、生成工作空间、执行验证，并把关键过程沉淀成可追踪的产物与评测记录。

本项目生成的分析结果仅用于研究、复盘和辅助决策，不构成投资建议、收益承诺或即时交易指令。

## 核心能力

- **AI 工作台**：首页任务入口、项目聊天、生成过程展示、工作空间预览和任务记录。
- **模型运行时**：默认 `Claude Code + MiniMax M2.7`，可选 `Codex CLI + GPT-5.5`。
- **量化数据后端**：Python 3.14 + FastAPI + uv，默认在 `8000` 端口提供行情、K 线、财务、公告、指标和回测数据。
- **Skills 能力层**：统一管理 `.claude/skills`，支持源码编辑、文件树管理、版本发布、发布前 diff、回滚和压缩包导入。
- **工作空间健康与生成观测**：检查生成 workspace 的产物、验证、视觉检查、队列状态和事件时间线。
- **数据平台**：集中查看能力域、必需 skills、数据接口、产物契约和验证边界。
- **策略平台**：承载策略模板、扫描执行队列、参数结果对比、版本口径、回测归档、风控限制和关联策略工作空间。
- **自动验证与修复**：生成后自动检查 build、HTTP 200、数据文件、证据文件、图表、产物策略和视觉呈现，失败后进入修复链路。
- **Agent 评测后台**：提供测试用例、评测集、评测器 dry-run、运行队列、运行记录、失败修复和定时回归。

## 快速启动

### 1. 初始化前端

```bash
npm install
cp .env.example .env
cp .env.example .env.local
```

把 `.env` 或 `.env.local` 中的模型 token 改成你自己的值。真实密钥不要提交到 Git。

### 2. 启动本地数据库

先拉起 PostgreSQL + TimescaleDB，并同步 Prisma 应用表：

```bash
npm run db:up
npm run db:init
npm run db:doctor
```

TimescaleDB 用于股票 K 线、因子、策略信号和组合净值等时序数据；PostgreSQL 承载工作空间、项目、评测、配置和运行记录。

### 3. 启动量化数据后端

```bash
cd services/market-data
uv sync
uv run quantpilot-market-api
```

检查后端：

```bash
curl http://127.0.0.1:8000/health
curl "http://127.0.0.1:8000/api/v1/quotes/realtime/600519"
```

### 4. 启动主前端

回到项目根目录：

```bash
npm run dev
```

默认访问：

```text
http://localhost:3000
```

推荐启动顺序是先启动 `8000` 后端，再启动 `3000` 前端。

## 常用入口

| 入口 | 地址 | 说明 |
| --- | --- | --- |
| AI 工作台 | `http://localhost:3000` | 创建任务、进入项目聊天和预览 |
| Skills 管理 | `http://localhost:3000/skills` | 编辑、发布、回滚和导入核心 skills |
| 策略平台 | `http://localhost:3000/strategies` | 管理策略模板、扫描队列、结果对比、版本口径、回测归档和关联工作空间 |
| 数据平台 | `http://localhost:3000/capabilities` | 查看能力域、数据接口、契约和验证边界 |
| 运维平台 | `http://localhost:3000/workspaces` | 查看 workspace 健康、产物、队列和 trace |
| 生成观测 | `http://localhost:3000/observability` | 聚合生成链路事件和阶段状态 |
| 评测后台 | `http://localhost:3000/evals` | 运行评测、管理评测集、查看队列和报告 |

## 端口约定

| 服务 | 默认地址 | 说明 |
| --- | --- | --- |
| QuantPilot 主前端 | `http://localhost:3000` | 首页、项目聊天和各控制台 |
| 量化数据后端 | `http://127.0.0.1:8000` | FastAPI 金融数据服务 |
| 生成项目预览 | `http://localhost:3100` 起 | 每个工作空间自动分配独立端口 |

主前端应优先保持在 `3000`。如果脚本自动切到 `3001`，通常说明 `3000` 已被占用，建议先释放端口再重新启动。

## 常用命令

```bash
# 前端
npm run dev
npm run build
npm run build:standalone
npm run lint
npm run type-check

# 一键诊断
npm run doctor
npm run doctor:full

# CLI 与模型
npm run check-cli

# Skills
npm run check:skills
npm run check:skills:metadata
npm run package:skills

# 验证与评测
npm run check:homepage
npm run check:validation-repair
npm run check:validation-stale
npm run check:generated-artifacts
npm run check:benchmark-coverage
npm run check:eval-schedule
npm run eval:ci
npm run benchmark:quant

# 数据库
npm run db:up
npm run db:down
npm run db:logs
npm run db:init
npm run db:doctor
npm run db:psql
npm run db:sync-workspaces
npm run db:migrate-platform-state
npm run prisma:generate
npm run prisma:push
npm run prisma:migrate
npm run prisma:studio

# 后端
cd services/market-data
uv sync
uv run quantpilot-market-api
uv run ruff check .
uv run pytest
```

## 环境变量速览

默认运行时是 Claude Code，默认模型是 MiniMax M2.7。

```env
ANTHROPIC_BASE_URL="https://api.minimaxi.com/anthropic"
ANTHROPIC_AUTH_TOKEN="replace-with-your-minimax-token"
ANTHROPIC_MODEL="MiniMax-M2.7"
ANTHROPIC_SMALL_FAST_MODEL="MiniMax-M2.7"
ANTHROPIC_DEFAULT_SONNET_MODEL="MiniMax-M2.7"
ANTHROPIC_DEFAULT_OPUS_MODEL="MiniMax-M2.7"
ANTHROPIC_DEFAULT_HAIKU_MODEL="MiniMax-M2.7"
API_TIMEOUT_MS=3000000
CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1
```

Codex CLI 用于接入 OpenAI-compatible GPT：

```env
CODEX_MODEL="gpt-5.5"
CODEX_MODEL_REASONING_EFFORT="low"
CODEX_OPENAI_BASE_URL="https://w.ciykj.cn"
CODEX_OPENAI_API_KEY="replace-with-your-openai-compatible-key"
CODEX_EXECUTABLE="/path/to/codex"
CODEX_MAX_TURNS=20
CODEX_MAX_THINKING_TOKENS=4096
```

后端与本地数据：

```env
QUANTPILOT_MARKET_HOST="127.0.0.1"
QUANTPILOT_MARKET_PORT=8000
DATABASE_URL="postgresql://quantpilot:quantpilot_dev_password@127.0.0.1:5432/quantpilot?schema=public"
TIMESCALEDB_IMAGE="timescale/timescaledb:2.27.1-pg18"
POSTGRES_DB="quantpilot"
POSTGRES_USER="quantpilot"
POSTGRES_PASSWORD="quantpilot_dev_password"
POSTGRES_PORT=5432
PROJECTS_DIR="./data/projects"
ENCRYPTION_KEY="replace-with-a-64-character-hex-secret"
PORT=3000
WEB_PORT=3000
NEXT_PUBLIC_APP_URL="http://localhost:3000"
PREVIEW_PORT_START=3100
PREVIEW_PORT_END=3999
```

建议把真实 key 放在 `.env.local`、shell 环境变量、`~/.claude/settings.json` 或 `~/.codex/auth.json`，不要写入代码。

## 目录结构

| 路径 | 说明 |
| --- | --- |
| `src/app/` | Next.js App Router 页面和 API |
| `src/app/[project_id]/chat/` | 项目聊天、执行过程、预览和生成工作台 |
| `src/app/skills/` | Skills 管理界面 |
| `src/app/evals/` | Agent 评测后台 |
| `src/app/strategies/` | 策略平台 |
| `src/app/workspaces/` | 工作空间健康和生成链路观测 |
| `src/app/capabilities/` | 数据平台 |
| `services/market-data/` | Python/FastAPI 量化数据后端 |
| `.claude/skills/` | 核心 skills 源码目录 |
| `.claude/skill-packages/` | skills 发布包和历史版本包 |
| `benchmarks/quantpilot/` | 固定评测用例 |
| `src/components/quant/` | 量化控制台和业务组件 |
| `src/lib/quant/` | run plan、预取、证据、验证、评测、skills、观测和工作空间健康 |
| `scripts/dev/` | 本地开发、端口选择和环境初始化脚本 |
| `scripts/build/` | 构建入口和稳定 CSS 生成脚本 |
| `scripts/db/` | PostgreSQL / TimescaleDB 检查、迁移和 workspace 同步脚本 |
| `scripts/checks/` | 工程契约、评测契约和视觉 smoke 检查 |
| `scripts/evals/` | Agent benchmark / 评测执行入口 |
| `scripts/skills/` | skills 打包脚本 |
| `docs/` | 架构、治理、控制台和排障文档 |
| `data/projects/` | 本地生成的项目工作空间，默认不提交 |
| `tmp/` | 本地报告、临时文件和规划文档，默认不提交 |

## 文档索引

- [架构总览](docs/architecture.md)
- [基础设施配置](docs/infrastructure.md)
- [项目结构与分层边界](docs/project-structure.md)
- [本地产物与生成文件边界](docs/local-generated-files.md)
- [控制台使用指南](docs/console-guide.md)
- [生成工作空间契约](docs/generated-workspace-contract.md)
- [Agent 评测指南](docs/evals-guide.md)
- [Skills 治理规范](docs/skills-governance.md)
- [故障排查](docs/troubleshooting.md)
- [量化数据后端](services/market-data/README.md)
- [shadcn/ui 迁移记录](docs/ui-shadcn-migration.md)

## 本地数据与 Git 边界

以下内容不进入 Git：

- `.env`
- `.env.local`
- `.next/`
- `node_modules/`
- `data/`
- `tmp/`
- `public/uploads/`
- `public/generated/`
- `services/market-data/.venv/`
- `services/**/.ruff_cache/`
- `*.tsbuildinfo`

以下内容属于 Agent 能力版本管理的一部分，需要提交：

- `.claude/skills/`
- `.claude/skill-packages/`
- `.claude/skills.registry.json`
- `.claude/skills.lock.json`
- `.claude/skills.changelog.json`

## 许可证

MIT License

## 致谢

感谢 Claudable 项目在早期产品形态与工程结构上的启发和基础贡献。
