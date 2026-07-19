# 01. 本地启动与健康检查

目标：把 QuantPilot 在本地完整跑起来，并确认首页、策略平台、Skills、评测、量化业务知识中心和运行治理中心都能打开。

![首页工作台](assets/home.png)

## 前置条件

- Node.js `>= 20.19.0`
- npm `>= 10`
- Docker / Docker Compose
- Python `3.14`
- uv

## 基础概念

本地运行 QuantPilot 时，其实是在启动四类东西：

| 组件 | 可以理解成 | 负责什么 |
| --- | --- | --- |
| Next.js 主前端 | 产品入口和控制台 | 首页、项目聊天、策略平台、量化业务知识中心、运行治理中心和评测平台 |
| 市场数据后端 | 量化数据 API | 行情、K 线、财务、公告、补数、交易日历和质量扫描 |
| TimescaleDB / PostgreSQL | 事实库 | 保存项目索引、应用状态、股票时序数据、因子、补数任务和策略数据 |
| Redis | 短期缓存 | 缓存行情摘要、板块资金和后续任务进度，不作为长期事实库 |
| Loki / Grafana / Alloy | 可观测性组件 | 收集日志，帮助排查前端、后端、容器和生成链路问题 |

TimescaleDB 不是另一种连接协议，它是预装 TimescaleDB 扩展的 PostgreSQL 镜像。应用仍然通过 `postgresql://...` 连接数据库，只是某些大规模时序表会使用 hypertable 获得更好的写入和查询能力。

QuantPilot 支持降级模式：没有启动市场数据后端或 Loki 时，页面不应该直接崩掉，而是展示内置注册表、本地文件日志或有限兜底数据。本地开发默认使用 `auto`，缺少可选组件只会给 warning。

## 1. 安装前端依赖

```bash
npm install
npm run ensure:env
```

`ensure:env` 会创建或维护忽略的 `.env` 与 `.env.local`。不要把完整 `.env.example` 复制到 `.env.local`；只在后者添加当前模式所需的 `MODELPORT_API_KEY`，或者官方直连的 `DEEPSEEK_API_KEY`。不启用 Memory 时再添加 `QUANTPILOT_MEMORY_ENABLED=0`。完整组合与文件优先级见[配置、模型接入与可选组件指南](../configuration.md)。真实密钥只放本地或 Secret Manager，不提交到 Git。

## 2. 启动基础设施

```bash
npm run db:up
npm run db:init
npm run db:doctor
```

`db:up` 会拉起 TimescaleDB 和 Redis。TimescaleDB 本质上是带时序扩展的 PostgreSQL 镜像，用来同时承载普通关系表和量化时序表。

如果需要在运行治理中心查看集中日志，可继续启动 Loki、Grafana 和 Alloy：

```bash
npm run obs:up
```

不启动这组组件也可以开发，平台会按降级配置读取本地文件日志。

判断这一步是否成功，不要只看命令有没有退出。建议运行：

```bash
npm run db:doctor
npm run doctor
```

`db:doctor` 关注数据库对象是否齐全；`doctor` 关注整个项目运行环境，包括前端、后端、Agent CLI、Skills、评测和降级配置。

## 3. 启动市场数据后端

```bash
cd services/market-data
uv sync --extra baostock --extra akshare
uv run quantpilot-market-api
```

健康检查：

```bash
curl http://127.0.0.1:8000/health
curl "http://127.0.0.1:8000/api/v1/quotes/realtime/600519"
```

## 4. 启动主前端

回到项目根目录：

```bash
npm run dev
```

这条命令不是直接裸跑 `next dev`，而是先经过 `scripts/dev/run-web.js`。启动器会做这些事：

| 步骤 | 作用 |
| --- | --- |
| 环境同步 | 确保 `.env`、`.env.local`、`data/` 和 `data/projects/` 存在 |
| 端口选择 | 优先使用 `3000`，占用时在 `3000-3099` 内寻找可用端口 |
| URL 写入 | 同步 `PORT`、`WEB_PORT` 和 `NEXT_PUBLIC_APP_URL` |
| 样式准备 | 生成 `public/generated/quantpilot-tailwind.css` |
| 组件恢复探测 | 数据库、market-data、Redis、Loki 恢复后，把本次进程切回 `auto` |
| 数据库检查 | 必要时运行 Prisma schema 同步 |
| Next 启动保护 | 清理过期 `.next/dev/lock` 和开发缓存，再启动 `npx next dev` |

当前前端已经移除 `next-rspack`，也不再通过 `QUANTPILOT_BUNDLER` 在 Rspack/Turbopack/webpack 之间切换。日常只需要运行 `npm run dev`；Next.js 16 会使用自己的默认开发链路。

默认访问：

```text
http://localhost:3000
```

如果 `3000` 被占用，启动器会临时选择 `3000-3099` 中的可用端口。主前端仍应优先保持在 `3000`：生成项目预览从 `4100` 往后分配端口；Loki/Grafana 容器端口 `3100`/`3000` 默认映射到宿主机 `33100`/`33012`。

后台启动时建议把日志放到 `tmp/runtime/`，这样 Alloy 和运行治理中心都能采集：

```bash
mkdir -p tmp/runtime
setsid bash -c 'exec npm run dev -- --port 3000' > tmp/runtime/web.log 2>&1 < /dev/null &
```

## 5. 页面巡检

打开这些页面确认没有错误覆盖层：

| 页面 | 地址 |
| --- | --- |
| 首页工作台 | `http://localhost:3000` |
| 策略平台 | `http://localhost:3000/strategy-platform` |
| Skills 管理 | `http://localhost:3000/skills` |
| 量化业务知识中心 | `http://localhost:3000/business-knowledge` |
| 运行治理中心 | `http://localhost:3000/ops-platform` |
| 评测平台 | `http://localhost:3000/eval-platform` |

页面巡检时重点看三件事：

1. 是否出现 Next.js 错误覆盖层。
2. 是否出现空白页、无限加载或明显横向溢出。
3. 页面上的数据是否来自本地后端或明确的降级说明，而不是看起来正常但实际是静态假数据。

## 6. 最小质量门

```bash
npm run lint
npm run type-check
npm run check:skills
npm run check:validation-repair
```

后端：

```bash
cd services/market-data
uv run ruff check .
uv run pytest
```

如果只是改文档，前端类型检查和 lint 仍然值得跑一遍，避免当前工作区已有问题被误以为是文档改动造成的。

## 常见误区

- `docker compose up` 成功不代表数据库 schema 已经齐全，仍需要 `npm run db:init`。
- `localhost:3000` 是主前端，生成工作空间预览端口从 `4100` 开始，宿主机 Loki 默认为 `33100`。
- 前端启动模式已经收敛为 Next.js 默认链路，不要再设置 `QUANTPILOT_BUNDLER` 或排查 `next-rspack`。
- Redis 缓存可以删除重建，不能把它当作唯一数据来源。
- 离线演示可以用 `QUANTPILOT_DEGRADATION_MODE=offline`，但正式检查应回到 `auto` 或 `strict`。
