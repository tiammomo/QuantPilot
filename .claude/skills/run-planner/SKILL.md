---
name: run-planner
description: Interpret the platform-created QuantPilot run plan, validate intent completeness, and guide the next quantitative research step without modifying platform-owned .quantpilot artifacts.
---

# QuantPilot 运行规划能力

本 skill 用于理解用户问题与平台生成的量化分析计划。QuantPilot 会先通过 `query-rewrite` 创建 `.quantpilot/query_rewrite.json`，再创建或更新 `.quantpilot/run_plan.json`、记录事件并处理澄清状态；Agent 只读取这些平台产物，再按计划取数或生成页面。

> `.quantpilot/**` 是平台只读状态目录。不得使用 Write、Edit、MultiEdit、Bash 或脚本修改、删除、移动其中任何文件；如计划结构异常，由平台修复后重新执行。

## 意图澄清门禁

规划前先判断用户问题是否已经具备执行所需的关键输入。可以运行辅助脚本：

```bash
python .claude/skills/run-planner/scripts/intent_clarifier.py --question "<用户问题>" --capability "<capabilityId>"
```

也可把 JSON 对象、JSON 文件路径或标准输入交给 `--input`：

```bash
python .claude/skills/run-planner/scripts/intent_clarifier.py \
  --input '{"question":"贵州茅台最近走势怎么样？","capability":"stock_diagnosis"}'
```

脚本只向 stdout 输出确定性的 JSON 判断，不读写项目文件；输入无效时向 stderr 输出 JSON 并以非零状态退出。输出的 `required`、`missing`、`questions` 和 `target_candidates` 仅用于发现计划缺口，平台 `run_plan.json` 仍是最终门禁。

如果平台计划或辅助判断显示缺少关键输入，向用户提出 1-3 个简短问题并停止后续取数和页面生成。澄清状态与计划落盘由平台完成，Agent 不得自行改写。

需要追问的典型情况：

- 缺少标的：例如“帮我分析一下”“这个股票怎么样”。
- 对比任务缺少至少两个具体标的：例如“帮我对比一下哪个更好”或“对比几只股票”。“几只/多只/若干股票”只是数量占位词，不能当作已提供标的。
- 投资建议类问题缺少周期、风险偏好或市场范围：例如“推荐一个可以买的股票”。
- 只有标的但没有分析方向：例如“宁德时代”。

不需要追问的情况：

- 已给出标的和方向，例如“贵州茅台最近财务怎么样？”。
- 已给出标的但问题是泛化诊断，例如“通富微电的股票怎么样”，可默认做综合诊断。
- 已给出可解析的证券名称，例如“中信证券最近怎么样”。名称中包含“证券”“股份”“公司”不代表缺少标的，不得因为用户没有同时给出 6 位代码而追问。
- 只缺时间范围或输出形式时，使用默认值：趋势默认最近 120 个交易日，财务默认最近报告期，输出默认可验证看板。

“最近怎么样”“走势如何”“表现怎么样”都属于可执行的泛化诊断目标。对这类问题，必须先用 `quant-symbol-resolver` 解析名称；能唯一确定优先级最高的 A 股时，直接进入 `planned` 并生成综合诊断看板。只有解析后仍存在多个同优先级、无法排除的证券时才追问。

如果任务文本包含“承接上一轮澄清”“原始问题”“用户补充”，必须把原始问题和补充信息合并成一个完整任务来判断。平台计划已恢复为 `planned` 时继续执行；仍是 `needs_clarification` 时只追问剩余缺口。

## 二次对话上下文继承

用户在同一个生成项目里继续说“这个看板方向对”“重构当前页面”“删除/新增/保留某个模块”“移动端不要横向溢出”等，且没有给出新的标的代码或名称时，必须先读取上一轮 `.quantpilot/run_plan.json` 并继承：

- `symbols`
- `timeRange`
- `capabilityId`
- `visualization.templateId`
- `visualization.variantId`

这类请求是对当前看板的修订，不是新任务。不要因为后续 prompt 中出现“矩阵”“相关性”“组合”“业务对象”等泛化词，就丢弃上一轮标的或把多标的对比改成持仓分析。

只有用户明确上传或描述持仓、仓位、账户、成本、现金、盈亏、调仓、证券账户截图等信息时，才选择 `portfolio_risk` / `holding-analysis`。单独出现“组合”“相关性”“分散风险”“配置观察”时，如果已有多个股票/指数/ETF 标的，应优先保持 `asset_comparison` / `stock-selection`。

