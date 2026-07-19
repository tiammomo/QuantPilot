# 运行手册

这份 runbook 面向本地开发和演示排障。它补充 [故障排查](troubleshooting.md)：故障排查负责“先看哪里”，runbook 负责“一个任务应该怎么安全执行、怎么停、怎么恢复”。

## 基础启动

日常开发推荐直接启动完整栈；该命令会复用已健康的 market-data，否则自动启动并在退出时一并回收：

```bash
npm run dev
```

需要手动分组件排障时，再按以下顺序启动：

```bash
npm run db:up
npm run db:init
npm run obs:up
cd services/market-data
uv sync --extra baostock --extra akshare
uv run quantpilot-market-api
```

另开一个终端回到项目根目录，仅启动前端：

```bash
npm run dev:web
```

检查：

```bash
npm run doctor
curl http://127.0.0.1:8000/health
curl http://127.0.0.1:8000/api/v1/foundation/status
```

如果只想看页面结构，可以用降级模式；涉及真实行情、补数、策略平台时不要长期保持 offline：

```bash
QUANTPILOT_DEGRADATION_MODE=offline npm run dev
```

## Qwen、ModelPort 与 Memory 日常检查

三方服务启动后先运行只读验收：

```bash
npm run check:integrations
```

成功表示 QuantPilot 默认 Qwen profile、ModelPort Qwen 与 DeepSeek 的模型发现/鉴权/工具流和续写、Qwen LLM Query Rewrite、Memory 契约和 readiness 均正常。DeepSeek 上游使用 ModelPort 的 Anthropic provider。该命令会产生真实模型 Token，但不写 Memory；输出不会包含凭据或记忆正文。

