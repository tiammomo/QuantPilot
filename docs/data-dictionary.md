# 数据字典

这份文档记录 QuantPilot 当前最重要的数据表、字段口径和使用边界。它的目标不是替代 SQL，而是让前端、后端、skills 和评测在同一套事实上工作。

## 存储分层

| 层 | 存储 | 典型表/目录 | 说明 |
| --- | --- | --- | --- |
| 主业务状态 | PostgreSQL public schema | Prisma models | 项目、消息、设置、token、评测、策略扫描状态 |
| 量化事实库 | PostgreSQL/TimescaleDB `quant` schema | `stock_bars`、`stock_factors`、`securities` | 行情、因子、股票池、补数、回测 |
| 短期缓存 | Redis | `quantpilot:*` | 板块资金、行情摘要、接口短 TTL，不作为事实库 |
| 生成原件 | 文件系统 | `data/projects/` | 生成工作空间源码、数据文件、证据和验证报告 |
| 临时报表 | 文件系统 / Loki | `tmp/`、Loki | 评测报告、运行日志、视觉截图和队列日志 |

## Prisma 主业务表

| 表 | 来源 | 责任 |
| --- | --- | --- |
| `projects` | `Project` | 首页项目、workspace 路径、CLI 偏好和预览状态 |
| `messages` | `Message` | 用户、助手、工具调用和错误消息 |
| `sessions` | `Session` | Claude/Codex/Cursor 等 CLI session 状态 |
| `tool_usages` | `ToolUsage` | 工具输入输出、耗时和错误 |
| `user_requests` | `UserRequest` | 用户请求队列和执行状态 |
| `env_vars` | `EnvVar` | 项目环境变量，写入 workspace `.env` |
| `service_tokens` | `ServiceToken` | 本地开发用外部服务 token |
| `project_service_connections` | `ProjectServiceConnection` | GitHub/Vercel/Supabase 项目连接 |
| `commits` | `Commit` | 项目关联 commit 元数据 |
| `platform_settings` | `PlatformSetting` | 平台级设置 |
| `strategy_scan_runs` | `StrategyScanRun` | 策略扫描运行结果 |
| `strategy_scan_jobs` | `StrategyScanJob` | 策略扫描单标的任务 |
| `eval_runs` | `EvalRun` | 评测报告索引和摘要 |
| `eval_queue_items` | `EvalQueueItem` | 评测队列任务 |
| `eval_repair_tickets` | `EvalRepairTicket` | 失败修复单 |
| `eval_schedules` | `EvalSchedule` | 定时评测配置 |

Prisma 表只管理平台状态，不承载大体量 K 线和生成源码。工作空间原件仍在 `data/projects/`。

## 量化时序表

### `quant.stock_bars`

股票、ETF、指数 K 线事实表。唯一口径是：

```text
symbol + timeframe + adjustment + ts
```

| 字段 | 类型/口径 | 来源 | 使用位置 |
| --- | --- | --- | --- |
| `symbol` | 规范代码，如 `002156.SZ` | 证券主数据/解析器 | 股票池、K 线、回测 |
| `ts` | 交易时间，日线通常是交易日 | provider | K 线图、回测窗口 |
| `timeframe` | `daily`、`weekly`、`monthly` | 请求参数/聚合 | 日/周/月切换 |
| `adjustment` | `qfq`、`hfq`、`none` | 请求参数 | 复权口径隔离 |
| `open/high/low/close` | OHLC 价格 | 东方财富/Baostock/AKShare | K 线、MA、回测 |
| `previous_close` | 前收盘 | Baostock/腾讯/推导 | 涨跌幅、涨跌停 |
| `volume` | 成交量 | provider | 成交量柱、流动性 |
| `amount` | 成交额，CNY | 东方财富 f57、Baostock/AKShare | 流动性、资金代理 |
| `amplitude` | 振幅，% | 东方财富 f58、AKShare | 波动判断 |
| `change_percent` | 涨跌幅，% | 东方财富 f59、AKShare/Baostock | 涨跌、涨跌停 |
| `change_amount` | 涨跌额 | 东方财富 f60、AKShare | 行情摘要 |
| `turnover` | 换手率，% | 东方财富 f61、Baostock/AKShare | 流动性、活跃度 |
| `trade_status` | 交易状态 | Baostock | 停牌过滤 |
| `is_st` | 是否 ST | Baostock | 风险过滤、涨跌停规则 |
| `limit_up/limit_down` | 涨停/跌停标记 | 由涨跌幅和板块规则推导 | K 线标记、短线策略 |
| `provider` | 入库来源 | provider | 数据质量和溯源 |
| `metadata` | 原始字段和扩展字段 | provider | 口径追溯、兜底 |

