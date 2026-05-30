# 基础设施配置

QuantPilot 本地开发默认使用 PostgreSQL + TimescaleDB + Redis，并提供 Loki + Grafana + Alloy 作为本地可观测性组件。PostgreSQL 承载工作空间、项目、评测、配置和运行记录；TimescaleDB 承载股票 K 线、因子、策略信号和组合净值等时序数据；Redis 承载短期缓存，后续可扩展到任务队列、分布式锁和运行进度状态；Loki 承载集中日志查询。

## 本地启动

```bash
npm run db:up
npm run db:init
npm run db:sync-workspaces
npm run db:migrate-platform-state
npm run obs:up
npm run dev
```

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
| 对象存储 | 后续用于原始行情文件、回测产物和大报告 |
| ClickHouse | 后续用于超大量 tick、盘口快照和研究分析面板 |

## 可观测性

```bash
npm run obs:up
npm run obs:logs
```

可观测性配置放在 `deploy/observability/`：

- `deploy/observability/loki/loki-config.yaml`：本地单节点 Loki，默认保留 7 天日志。
- `deploy/observability/alloy/config.alloy`：采集 Docker 容器日志、`tmp/runtime/*.log`、评测队列日志和 Next.js dev 日志。
- `deploy/observability/grafana/provisioning/datasources/loki.yaml`：自动注册 Grafana Loki 数据源。

Loki 宿主机端口默认使用标准 `3100`，生成项目预览端口池从 `4100` 开始，避免二者互相抢端口；Grafana 默认是 `http://localhost:3001`。运维平台的日志页会先查询 Loki，Loki 未启动时仍展示本地文件日志。

## 降级模式

基础组件通过 `.env` 控制降级行为：

| 配置 | 默认值 | 说明 |
| --- | --- | --- |
| `QUANTPILOT_DEGRADATION_MODE` | `auto` | `auto` 允许可选组件缺失并降级；`strict` 将必需组件缺失视为失败；`offline` 跳过可选外部探测。 |
| `QUANTPILOT_DATABASE_ENABLED` | `1` | 是否启用 PostgreSQL/TimescaleDB 检查和相关能力。 |
| `QUANTPILOT_DATABASE_REQUIRED` | `1` | 数据库是否作为硬依赖。关闭后健康检查降级为 warning/unknown，但依赖 DB 的页面能力会受限。 |
| `QUANTPILOT_MARKET_API_ENABLED` | `1` | 是否探测 `services/market-data` 后端。关闭后数据平台展示内置数据源注册表。 |
| `QUANTPILOT_MARKET_API_REQUIRED` | `0` | 市场数据后端不可用时是否失败。 |
| `QUANTPILOT_OBSERVABILITY_ENABLED` | `1` | 是否探测 Loki/Grafana/Alloy。关闭后运维平台只读本地文件日志。 |
| `QUANTPILOT_OBSERVABILITY_REQUIRED` | `0` | Loki/Grafana/Alloy 不可用时是否失败。 |
| `QUANTPILOT_REDIS_CACHE_ENABLED` | `1` | 是否启用 Redis 缓存；Redis 不可用时后端会自动直读/文件缓存兜底。 |
| `QUANTPILOT_REDIS_REQUIRED` | `0` | Redis 不可用时是否作为健康失败。 |

推荐本地开发保持 `auto`，只在 CI、演示环境或生产巡检中切到 `strict`。完全离线看页面结构、Skills、日志文件时可切到 `offline`。

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

当前 `sqls/001-quant-timeseries.sql` 会创建：

- `quant.stock_bars`
- `quant.stock_bars` 内的高价值 K 线字段包括 `amount`、`amplitude`、`change_percent`、`change_amount` 和 `turnover`，字段来源与补数策略见 `docs/market-data-source-knowledge.md`。
- `quant.stock_factors`
- `quant.strategy_signals`
- `quant.portfolio_snapshots`

这些表使用 TimescaleDB hypertable，以时间字段 `ts` 做分区。Prisma 继续管理主业务表，量化时序数据可通过 SQL、后端服务或后续专门的数据访问层写入。

## 推荐组件路线

当前不建议一次性引入过多组件。优先级如下：

| 组件 | 建议阶段 | 作用 |
| --- | --- | --- |
| Redis | 已接入基础组件 | 跨进程短期缓存，后续承载任务队列、分布式锁和进度状态 |
| Loki + Grafana + Alloy | 已接入基础组件 | 集中日志、容器日志采集、运维平台日志入口 |
| 对象存储 | 产物规模上来后 | 截图、回测报告、原始行情文件和大 JSON |
| ClickHouse | 数据规模明显放大后 | 超大量 tick、盘口快照和交互式研究分析 |

短期继续以 PostgreSQL + TimescaleDB 作为核心数据底座即可。Redis 已作为轻量缓存层接入，适合缓存板块资金、行情摘要、评测队列快照和任务进度；真正长期保存的行情、回测和评测结果仍应写回 PostgreSQL/TimescaleDB。