发布验收、契约升级或故障恢复后，再按[用户记忆接入文档](user-memory-integration.md#qwenmodelport-与-memory-的三方长期验收)执行一次显式 `--write` 合成闭环。不要把写模式放进每分钟健康检查。

推荐排障顺序：

1. ModelPort `/livez`、`/readyz` 和带鉴权的 `/v1/models`。
2. ModelPort 管理台中 `deepseek` provider 的“查询余额”；它只读调用 DeepSeek 官方余额接口，充值和账单仍由 DeepSeek 控制台处理。
3. Memory 根 discovery 和 `/readyz`；同时检查 `production_ready`，不要只看 HTTP 200。
4. `npm run check:integrations`，区分模型发现、工具协议、Query Rewrite 和 Memory 契约错误。
5. `curl http://127.0.0.1:3000/api/ready` 与 `npm run doctor`，确认 QuantPilot 自身数据库和本地归因表。

如果数据预取已成功但没有生成看板，先检查项目 `.quantpilot/run_plan.json`：`queryRewrite.outputIntent` 应为 `dashboard`、`visualization.required` 应为 `true`，再核对 `templateId/variantId` 是否有受信 renderer。`queryRewrite.execution.llm.guardedFields` 出现 `outputIntent` 表示模型尝试无证据降级，平台已恢复默认看板；项目重新初始化不应出现“承接上一轮澄清”等前缀。

三个项目必须独立升级和回滚。QuantPilot 不能导入 ModelPort/Memory 内部源码，ModelPort 与 Memory 不能共享 QuantPilot 数据库；跨仓兼容只以 `OpenAI-compatible HTTP` 和 `evolvable-memory-http/v1` 两个契约为准。

## 本地后台重启

开发机上需要重新启动前后端时，只处理主前端和 market-data，不要顺手重建数据库卷。推荐流程：

```bash
web_pgid="$(ps -eo pgid=,cmd= | awk '/npm run dev --port 3000/ {print $1; exit}')"
api_pgid="$(ps -eo pgid=,cmd= | awk '/uv run quantpilot-market-api/ {print $1; exit}')"
[ -n "$web_pgid" ] && kill -TERM -- "-$web_pgid"
[ -n "$api_pgid" ] && kill -TERM -- "-$api_pgid"
sleep 2
```

然后后台启动并写入本地运行日志：

```bash
mkdir -p tmp/runtime
setsid bash -c 'cd services/market-data && exec env QUANTPILOT_MARKET_HOST=127.0.0.1 QUANTPILOT_MARKET_PORT=8000 uv run quantpilot-market-api' > tmp/runtime/market-api.log 2>&1 < /dev/null &
setsid bash -c 'exec npm run dev -- --port 3000' > tmp/runtime/web.log 2>&1 < /dev/null &
```

确认：

```bash
curl http://127.0.0.1:8000/health
curl -I http://127.0.0.1:3000
tail -n 80 tmp/runtime/web.log
tail -n 80 tmp/runtime/market-api.log
```

前端日志里应该看到 `Starting Next.js dev server on http://localhost:3000`。当前项目不再接入 `next-rspack`；如果日志里出现 Rspack 相关提示，说明依赖或启动命令不是当前模式。

## 长任务通用规则

| 规则 | 说明 |
| --- | --- |
| 先查本地覆盖 | 本地已有完整数据时不调用外部源 |
| 分批执行 | 大股票池补数不一次性打满全部标的 |
| 可暂停可继续 | 暂停保存 offset、批次和统计 |
| 停止不删事实 | 停止只终止任务，不删除已落库 K 线 |
| 记录任务日志 | 任务状态、错误、入库行数和最近心跳必须可查 |
| 限制并发 | 外部免费接口要低并发、带 delay 和失败重试 |

## Baostock 历史字段补数

用途：补 A 股日线增强字段，例如成交额、换手率、停牌/ST、涨跌停标记、振幅和涨跌额。

### 启动单批补数

```bash
curl -X POST 'http://127.0.0.1:8000/api/v1/ingestion/baostock/history' \
  -H 'Content-Type: application/json' \
  -d '{"symbols":["002156.SZ","002555.SZ"],"period":"daily","adjustment":"qfq","lookback_years":5,"limit":1260,"request_delay_seconds":0.2}'
```

### 启动分批或一键补数

入口在策略平台补数弹窗；后端对应：

```text
POST /api/v1/ingestion/baostock/history/batch
POST /api/v1/ingestion/baostock/history/autofill
GET  /api/v1/ingestion/jobs
POST /api/v1/ingestion/jobs/{job_id}/control
```

控制语义：

| 操作 | 语义 |
| --- | --- |
| `pause` | 当前安全点停住，保存 offset 和已完成标的 |
| `resume` | 从任务元数据和 offset 继续 |
| `stop` | 终止任务，保留已入库数据和任务日志 |

### 验证补数结果

先运行新鲜度门禁。它会同时检查交易日历覆盖范围和 `daily/qfq` 最新日期，避免过期交易日历掩盖过期日线：

```bash
npm run check:market-freshness
```

该命令默认要求跟进最近一个已完成交易日（上海时间 18:00 后视为当日日线已就绪）。确需容忍上游延迟时，可直接运行脚本并显式设置允许落后的工作日数量：

```bash
node scripts/checks/check-market-data-freshness.js --max-lag-sessions 1
```

快速 `doctor` 会把过期数据报告为 warning；上面的独立门禁会返回非零退出码，适合部署或定时任务。

```bash
npm run db:psql
```

```sql
SELECT symbol, count(*) AS rows, min(ts), max(ts)
FROM quant.stock_bars
WHERE timeframe = 'daily' AND adjustment = 'qfq'
GROUP BY symbol
ORDER BY rows DESC
LIMIT 20;

SELECT
  count(*) AS rows,
  count(amount) AS amount_rows,
  count(turnover) AS turnover_rows,
  count(trade_status) AS trade_status_rows,
  count(is_st) AS st_rows
FROM quant.stock_bars
WHERE timeframe = 'daily' AND adjustment = 'qfq';
```

如果 `amount` 或 `turnover` 仍大量为空，先看 `GET /api/v1/ingestion/jobs` 的失败原因，再看 market-data 日志。

## 当日行情入库

用途：收盘后把最新交易日写入本地库，避免 K 线页面只显示旧日期。

推荐流程：

1. 确认今天是否交易日。
2. 优先用东方财富实时快照补最新日。
3. 再用 Baostock/AKShare 补增强字段。
4. 查询 `quant.stock_bars` 确认最新日和历史日都存在。

不要为了补当天数据而把查询范围改成只查当天；前端 K 线应按窗口读取历史数据，最新日只是追加点。

## 股票池和 ETF/指数池维护

拆分规则：

- A 股股票池只放 `asset_type=stock`。
- ETF/指数池放 `asset_type=etf` 或 `asset_type=index`。
- 拆分只修改 `quant.security_universe_members`，不删除 `quant.stock_bars`。
- 默认研究入口只扫描 active 成员。无最新交易日数据、退市或数据源不再返回的成员应标记为 `role='inactive'` 和 `securities.status='inactive'`，保留历史 K 线和成员关系。

检查：

```sql
SELECT asset_type, count(*)
FROM quant.securities
GROUP BY asset_type
ORDER BY count(*) DESC;

SELECT universe_id, count(*)
FROM quant.security_universe_members
GROUP BY universe_id
ORDER BY count(*) DESC;
```

清洗 A 股当前可交易池：

```bash
curl -X POST 'http://127.0.0.1:8000/api/v1/research/universes/a-share-sample-research-pool/hygiene?dry_run=true'
curl -X POST 'http://127.0.0.1:8000/api/v1/research/universes/a-share-sample-research-pool/hygiene?dry_run=false'
```

如果页面股票池加载慢，优先确认是否服务端分页和 Redis 缓存可用，不要把前端改回全量加载。

## 板块资金慢查询

板块资金目前适合 Redis 短 TTL 缓存，因为它需要聚合股票池、板块标签、最新行情和窗口统计。

排查顺序：

1. `curl http://127.0.0.1:8000/api/v1/research/sector-capital-flow`
2. `npm run redis:cli` 后执行 `KEYS quantpilot:*sector*`
3. 检查 market-data 日志是否全量扫描 5000+ 标的。
4. 缩小日期窗口或增加摘要缓存。

指标口径要谨慎：当前成交额和涨跌代理不能直接叫真实主力净流入；真实 DDE/大单资金需要单独数据源。

## 生成工作空间验证失败

排查顺序：

```text
.quantpilot/run_plan.json
.quantpilot/generation-state.json
.quantpilot/events.jsonl
data_file/final/dashboard-data.json
evidence/sources.json
evidence/data_quality.json
.quantpilot/validation.json
.quantpilot/artifact-contracts.json
.quantpilot/visual-validation.json
.quantpilot/validation-repair-plan.json
```

常见处理：

| 失败 | 处理 |
| --- | --- |
| build 失败 | 修当前工作空间代码，不改平台源码 |
| final data 存在但页面没消费 | 修页面数据绑定和模板选择 |
| 多股票被单股模板展示 | 更新 `dashboard-visualization` 或模板匹配规则 |
| 页面只有验证失败页 | 先看 validation，再触发自动修复 |
| 出现 mock/static 样例 | 清理页面假数据，引用真实 final data |

## Skills 更新和发布

修改 skills 后必须跑：

```bash
npm run check:skills
npm run package:skills
```

如果改动影响生成页面，再补跑：

```bash
npm run check:validation-repair
npm run check:project-visual
npm run check:platform-visuals
npm run benchmark:quant:contract -- --case <case-id>
```

失败案例应优先沉淀成规则，而不是只修某个生成工作空间。

## 提交前质量门

日常改动先运行确定性质量门。它不依赖已启动的数据库、行情服务或 Loki，会统一检查文档链接、模块边界、契约、前后端 lint/测试、类型和生产构建：

```bash
npm run release:check
```

正式发布再运行完整质量门。它额外使用 npm 官方 registry 审计全部直接/传递依赖，并执行运行态 `doctor:full`；因此数据库、行情服务和 strict 模式要求的组件必须可用：

```bash
npm run release:check:full
```

生产发布还必须使用生产环境执行配置预检、standalone 构建和真实启动 smoke：

```bash
npm run release:check:production
```

完整的备份、迁移、readiness、切流、回滚和恢复顺序见[生产发布 Runbook](release-runbook.md)。

检查全部依赖安全状态可运行 `npm run security:audit`，只看生产依赖可运行 `npm run security:audit:production`；只检查 Markdown 本地链接可运行 `npm run check:docs`。

涉及数据库：

```bash
npm run db:init
npm run db:doctor
```

涉及生成链路：

```bash
npm run check:validation-repair
npm run check:generated-artifacts
npm run check:benchmark-coverage
```

## 什么时候引入新组件

| 组件 | 触发条件 |
| --- | --- |
| 对象存储 | 截图、回测报告、原始行情文件和大 JSON 明显膨胀 |
| 独立 Worker | 补数、因子计算、回测任务需要脱离 Next.js/uvicorn 进程 |
| ClickHouse | tick、盘口快照或超大研究查询进入主线 |
| 消息队列 | 任务需要跨机器分发和可靠重试 |

短期优先把 PostgreSQL/TimescaleDB + Redis + Loki 这套用扎实。