不要用空值或 0 假装字段已采集。缺失时应在页面和 `data_quality` 中说明缺口。

### `quant.stock_factors`

因子值事实表，保存某个 symbol 某天某个因子的值。

| 字段 | 口径 |
| --- | --- |
| `symbol` | 规范证券代码 |
| `ts` | 因子生效日期或交易日 |
| `factor_key` | 因子键，如 `ma5`、`ret_20d`、`pb_mrq` |
| `factor_value` | 数值型结果 |
| `provider` | `quantpilot`、`baostock`、`eastmoney` 等 |
| `metadata` | 行业中性化、窗口、原始字段等扩展 |

因子解释不放在这里，放在 `quant.factor_definitions`。

### `quant.strategy_signals`

策略信号表，保存策略在某个标的某个时间点输出的信号。

| 字段 | 口径 |
| --- | --- |
| `strategy_id` | 策略唯一键 |
| `symbol` | 标的 |
| `ts` | 信号时间 |
| `signal` | `buy`、`sell`、`hold`、`watch` 等 |
| `strength` | 信号强度 |
| `price` | 参考价格 |
| `metadata` | 触发因子、阈值、排除原因 |

信号不等于投资建议，页面必须展示风控和限制说明。

### `quant.portfolio_snapshots`

组合净值快照。

| 字段 | 口径 |
| --- | --- |
| `portfolio_id` | 组合 ID |
| `ts` | 快照时间 |
| `total_value` | 总资产 |
| `cash` | 现金 |
| `exposure` | 风险暴露 |
| `drawdown` | 回撤 |
| `metadata` | 持仓、费用、滑点等 |

## 证券主数据与股票池

### `quant.securities`

证券主数据。

| 字段 | 口径 | 说明 |
| --- | --- | --- |
| `symbol` | `002156.SZ` | 主键 |
| `code` | `002156` | 原始代码 |
| `name` | 通富微电 | 页面主显示 |
| `exchange` | `SZ`、`SH` 等 | 交易所 |
| `asset_type` | `stock`、`etf`、`index` | 股票池拆分关键字段 |
| `currency` | `CNY` | 币种 |
| `timezone` | `Asia/Shanghai` | 时区 |
| `secid` | 东方财富 secid | 实时/历史接口 |
| `provider` | 主数据来源 | 默认 `eastmoney` |
| `listed_at` | 上市日期 | 样本覆盖判断 |
| `status` | `active` 等 | 可交易性过滤 |
| `metadata` | 行业、地区、概念、板块标签 | 股票池展示和筛选 |

所属板块优先从 `metadata` 中稳定字段读取，例如行业、概念、地区和交易所板块。

### `quant.security_universes`

股票池/ETF 池定义表。

| 字段 | 口径 |
| --- | --- |
| `id` | 池 ID，如 `a-share-stocks`、`etf-index-pool` |
| `name` | 页面显示名 |
| `description` | 用途说明 |
| `status` | `active`、`archived` |
| `source` | `eastmoney`、`manual`、`quantpilot` |
| `tags` | 分组标签 |
| `metadata` | 池规则、统计摘要 |

### `quant.security_universe_members`

池成员关系表。拆分股票池和 ETF/指数池时只改这张表的成员关系，不删除 `stock_bars` 历史。当前可交易研究池以 `role <> 'inactive'` 且 `quant.securities.status` 不是 `inactive`/`delisted` 为默认边界。

