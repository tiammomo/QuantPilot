---
name: quant-market-data
description: Fetch and validate stock, index, ETF, or A-share market bars and quotes through QuantPilot's local-first market-data backend. Use for price history, realtime snapshots, liquidity fields, data coverage, or evidence needed by analysis, backtests, and dashboards.
---

# QuantPilot 行情取数

只负责取得可追溯的行情证据，不设计页面、不用示例数据替代真实数据。本地 PostgreSQL/TimescaleDB 是历史分析的默认事实库；外部提供方只用于实时快照或已确认的本地缺口。

## 执行流程

1. 使用 `quant-symbol-resolver` 确认代码和资产类型；使用 `quant-data-registry` 确认本地覆盖。
2. 历史任务优先读取 `/api/v1/research/bars/{symbol}`；实时任务才读取 `/api/v1/quotes/realtime/{symbol}`。
3. 读取 [references/market-data-contract.md](references/market-data-contract.md) 后再解释 bars 字段、选择外部补数或生成下游数据文件。
4. 将原始响应写入 `data_file/raw/<run_id>/`，将规范化证据写入 `data_file/final/dashboard-data.json`；保留来源、时间和覆盖摘要。
5. 对历史 bars 执行确定性校验：

```bash
python3 scripts/validate_market_bars.py --input data_file/raw/<run_id>/bars.json
# 或
python3 scripts/validate_market_bars.py < data_file/raw/<run_id>/bars.json
```

6. 校验失败时停止计算并报告真实缺口；需要页面时把已校验数据交给 `dashboard-visualization`。

## 本地入口

```bash
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
- 校验器返回 `ok: true`；否则不得声称取数完成。
- 不把实时快照当历史序列，不把成交量推测成成交额或换手率。
