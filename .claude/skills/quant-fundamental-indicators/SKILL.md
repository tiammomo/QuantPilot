---
name: quant-fundamental-indicators
description: Validate or derive A-share fundamental indicators such as net margin, ROE, gross margin, and growth summaries from normalized reports. Use for profitability quality, financial trend summaries, derived indicator checks, or preparing fundamentalIndicators points and summary.
---

# QuantPilot 财务衍生指标

## 执行流程

1. 确认标的和财务报告已标准化。
2. 优先读取 `/api/v1/indicators/fundamental/{symbol}?limit=8` 的后端标准结果。
3. 若接口缺失且真实 reports 足够，只推导有明确公式的指标；不要从缺少分母的数据猜 ROE。
4. 保留每期 `points`、样本数、期间和 percentage-point 语义，再构建 `summary`。
5. 将结果写入 `fundamentalIndicators`；样本不足、分母为零或单位冲突必须写入 warnings。

## 按需加载参考

- 当自行计算净利率、汇总 ROE/毛利率、判断百分比单位或解释亏损期时，读取 [财务指标方法与质量门](references/indicator-methodology.md)。
- 直接透传已校验的后端 `fundamentalIndicators` 时，只需核对 receipt，无需加载全部公式。

## 确定性脚本

```bash
python3 scripts/derive_indicators.py financials.json
python3 scripts/derive_indicators.py - < financials.json
```

脚本读取 JSON 文件或 stdin，向 stdout 输出 `points`、`summary` 与 `data_quality`；`-o/--output` 可选。

## Workspace 协作与质量门

- 继承平台阶段；只贡献报告期、衍生指标、样本量、来源和限制。
- 不输出隐藏推理、完整工具参数、占位进度或重复 Todo。
- 不重复乘以 100，不把算术平均称为加权平均，不用单期指标给确定性长期结论。