| 字段 | 口径 |
| --- | --- |
| `universe_id` | 股票池 ID |
| `symbol` | 证券代码 |
| `role` | `member`、`benchmark`、`inactive` 等；`inactive` 表示保留历史但默认业务入口不再扫描 |
| `weight` | 可选权重 |
| `metadata` | 加入原因、来源；自动清洗会写入 `metadata.hygiene`，记录原因、目标交易日、原 role/status 和新状态 |
| `added_at` | 加入时间 |

## 补数、覆盖和回测表

| 表/视图 | 责任 |
| --- | --- |
| `quant.market_data_ingestion_jobs` | 市场数据补数任务，记录 provider、范围、状态、进度、错误和统计 |
| `quant.market_data_sync_state` | 单标的同步水位，记录 first/last ts、行数、最近成功和错误；在线覆盖接口优先读取这张表 |
| `quant.market_data_coverage` | 基于 `stock_bars` 聚合的数据覆盖视图，适合离线核对，不作为页面首屏默认读模型 |
| `quant.backtest_runs` | 回测任务和指标摘要 |
| `quant.backtest_orders` | 回测成交明细 |

补数任务状态建议使用：

```text
queued -> running -> completed
queued/running -> paused
queued/running -> stopped
running -> failed
```

`paused` 和 `stopped` 都不删除已入库事实数据。

## 基础组件表

| 表 | 责任 | 页面 |
| --- | --- | --- |
| `quant.trading_calendars` | 交易日历、预期样本、补数跳过和回测窗口 | 策略平台基础组件 |
| `quant.factor_definitions` | 因子公式、依赖、解释和状态 | 策略平台因子目录 |
| `quant.data_quality_scans` | 数据质量扫描摘要和 issue | 策略平台基础组件 |
| `quant.platform_jobs` | 通用平台任务表，后续承载独立 worker | 运维/策略任务 |

## 当前高价值因子

| 因子 | 类型 | 数据依赖 | 状态 |
| --- | --- | --- | --- |
| `ma5/ma10/ma20/ma30/ma60` | 技术趋势 | `stock_bars.close` | 可计算 |
| `ret_20d/ret_60d` | 相对强弱 | `stock_bars.close` | 可计算 |
| `ma_stack_score` | 均线多头质量 | MA 族 | 可计算 |
| `amount_ratio_20d` | 成交额放大倍数 | `stock_bars.amount` | 字段完整后可计算 |
| `realized_vol_20d` | 实现波动 | 日收益率 | 可计算 |
| `max_drawdown_60d` | 60 日最大回撤 | `stock_bars.close` | 可计算 |
| `pe_ttm/pb_mrq/ps_ttm/pcf_ncf_ttm` | 估值 | `stock_factors` 或 provider | 部分可用 |
| `value_composite` | 复合估值 | 估值族 | 依赖覆盖 |
| `profitability_quality` | 盈利质量 | 财报质量字段 | 待补财报 |
| `growth_acceleration` | 成长加速度 | 财报同比字段 | 待补财报 |
| `sector_flow_heat` | 板块资金热度 | 板块资金/成交额代理 | 部分可用 |

## 数据质量口径

| 检查 | 判定 |
| --- | --- |
| K 线覆盖 | first/last ts、row_count 与交易日历期望对齐 |
| 字段完整 | `amount`、`turnover`、`change_percent`、`previous_close` 等关键字段非空率 |
| 复权隔离 | `qfq`、`hfq`、`none` 不互相覆盖 |
| 股票池边界 | `stock` 不混 ETF/指数，ETF/指数不参与默认个股策略 |
| 涨跌停/ST | `is_st`、`limit_up`、`limit_down` 不能粗暴全按 10% |
| 估值因子 | ETF/指数为空正常，普通个股缺失需记录缺口 |

## 维护规则

- 新增 SQL 表或字段后，同步更新本文件和 `sqls/README.md`。
- 新增 provider 字段后，同步更新 `docs/market-data-source-knowledge.md`。
- 页面新增指标时，必须能在本文件找到来源和口径。
- 缓存字段不能作为长期事实；会影响回测或选股的结果必须落库或写入 evidence。