规划时只使用用户可见需求和必要附件语义。平台附加的执行日志、过程叙述、技能使用说明、文件写入规则、图片处理规则等 operational instructions 不能参与标的、能力或模板判断。

## 平台计划契约（只读）

字段结构异常、需要继承上一轮计划或需要判断停止边界时，读取 [run-plan-contract.md](references/run-plan-contract.md)；普通问题不必加载该详细参考。

平台在当前生成项目中维护：

```text
.quantpilot/query_rewrite.json
.quantpilot/run_plan.json
.quantpilot/events.jsonl
```

先核对 `query_rewrite.json.resolvedSymbols`、`timeRange`、`analysisFocus` 和澄清状态，再核对 run plan；不得重新用另一套字符串规则提取标的。

Agent 必须读取并遵循 `run_plan.json` 的这些字段：

- `status`: `planned` 或 `needs_clarification`
- `question`: 用户原始问题
- `capabilityId`: 当前 `.quantpilot/manifest.json` 中的能力 ID
- `symbols`: 待分析标的，未知时先留空并在下一步调用 `quant-symbol-resolver`
- `timeRange`: 用户要求或默认范围
- `dataRequirements`: 需要调用的数据接口
- `analysisSteps`: 后续执行步骤
- `visualization`: 预期图表和页面模块
- `validationRules`: 完成前必须检查的规则
- `clarification`: 仅在 `needs_clarification` 时存在，包含 `required`、`reason`、`missing` 和 `questions`

`visualization` 必须包含场景模板字段，避免后续页面生成退化成通用看板：

- `templateId`: 例如 `holding-analysis`、`stock-selection`、`technical-timing`
- `name`: 模板中文名
- `scenario`: 模板适用场景
- `panels`: 必备页面组件
- `painPoints`: 这个场景必须解决的用户痛点
- `optionalPanels`: 有数据时增强的组件
- `dataSignals`: 页面应优先使用的数据字段
- `finalDataContract`: 最终数据应保留的关键结构

以下事件由平台自动追加并投影为用户可见阶段；本 skill 不重复输出阶段标题或进度摘要：

```json
{"event_type":"run_planned","stage":"planning","status":"success","summary":"已生成个股诊断计划，准备解析标的并获取行情、K 线、财务和公告数据。"}
```

需要澄清时平台会追加：

```json
{"event_type":"intent_clarification_required","stage":"planning","status":"warning","summary":"任务缺少标的，需要先向用户确认股票、指数或 ETF。"}
```

## 标准流程

1. 读取 `.quantpilot/query_rewrite.json` 与 `.quantpilot/manifest.json`，确认结构化问题合同、`capabilityId`、required skills、数据接口和验证规则。
2. 从用户问题识别：
   - 标的名称或代码
   - 时间范围
   - 分析类型
   - 是否需要可视化页面
3. 已有名称但没有代码时，先调用 `quant-symbol-resolver`，不要把“请给代码”当作默认追问。
4. 如果平台计划是 `needs_clarification`，输出 1-3 个追问问题并停止。
5. 如果平台计划是 `planned`，核对标的、时间范围、数据要求和页面模板；发现结构问题时报告平台，不自行修改。
6. 向平台返回本 skill 已确认的计划事实与缺口；事件文件和用户可见进度由平台统一维护。
7. 然后按计划调用后续 data skill：
   - 标的不明确：`quant-symbol-resolver`
   - 实时行情：`quant-market-data`
   - 历史走势：`quant-a-share-history`
   - 指数/ETF：`quant-index-etf-market`
   - 基本面：`quant-fundamental-financials`
   - 公告事件：`quant-announcement-events`
   - 看板生成：`dashboard-visualization`

## Workspace 回答协作

- 继承平台统一的五阶段进度；不自行重启阶段、重复进度标题、重复问题识别表或维护 Todo。
- 只提供本 skill 已确认的可验证事实、真实缺口和下一步，不输出隐藏推理、完整工具参数或占位式 “Skill executing...”。
- 本 skill 只贡献业务场景、分析对象、时间范围、数据需求、输出形式和澄清缺口；阶段编号与展示由平台统一维护。

## 禁止事项

- 不要跳过规划直接取数或生成页面。
- 不要在 `needs_clarification` 状态下取数、写 final 数据或生成页面。
- 不要修改 `.quantpilot/**`；计划、状态、事件与验证报告全部由平台维护。
- 不要把未获取的数据标记为完成。
- 不要在规划阶段编造行情、财务或公告数据。
