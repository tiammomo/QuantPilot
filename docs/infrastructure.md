# 基础设施配置

QuantPilot 本地开发默认使用 PostgreSQL + TimescaleDB + Redis，并提供 Loki + Grafana + Alloy 作为本地可观测性组件。PostgreSQL 承载工作空间、项目、评测、配置和运行记录；TimescaleDB 承载股票 K 线、因子、策略信号和组合净值等时序数据；Redis 承载短期缓存，后续可扩展到任务队列、分布式锁和运行进度状态；Loki 承载集中日志查询。

## 本地启动

推荐按组件顺序启动。数据库和 Redis 是基础设施；Loki/Grafana/Alloy 是可选观测组件；market-data 是独立 Python API；主前端最后启动。

```bash
npm run db:up
npm run db:init
npm run obs:up
```

另开终端启动 market-data：

```bash
cd services/market-data
uv sync --extra baostock --extra akshare
uv run quantpilot-market-api
```

再回到项目根目录启动主前端：

```bash
npm run dev
```

`npm run db:sync-workspaces` 和 `npm run db:migrate-platform-state` 只在需要迁移旧本地文件状态时运行，不属于每次启动的必需步骤。

默认连接信息：

```env
DATABASE_URL="postgresql://quantpilot:quantpilot_dev_password@127.0.0.1:5432/quantpilot?schema=public"
TIMESCALEDB_IMAGE="timescale/timescaledb:2.27.1-pg18"
POSTGRES_DB="quantpilot"
POSTGRES_USER="quantpilot"
POSTGRES_PASSWORD="quantpilot_dev_password"
POSTGRES_PORT=5432
REDIS_URL="redis://127.0.0.1:6379/0"
REDIS_IMAGE="redis:8-alpine"
REDIS_PORT=6379
REDIS_NAMESPACE="quantpilot"
QUANTPILOT_REDIS_CACHE_ENABLED=1
LOKI_URL="http://127.0.0.1:3100"
GRAFANA_URL="http://127.0.0.1:3001"
QUANTPILOT_DEGRADATION_MODE="auto"
QUANTPILOT_MARKET_API_REQUIRED=0
QUANTPILOT_OBSERVABILITY_REQUIRED=0
QUANTPILOT_REDIS_REQUIRED=0
PORT=3000
WEB_PORT=3000
NEXT_PUBLIC_APP_URL="http://localhost:3000"
PREVIEW_PORT_START=4100
PREVIEW_PORT_END=4999
```

## 组件分工

| 组件 | 用途 |
| --- | --- |
| PostgreSQL | 主业务库，承载 Prisma 管理的应用表 |
| TimescaleDB | 股票时序数据、因子、信号、组合快照 |
| Redis | 短期缓存，优先加速策略平台板块资金；后续用于任务队列、分布式锁和短期状态 |
| Loki | 集中存储本地运行日志、容器日志和评测队列日志 |
| Grafana | 查询 Loki、排查运行问题和后续接指标面板 |
| Grafana Alloy | 采集 Docker 日志与本地 `tmp/`、`.next/` 日志并写入 Loki |
| market-data | FastAPI 市场数据服务，默认 `http://127.0.0.1:8000` |
| Next.js 主前端 | 产品入口和 API 聚合层，默认 `http://localhost:3000` |
| 对象存储 | 后续用于原始行情文件、回测产物和大报告 |
| ClickHouse | 后续用于超大量 tick、盘口快照和研究分析面板 |

## 服务目录和轻量发现

当前不引入 Dubbo3 这类 Java 服务治理栈。QuantPilot 会长期保持 Python/FastAPI + Node/Next.js 的主线，所以服务注册、配置中心和依赖发现先用更轻的方式落地：

| 文件或入口 | 作用 |
| --- | --- |
| `config/service-catalog.json` | 服务目录单一事实源，记录组件职责、runtime、默认 endpoint、Docker service、启动命令和依赖关系 |
| `src/lib/platform/service-catalog.ts` | Node 侧解析、脱敏、依赖边和配置校验 |
| `/api/infrastructure/service-catalog` | 运维和设置页可读取的服务目录 API |
| `npm run check:service-catalog` | 检查服务目录、Docker compose、API、ops 页面和文档是否同步 |

