---
name: quant-fundamental-financials
description: Fetch, normalize, and validate A-share financial summary reports including revenue, parent net profit, EPS, ROE, gross margin, and year-over-year growth. Use for multi-period financial trends, earnings comparisons, report-period validation, or preparing QuantPilot financials.reports.
---

# QuantPilot 财务摘要

## 执行流程

1. 先解析标准证券代码。
2. 获取最近多个报告期，默认 8 期：`/api/v1/fundamentals/financials/{symbol}?limit=8`。
3. 保留 `report_date`、`notice_date`、`data_type`、来源和原始单位；先校验再排序。
4. 使用脚本规范化常见字段并检测重复期间、缺失期间和无法识别的根结构。
5. 比较收入、归母净利润、EPS、ROE、毛利率及同比方向；明确累计值与单季值。
6. 写入 `financials.reports` 与 data quality；不要把摘要冒充完整三张表。

## 按需加载参考

- 当解释报告期、累计/单季、同比、重述、单位或披露时点时，读取 [财务报告口径合同](references/financial-reporting-contract.md)。
- 只做字段透传且上游已经提供完整 contract receipt 时，不必加载参考全文。

## 确定性脚本

```bash
python3 scripts/normalize_financials.py financials.json
python3 scripts/normalize_financials.py - < financials.json
```

脚本向 stdout 输出规范化 JSON；输入错误或没有可识别报告时非零退出。`-o/--output` 可选。

## Workspace 协作与质量门

- 继承平台阶段；只贡献报告期、指标、同比口径、来源和缺失字段。
- 不输出隐藏推理、完整工具参数、占位进度或重复 Todo。
- 不用单期数据下长期结论，不默认把缺失值视为零，不对未知单位做倍率猜测。
