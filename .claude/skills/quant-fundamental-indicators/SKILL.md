---
name: quant-fundamental-indicators
description: Use this skill when a quantitative task needs derived fundamental indicators such as net margin, average ROE, average gross margin, and latest financial quality metrics.
---

# QuantPilot 财务衍生指标能力

本 skill 用于从 QuantPilot 后端获取标准化财务衍生指标，适用于基本面分析、盈利质量分析、财务趋势看板和个股诊断。

## API

```bash
curl 'http://127.0.0.1:8000/api/v1/indicators/fundamental/600519?limit=8'
```

## 返回内容

接口返回：

- `points`: 每个报告期的营收、归母净利润、营收同比、净利润同比、毛利率、ROE、净利率。
- `summary`: 最新报告期、最新营收、最新归母净利润、最新同比、最新毛利率、最新 ROE、平均 ROE、平均毛利率、平均净利率。
- `as_of`、`fetched_at`、`source`、`data_quality`。

## 工作流程

1. 先确认标的已经解析为标准代码。
2. 先获取财务摘要或确认财务摘要能力可用。
3. 调用 `indicators/fundamental` 获取后端标准化衍生指标。
4. 将指标写入 `data_file/raw/<run_id>/fundamental-indicators.json` 或 `data_file/final/dashboard-data.json` 的 `fundamentalIndicators` 字段。
5. 页面生成时优先读取 `fundamentalIndicators.summary` 展示盈利能力、利润率和成长质量。
6. 样本不足或 `data_quality.status` 不是 `ok` 时，必须在页面或结论中说明限制。

## 禁止事项

- 不要把财务摘要当完整三张表。
- 不要用单期财务指标下长期确定性结论。
- 不要把百分比字段重复乘以 100。