这套机制覆盖当前真正需要的能力：本地服务发现、端口和环境变量收敛、必需/可降级组件区分、依赖图展示和 CI guardrail。新增基础组件时先更新 `config/service-catalog.json`，再补 Docker、health probe、文档和页面入口。

Dubbo3 暂时不适合当前项目，因为它主要服务 Java 微服务体系；为了一个本地 Python/Node 产品栈引入额外注册中心、RPC 协议、网关和部署复杂度，会比收益更大。后续只有在多后端服务、多副本部署、跨机器服务发现和强治理需求都真实出现后，再评估 Consul、etcd、Kubernetes service discovery 或其他更重方案。

## 主前端启动器

`npm run dev` 通过 `scripts/dev/run-web.js` 启动主前端。它不是额外 bundler，而是本地启动保护层：

| 环节 | 说明 |
| --- | --- |
| 端口管理 | 默认使用 `3000`，繁忙时扫描 `3000-3099`，并写回 `.env` / `.env.local` |
| 预览端口池 | 默认保持 `4100-4999`，留给生成项目预览服务 |
| 环境初始化 | 创建本地数据目录，补齐数据库、Redis、降级和应用 URL 配置 |
| 稳定 CSS | 运行稳定 CSS 生成逻辑，输出 `public/generated/quantpilot-tailwind.css` |
| 组件恢复 | 本次启动中探测数据库、market-data、Redis、Loki 是否已恢复，并把降级进程切回 `auto` |
| 数据库同步 | 在非 offline 且数据库启用时做轻量 Prisma 检查，必要时 `prisma db push` |
| Next dev 保护 | 清理过期 `.next/dev/lock` 和 `.next/dev/cache/webpack`，再启动 `npx next dev` |

前端已经移除 `next-rspack`，不再支持或需要 `QUANTPILOT_BUNDLER`、`QUANTPILOT_DISABLE_RSPACK` 这类 bundler 切换配置。开发态交给 Next.js 16 默认链路，项目只维护启动前后的环境和缓存保护。

## 可观测性

```bash
npm run obs:up
npm run obs:logs
```

可观测性配置放在 `deploy/observability/`：

- `deploy/observability/loki/loki-config.yaml`：本地单节点 Loki，默认保留 7 天日志。
- `deploy/observability/alloy/config.alloy`：采集 Docker 容器日志、`tmp/runtime/*.log`、评测队列日志和 Next.js dev 日志。
- `deploy/observability/grafana/provisioning/datasources/loki.yaml`：自动注册 Grafana Loki 数据源。

Loki 宿主机端口默认使用标准 `3100`，生成项目预览端口池从 `4100` 开始，避免二者互相抢端口；Grafana 默认是 `http://localhost:3001`。运行治理中心的日志页会先查询 Loki，Loki 未启动时仍展示本地文件日志。

## 降级模式

基础组件通过 `.env` 控制降级行为：

| 配置 | 默认值 | 说明 |
| --- | --- | --- |
| `QUANTPILOT_DEGRADATION_MODE` | `auto` | `auto` 允许可选组件缺失并降级；`strict` 将必需组件缺失视为失败；`offline` 跳过可选外部探测。 |
| `QUANTPILOT_DATABASE_ENABLED` | `1` | 是否启用 PostgreSQL/TimescaleDB 检查和相关能力。 |
| `QUANTPILOT_DATABASE_REQUIRED` | `1` | 数据库是否作为硬依赖。关闭后健康检查降级为 warning/unknown，但依赖 DB 的页面能力会受限。 |
| `QUANTPILOT_MARKET_API_ENABLED` | `1` | 是否探测 `services/market-data` 后端。关闭后业务知识中心的支撑资源视图展示内置注册表。 |
| `QUANTPILOT_MARKET_API_REQUIRED` | `0` | 市场数据后端不可用时是否失败。 |
| `QUANTPILOT_OBSERVABILITY_ENABLED` | `1` | 是否探测 Loki/Grafana/Alloy。关闭后运行治理中心只读本地文件日志。 |
| `QUANTPILOT_OBSERVABILITY_REQUIRED` | `0` | Loki/Grafana/Alloy 不可用时是否失败。 |
| `QUANTPILOT_REDIS_CACHE_ENABLED` | `1` | 是否启用 Redis 缓存；Redis 不可用时后端会自动直读/文件缓存兜底。 |
| `QUANTPILOT_SCREENER_CACHE_TTL_SECONDS` | `60` | A 股选股筛选接口的短 TTL；skills/首页重复调用同一日期和模式时优先返回缓存结果。 |
| `QUANTPILOT_REDIS_REQUIRED` | `0` | Redis 不可用时是否作为健康失败。 |

