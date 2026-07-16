---
name: quant-a-share-history
description: Read and validate local-first A-share historical K-line data for trend, return, drawdown, volatility, turnover, limit-move, screening, backtest, and dashboard tasks. Use when the requested evidence is a reproducible A-share time series rather than a realtime quote.
---

# QuantPilot A 股历史行情

从 QuantPilot 本地 TimescaleDB 取得可复现的 A 股 K 线。外部源只能补足已经确认的覆盖缺口，补数后仍以本地回读结果作为分析输入。

## 执行流程

1. 必要时用 `quant-symbol-resolver` 解析证券，并用 `quant-data-registry` 核验本地覆盖。
2. 默认使用 `daily + qfq`；只有用户需求明确时才改为周/月/分钟或 `none/hfq`。
3. 请求 `/api/v1/research/bars/{symbol}`，记录样本区间、记录数、复权口径、来源和字段缺失。
4. 在计算收益、回撤、波动或技术指标前，读取 [references/a-share-history-contract.md](references/a-share-history-contract.md) 并运行：

```bash
python3 scripts/validate_a_share_history.py --input data_file/raw/<run_id>/a-share-bars.json
```

5. 仅在本地 bars 缺少目标区间或必要字段时调用后端 ingestion；补数完成后重新执行步骤 3–4。
6. 把通过校验的数据交给指标、回测或看板 Skill，不在本 Skill 内编造图表数据。

## 按需资源

- [references/a-share-history-contract.md](references/a-share-history-contract.md)：选择周期/复权、核验交易日序列、处理停牌与字段缺失、决定是否补数时必须读取。
- [scripts/validate_a_share_history.py](scripts/validate_a_share_history.py)：每个历史序列在进入计算前执行；支持文件或 stdin JSON。

## Workspace 回答协作

- 继承平台五阶段进度，不重复阶段标题、识别表或 Todo。
- 只贡献标的、周期、复权、样本区间、记录数、来源和历史字段缺口。
- 不输出隐藏推理、完整工具参数或占位式执行文案。

## 完成门槛

- 证券代码带可判定的沪深交易所后缀，周期与复权口径明确。
- bars 按时间严格递增，OHLC、成交量和覆盖摘要通过脚本校验。
- 不把实时行情当历史样本，不把腾讯 OHLCV 兜底数据描述成含成交额或换手率的数据。
