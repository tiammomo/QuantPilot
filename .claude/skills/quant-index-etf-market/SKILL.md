---
name: quant-index-etf-market
description: Resolve, fetch, and validate index or ETF quotes and historical bars through QuantPilot. Use for broad-market indices, sector indices, index ETFs, relative market performance, trend, liquidity, or dashboard evidence while avoiding stock-only fundamentals and announcement workflows.
---

# QuantPilot 指数与 ETF 行情

处理指数和 ETF 的实时快照与历史序列。先确认资产类型，再走本地行情链路；不要把指数当个股请求财务报表或公告。

## 执行流程

1. 使用 `quant-symbol-resolver` 解析名称与代码，使用 `quant-data-registry` 确认覆盖；不得仅凭代码形态猜资产类型。
2. 历史趋势、均线、波动和回撤读取 `/api/v1/research/bars/{symbol}`；最新价格才读取 realtime 接口。
3. 读取 [references/index-etf-contract.md](references/index-etf-contract.md)，核对 `asset_type`、代码、来源、时效和资产特有字段。
4. 将统一数据对象写入原始/最终数据文件，并执行：

```bash
python3 scripts/validate_index_etf_market.py --input data_file/raw/<run_id>/index-etf.json
```

5. 失败时报告资产类型冲突、过期快照或序列缺口；成功后才交给对比、指标或看板 Skill。

## 常用解析线索

- 沪深 300：`000300`；创业板指：`399006`；中证 500：`000905`；科创 50：`000688`。
- 沪深 300 ETF：`510300`。这些只用于检索，最终资产类型以解析/响应证据为准。

## 按需资源

- [references/index-etf-contract.md](references/index-etf-contract.md)：解析代码、判断指数与 ETF、评估实时性或准备可视化字段时必须读取。
- [scripts/validate_index_etf_market.py](scripts/validate_index_etf_market.py)：对规范化指数/ETF 快照或 bars 证据执行结构与一致性校验。

## Workspace 回答协作

- 继承平台五阶段进度，不重复阶段标题、识别表或 Todo。
- 只贡献标的、资产类型、周期、样本量、来源、时效与缺口。
- 不输出隐藏推理、完整工具参数或占位式执行文案。

## 完成门槛

- `asset_type` 明确为 `index` 或 `etf`，且来源与 `as_of/fetched_at` 可追溯。
- 实时任务有有效 quote；历史任务有按时间递增的 bars 和覆盖摘要。
- 校验器返回 `ok: true`；不得用个股样例替代指数/ETF 数据。
