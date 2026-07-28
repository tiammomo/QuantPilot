---
name: quant-market-data
description: Fetch and validate stock, index, ETF, or A-share market bars and quotes through QuantPilot's local-first market-data backend. Use for price history, realtime snapshots, liquidity fields, data coverage, or evidence needed by analysis, backtests, and dashboards.
---

# QuantPilot 行情取数

只负责取得可追溯的行情证据，不设计页面、不用示例数据替代真实数据。本地 PostgreSQL/TimescaleDB 是历史分析的默认事实库；外部提供方只用于实时快照或已确认的本地缺口。

## 执行流程

1. 使用 `quant-symbol-resolver` 确认代码和资产类型；使用 `quant-data-registry` 确认本地覆盖。
2. 单标的多维分析优先读取 `/api/v1/analysis/context/{symbol}`，按 `include` 只请求所需区块；该接口的历史部分仍执行本地优先策略，并共享 K 线/财务依赖。
3. 纯历史研究仍可直接读取 `/api/v1/research/bars/{symbol}`；仅需实时快照时读取 `/api/v1/quotes/realtime/{symbol}`。
4. 读取 [references/market-data-contract.md](references/market-data-contract.md) 后再解释 bars 字段、选择外部补数或生成下游数据文件。
5. 将原始响应写入 `data_file/raw/<run_id>/`，将规范化证据写入 `data_file/final/dashboard-data.json`；保留来源、时间和覆盖摘要。
6. 对历史 bars 执行确定性校验：

```bash
python3 scripts/validate_market_bars.py --input data_file/raw/<run_id>/bars.json
# 或
python3 scripts/validate_market_bars.py < data_file/raw/<run_id>/bars.json
```

7. 聚合合同为 `partial` 时只使用成功区块，并披露失败区块；校验失败时停止依赖该区块的计算。需要页面时把已校验数据交给 `dashboard-visualization`。

## 本地入口

```bash
curl 'http://127.0.0.1:8000/api/v1/analysis/context/600519?include=quote,history,technical,financials,fundamental,announcements&limit=120'
curl 'http://127.0.0.1:8000/api/v1/research/universes/summary'
curl 'http://127.0.0.1:8000/api/v1/research/bars/600519.SH?timeframe=daily&adjustment=qfq&limit=1260'
curl 'http://127.0.0.1:8000/api/v1/quotes/realtime/600519'
```

只有本地缺失目标标的、区间或必要字段时才调用 ingestion；补数后必须重新读取本地 bars。不要在生成项目中安装行情库或临时抓外网。

## 按需资源

- [references/market-data-contract.md](references/market-data-contract.md)：遇到字段映射、时间顺序、来源优先级、补数决策或数据质量判断时必须读取。
- [scripts/validate_market_bars.py](scripts/validate_market_bars.py)：收到 bars 响应后执行；输出机器可读 JSON，非零退出表示不可用于下游计算。

## Workspace 回答协作

- 继承平台五阶段进度，不重启阶段、不重复问题识别表、不维护可见 Todo。
- 只贡献标的、区间、粒度、记录数、来源、时效、关键字段和真实缺口。
- 不输出隐藏推理、完整工具参数或占位式 `Skill executing...`。

## 完成门槛

- 代码、资产类型、周期与复权口径已确认。
- 数据来源、`first_ts`、`last_ts`、`row_count` 和抓取时间可追溯。
- 聚合取数响应保留 `schema_version`、顶层 `status` 以及每个 section 的 `status/duration_ms/data_quality/error`。
- 校验器返回 `ok: true`；否则不得声称取数完成。
- 不把实时快照当历史序列，不把成交量推测成成交额或换手率。