推荐本地开发保持 `auto`，只在 CI、演示环境或生产巡检中切到 `strict`。完全离线看页面结构、Skills、日志文件时可切到 `offline`。

开发启动脚本会做一次轻量恢复探测：如果上一次是通过 `SKIP_DB_SYNC=1`、`offline` 或关闭组件的方式降级启动，但本次启动时 PostgreSQL/TimescaleDB、market-data、Redis 或 Loki 已经恢复可用，脚本会在当前进程内把这些组件切回启用状态，并把模式恢复为 `auto`。这不会改写 `.env`，只是避免“组件已经拉起来了，前端仍沿用旧的降级环境”。如果确实想强制保持降级，可临时设置：

```bash
QUANTPILOT_AUTO_RESTORE_DEGRADATION=0 npm run dev
```

## 回填本地工作空间索引

如果 PostgreSQL 中的首页项目列表为空，但 `data/projects/project-*` 目录仍在，可以回填项目索引：

```bash
npm run db:sync-workspaces
```

该命令只会为 PostgreSQL 中缺失的 workspace 创建项目记录，不会修改工作空间源码。

平台级状态迁移：

```bash
npm run db:migrate-platform-state
```

当前会迁移 `data/global-settings.json`、`data/strategy-scans/jobs/*.json`、`data/strategy-scans/runs/*.json`、评测报告索引、评测队列、评测修复单和评测定时配置到 PostgreSQL。workspace 源码、证据文件、验证报告原件、评测日志和图表数据仍保留在文件系统，后续按“索引进库、文件留原地”的方式继续收敛。

## 时序表

根目录 `sqls/` 记录组件默认需要的基础 SQL。Docker 首次创建数据库时会自动执行 `sqls/*.sql`，已有数据库可重复运行：

```bash
npm run db:init
```

`db:init` 会先执行 `sqls/*.sql`，再运行 `prisma db push` 同步 Prisma 管理的应用表。

当前 SQL 入口详见 [sqls/README.md](../sqls/README.md)，字段口径详见 [数据字典](data-dictionary.md)。核心包括：

- `quant.stock_bars`
- `quant.stock_bars` 内的高价值 K 线字段包括 `amount`、`amplitude`、`change_percent`、`change_amount` 和 `turnover`，字段来源与补数策略见 `docs/market-data-source-knowledge.md`。
- `quant.stock_factors`
- `quant.strategy_signals`
- `quant.portfolio_snapshots`
- `quant.security_universes`、`quant.security_universe_members` 和 A 股股票池 / ETF 指数池成员关系。
- `quant.ingestion_jobs`、`quant.ingestion_watermarks` 和补数进度。
- `quant.trading_calendars`、`quant.factor_definitions`、`quant.data_quality_scans` 和 `quant.platform_jobs`。

K 线、因子、信号和组合快照使用 TimescaleDB hypertable，以时间字段 `ts` 做分区。Prisma 继续管理主业务表，量化时序和策略研究数据通过 SQL 初始化和市场数据后端写入。

## 推荐组件路线

当前不建议一次性引入过多组件。优先级如下：

| 组件 | 建议阶段 | 作用 |
| --- | --- | --- |
| Redis | 已接入基础组件 | 跨进程短期缓存，后续承载任务队列、分布式锁和进度状态 |
| Loki + Grafana + Alloy | 已接入基础组件 | 集中日志、容器日志采集、运行治理中心日志入口 |
| 对象存储 | 产物规模上来后 | 截图、回测报告、原始行情文件和大 JSON |
| ClickHouse | 数据规模明显放大后 | 超大量 tick、盘口快照和交互式研究分析 |

短期继续以 PostgreSQL + TimescaleDB 作为核心数据底座即可。Redis 已作为轻量缓存层接入，适合缓存板块资金、行情摘要、评测队列快照和任务进度；真正长期保存的行情、回测和评测结果仍应写回 PostgreSQL/TimescaleDB。
