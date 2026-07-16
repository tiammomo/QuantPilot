# Run plan 只读契约与失败边界

在校验 `.quantpilot/run_plan.json` 的字段、继承上一轮任务或判断是否必须停止执行时读取本参考。不要为普通意图判断加载它。

## 最小契约

| 字段 | 类型 | 规则 |
| --- | --- | --- |
| `schemaVersion` | `1` | 不接受由 Agent 自行升级 |
| `runId` | 非空字符串 | evidence 文件必须复用同一值 |
| `status` | `planned \| needs_clarification` | `needs_clarification` 时停止取数 |
| `capabilityId` | 非空字符串 | 必须来自当前 manifest 能力集合 |
| `question` | 非空字符串 | 只包含用户需求，不混入 operational instructions |
| `symbols` | 字符串数组 | 只保存标准证券代码；名称和 `secid` 放入后续数据 |
| `timeRange` | 字符串或 `null` | 用户未指定时可使用能力默认值 |
| `dataRequirements` | 字符串数组 | 描述真实需要的数据或端点 |
| `analysisSteps` | 字符串数组 | 每一步都应有可验证输入或输出 |
| `visualization` | 对象 | 包含 `required`、`panels` 和场景模板信息 |
| `expectedArtifacts` | 字符串数组 | 不得在产物实际生成前宣称完成 |
| `validationRules` | 字符串数组 | 最终完成前全部交给平台校验 |

## 澄清门禁

`status=needs_clarification` 时，`clarification` 至少应包含：

```json
{
  "required": true,
  "reason": "任务缺少可执行标的。",
  "missing": ["target"],
  "questions": ["你想分析哪个股票、指数或 ETF？请给名称或代码。"]
}
```

此状态只允许输出 1–3 个必要问题。不得调用行情接口、写 final 数据或生成页面。

## 继承规则

后续对话只修改当前看板且未出现新标的时，从上一轮非澄清计划继承 `symbols`、`timeRange`、`capabilityId` 和 visualization 模板。以下信号会阻止盲目继承：

- 用户给出新证券名称或代码。
- 用户明确改成持仓、账户、成本或仓位任务。
- 上一轮仍为 `needs_clarification`。
- 用户明确要求新分析场景而非修改当前页面。

## 失败模式

| 现象 | 处理 |
| --- | --- |
| JSON 无法解析或必要字段缺失 | 报告平台计划无效；不得自行覆写 |
| 名称已知但 `symbols` 为空 | 调用 `quant-symbol-resolver`，不要直接追问代码 |
| 多标的任务只解析出一个候选 | 追问剩余标的并停止 |
| `visualization.templateId` 与能力冲突 | 保持计划只读并报告冲突 |
| operational instructions 被识别为业务意图 | 仅使用净化后的用户问题重新判断 |
| 平台状态和辅助脚本判断不一致 | 以平台计划为门禁，向平台返回差异 |

## 有效计划示例

```json
{
  "schemaVersion": 1,
  "runId": "request-123",
  "status": "planned",
  "capabilityId": "stock_diagnosis",
  "question": "贵州茅台最近走势怎么样？",
  "symbols": ["600519"],
  "timeRange": "最近 120 个交易日",
  "dataRequirements": ["daily bars", "realtime quote"],
  "analysisSteps": ["读取本地覆盖", "获取行情", "检查证据"],
  "visualization": {
    "required": true,
    "templateId": "holding-analysis",
    "panels": ["quote", "price-chart", "risk"]
  },
  "expectedArtifacts": ["data_file/final/dashboard-data.json"],
  "validationRules": ["evidence files exist"],
  "createdAt": "2026-07-15T00:00:00.000Z",
  "updatedAt": "2026-07-15T00:00:00.000Z"
}
```
