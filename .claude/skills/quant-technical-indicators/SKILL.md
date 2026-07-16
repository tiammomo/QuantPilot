---
name: quant-technical-indicators
description: Compute and validate standardized moving averages, period returns, drawdown, annualized volatility, and volume metrics from QuantPilot local bars. Use for technical analysis, K-line dashboards, trend diagnosis, risk summaries, or preparing technicalIndicators points and summary.
---

# QuantPilot 技术指标

## 执行流程

1. 解析标准代码，用 `quant-data-registry` 确认本地 bars。
2. 优先读取 `/api/v1/research/bars/{symbol}`；明确 `period`、`adjustment` 与时间范围。
3. 校验时间排序、重复时间、OHLC 合法性和正收盘价，再运行确定性脚本。
4. 输出逐期 `points` 与 `summary`，包括 MA、收益、回撤、年化波动和 20 期均量。
5. 只有在口径匹配时才用 `/api/v1/indicators/technical/{symbol}` 结果替代本地计算。
6. 写入 `technicalIndicators`；页面保留 K 线/趋势图，不只堆指标卡。

## 按需加载参考

- 当选择复权、排序、收益公式、波动年化、回撤或样本门槛时，读取 [技术指标计算合同](references/technical-indicator-contract.md)。
- 直接展示已有且 receipt 已校验的 summary 时，无需加载全部计算细节。

## 确定性脚本

```bash
python3 scripts/compute_technical_indicators.py bars.json
python3 scripts/compute_technical_indicators.py - < bars.json
```

脚本默认向 stdout 输出 JSON，支持 `--period`、`--adjustment`、`--annualization`、`--windows` 与 `-o/--output`；无有效 bars 或重复时间键时非零退出。

## Workspace 协作与质量门

- 继承平台阶段；只贡献指标、窗口、样本量、周期、复权口径和限制。
- 不输出隐藏推理、完整工具参数、占位进度或重复 Todo。
- 不编造 MA/回撤/波动，不重复乘以 100，不绕过本地 bars 拉取外部历史数据。
