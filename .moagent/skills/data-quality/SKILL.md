---
name: data-quality
description: Use this skill after fetching quantitative data and before visualization to assess data quality, write evidence files, and expose source/time/limitation details.
---

# QuantPilot 数据质量与证据能力

本 skill 用于把“已经取到的数据”变成可追溯证据。任何量化分析任务在生成可视化页面前，都必须检查数据质量，并写入 `evidence/sources.json` 与 `evidence/data_quality.json`。

## 资源与确定性评估

生成/修复证据文件或判断 `ok`、`warning`、`error` 边界时，读取 [evidence-contract.md](references/evidence-contract.md)。其中定义两个 evidence 文件的结构、时间语义、敏感信息禁令和失败模式。

把真实数据集元数据交给评估脚本：

```bash
python .moagent/skills/data-quality/scripts/assess_data_quality.py --input quality-input.json
```

`--input` 支持 JSON 对象、文件路径或 `-`（stdin）。脚本只向 stdout 输出 JSON，其中 `sources` 和 `data_quality` 可分别由平台落盘；脚本不联网、不读写项目文件、不生成时间戳。结构无效或发现敏感凭据时以非零状态退出。

## Workspace 回答协作

- 继承平台统一的五阶段进度；不自行重启阶段、重复进度标题、重复问题识别表或维护 Todo。
- 只提供本 skill 已确认的可验证事实、真实缺口和下一步，不输出隐藏推理、完整工具参数或占位式 “Skill executing...”。
- 本 skill 只贡献数据集状态、来源、时效、样本量、缺失字段、警告和限制；阶段编号与展示由平台统一维护。

## 何时必须使用

当任务涉及以下任意内容时，在完成取数后、生成页面前必须使用：

- 实时行情、K 线、财务、公告、指数、ETF、行业或组合数据。
- 需要展示数据来源、更新时间、样本长度、缺失字段或限制说明。
- 平台自动验证要求 evidence 文件存在。

## 必须产出的文件

```text
evidence/sources.json
evidence/data_quality.json
```

如果当前任务已有 `.data-agent/finance-run-plan.json`，证据文件中的 `runId` 应与当前 run plan 的 `runId` 保持一致。

## sources.json 结构建议

```json
{
  "schemaVersion": 1,
  "runId": "request_id_or_run_id",
  "created_at": "2026-05-23T10:00:00.000Z",
  "sources": [
    {
      "dataset": "realtime_quote",
      "symbol": "600519",
      "name": "贵州茅台",
      "source": "eastmoney",
      "endpoint": "GET /api/v1/quotes/realtime/600519",
      "artifact_path": "data_file/raw/quote-600519.json",
      "as_of": "2026-05-22T15:00:00+08:00",
      "fetched_at": "2026-05-23T10:00:00.000Z",
      "status": "success"
    }
  ]
}
```

## data_quality.json 结构建议

```json
{
  "schemaVersion": 1,
  "runId": "request_id_or_run_id",
  "status": "ok",
  "created_at": "2026-05-23T10:00:00.000Z",
  "datasets": [
    {
      "dataset": "daily_kline",
      "symbol": "600519",
      "row_count": 120,
      "source": "eastmoney",
      "fetched_at": "2026-05-23T10:00:00.000Z",
      "missing_fields": [],
      "warnings": []
    }
  ],
  "checks": [
    {
      "id": "kline_sample_length",
      "status": "ok",
      "summary": "已获取 120 条日 K 数据，满足当前看板要求。"
    }
  ],
  "limitations": [
    "实时行情可能存在交易所延迟，结论仅用于分析辅助。"
  ]
}
```

## 工作流程

1. 读取 `.data-agent/finance-run-plan.json`，确认当前问题、标的、数据需求和 runId。
2. 汇总本轮已经获取的数据，包括实时行情、K 线、财务、公告等。
3. 检查每个数据集：
   - 是否为空。
   - 是否包含 `symbol`、`source`、`fetched_at` 或 `quote_time`。
   - 样本长度是否满足任务，例如 K 线是否达到要求条数。
   - 是否存在关键字段缺失，例如价格、成交量、报告期、公告日期。
   - 外部数据源是否失败、降级或过旧。
4. 写入 `evidence/sources.json`，记录每个数据集的来源、接口、时间戳和本地文件路径。
5. 写入 `evidence/data_quality.json`，记录状态、检查项、缺失字段、警告和限制说明。
6. 向平台提交可验证的数据质量摘要；`data_quality_checked` 事件与用户可见阶段由平台统一维护。
7. 然后再交给 `dashboard-visualization` 生成页面。

## 状态规则

- `ok`：核心数据可用，缺失项不影响当前分析。
- `warning`：部分字段缺失、样本不足、数据源降级或时间较旧，但仍可生成带限制说明的看板。
- `error`：核心数据不可用，必须在页面中展示真实错误，不允许用假数据替代。

## 禁止事项

- 不要编造 `fetched_at`、`quote_time`、报告期或数据来源。
- 不要把接口失败伪装成成功。
- 不要只在聊天里说明数据质量，必须写入 evidence 文件。
- 不要修改 `.data-agent/**`；计划、事件、状态和验证报告由平台维护。
- 不要把 token、cookie、authorization header 或其他敏感信息写入 evidence。
