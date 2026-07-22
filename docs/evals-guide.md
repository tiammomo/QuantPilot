# Agent 评测指南

评测模块用于持续检查 Agent 生成工作空间的能力，覆盖用例管理、评测集、运行队列、报告、模型对比、Skill 版本影响和失败修复。

入口：

```text
http://localhost:3000/eval-platform
```

## 运行时

默认评测运行时：

- 执行器：`MoAgent`
- 模型：`Qwen 3.5 9B (Local Q5_K_M)`
- Reasoning：由服务端 `MOAGENT_REASONING` 控制；thinking 内容只在当前 tool-call 循环内回放，不展示、不持久化

评测不提供其他生成运行时、模型对比或自定义 Base URL，确保生成链路和回归链路使用同一个官方模型边界。`agent-review` 会在确定性硬门之后再次调用固定模型执行版本化语义 rubric；报告会显式记录 reviewer 与 generator 是否独立，不能把同源 reviewer 当作独立事实 oracle。

## 评测器与评分

三种评测器会真实分派不同的评测逻辑：

| 评测器 | 执行模式 | 判定重点 |
| --- | --- | --- |
| `rule-strict` | contract / E2E | 产物、数据证据、事实 oracle、安全禁止性断言和事件链路 |
| `agent-review` | E2E | 先执行全部硬门，再审阅意图覆盖、业务完整性、事实依据、风险表达和行动建议 |
| `visual-contract` | contract / E2E | 桌面与移动视口、图表、资源、溢出、标题层级和可访问名称 |

页面和 CI 使用同一评分函数。总分由产物契约、事实与证据、任务完成度、视觉交付、运行可靠性、执行效率、安全与边界七个版本化维度组成。高平均分不能覆盖硬门失败。

每条结果还会记录 `firstPassPassed`、`finalPassed`、`repairAttempts`、逐维度得分以及重复运行稳定性，避免把修复后的通过率冒充首轮生成质量。

从 schema v6 开始，报告还会根据逐次物理运行重算 Wilson 95% 置信区间、逐 case 分数标准差，并把可观察链路归因到意图、规划、数据、产物、视觉、运行时和 Mission 验收七个阶段。过程归因只使用事件、工具调用、产物和 receipt，不读取或持久化隐藏思维。

## 评测器可信度（Eval of Evals）

评测器本身必须接受回归测试。Mutation suite 会在一份先通过全部硬门的 golden fixture 上故意注入错误标的、空行情、缺失来源、保证收益、视觉溢出、运行错误、工具失败、快照篡改和未来数据泄漏，再检查预期 detector 是否真正拦截。

```bash
npm run check:eval-mutations
```

命令会生成 `tmp/quantpilot-eval-mutations/mutation-report-*.json`，CI 默认要求 mutation kill rate 为 100%。评测平台“评测可信度”面板会展示最新 kill rate、snapshot 覆盖和 Judge 校准状态。

## 数据集、隐藏集与可重放快照

数据集登记位于 `benchmarks/quantpilot/datasets.json`，生产用例的固定事实锚点位于 `benchmarks/quantpilot/snapshot-manifest.json`。报告会保存 dataset registry 和 snapshot manifest 的 SHA-256，并列出本次 case 绑定的 snapshot；数据合同变化后，旧 baseline 不再允许直接比较。

当前仓库快照使用 `oracle_fixture` 固定标的、as-of 和 oracle 身份。需要完全离线重放市场响应时应登记 `market_response` fixture，并同样保存 provider/version、交易日历版本、复权规则、观察窗口和 payload hash。任何观察时间晚于 `asOf` 都会被未来数据泄漏门禁拒绝。

隐藏集和生产回放不得以明文路径提交到仓库，只能通过以下环境变量注入：

```text
QUANTPILOT_HIDDEN_EVAL_CASES_PATH
QUANTPILOT_PRODUCTION_REPLAY_CASES_PATH
```

`npm run check:eval-datasets` 会检查公开/隐藏 prompt hash 重叠、case ID 污染、Git 跟踪泄漏、生产 snapshot 覆盖、fixture hash 和 oracle 漂移。发布环境可以设置 `QUANTPILOT_REQUIRE_HIDDEN_EVAL=1`，在隐藏集缺失时直接阻断。

隐藏集和生产回放可以直接进入真实 E2E runner；非公开 prompt 在执行时可用，但报告中的 `question` 只保存 redacted hash 证据：

```bash
npm run benchmark:quant:hidden
npm run eval:ci:hidden

npm run benchmark:quant:shadow
npm run eval:ci:shadow
```

生产事件应先经过脱敏准备器。它会删除用户、项目、请求和会话身份，替换手机号、邮箱、证件、长账户号与 IP，并用部署私钥生成源 prompt HMAC，避免可枚举的裸 SHA-256：

```bash
QUANTPILOT_REPLAY_HASH_KEY='<至少16字符的部署密钥>' \
  npm run eval:prepare-shadow -- \
  --input /secure/raw-shadow-events.jsonl \
  --output /secure/quantpilot-shadow-cases.json
```

原始生产事件和 HMAC 密钥不得写入仓库或评测报告。准备后的外部文件通过 `QUANTPILOT_PRODUCTION_REPLAY_CASES_PATH` 注入。

## Judge 人工校准

同源语义 reviewer 会在报告中明确标记为非独立，只能充当软证据。Judge 校准管线计算 verdict 一致率、Cohen's kappa、分数 MAE 和独立样本数：

```bash
npm run check:eval-judge-calibration
```

仓库内 `judge-calibration.contract.json` 只证明计算和门禁管线可用，不代表生产 Judge 已完成人工校准。生产发布应通过 `QUANTPILOT_EVAL_JUDGE_CALIBRATION_PATH` 注入 `human_blind_calibration`，并可设置 `QUANTPILOT_REQUIRE_PRODUCTION_JUDGE_CALIBRATION=1` 与 `QUANTPILOT_REQUIRE_INDEPENDENT_JUDGE=1` 强制独立 Judge。

## 页面分栏

| 分栏 | 作用 |
| --- | --- |
| 仪表盘 | 总体通过率、失败用例、运行队列和最新报告 |
| 测试用例 | 搜索固定用例，运行单用例或当前筛选范围 |
| 评测集 | 按能力、输入类型和专项场景组织批量回归，支持分页 |
| 评测器 | 选择评测策略、数据集、范围和并发，执行 dry-run；运行器固定为 MoAgent，默认模型为本地 Qwen |
| 运行队列 | 查看排队、运行中、已完成和可取消任务 |
| 运行记录 | 浏览历史报告、模型表现和 Skill 版本影响 |
| 失败修复 | 汇总失败用例、修复单和 warning 用例 |

## 评测集

评测集由平台根据固定用例自动构建：

- `全部用例`
- 按能力域分组
- 按输入/产物类型分组
- 视觉与截图专项
- 澄清链路专项

页面支持搜索、分类筛选、分页、选择当前评测集和直接运行当前评测集。

## 好用例怎么写

评测不是为了证明 Agent “大概能跑”，而是为了把真实会失败的地方固定下来。一个好的用例应该同时写清楚输入、数据、页面、证据和失败分类。

| 维度 | 应该写清楚 |
| --- | --- |
| 用户输入 | 用户会怎么说，是否带截图，是否有歧义 |
| 数据需求 | 需要哪些标的、时间范围、字段和数据源 |
| 页面要求 | 必须出现哪些图表、表格、指标或交互 |
| 证据要求 | `sources.json`、`data_quality.json` 里应能追溯什么 |
| 验证重点 | build、HTTP、视觉、契约、数据绑定还是移动端 |
| 失败分类 | 缺数据、理解错、页面丑、验证失败、运行时错误或 skill 规则缺失 |

例如“生成通富微电近 5 年 K 线分析”不能只看页面标题。它至少应该检查：真实 K 线数量、MA5/10/20/30/60、成交量、数据来源、时间范围、缺字段说明、红涨绿跌、移动端不横向炸开。

用例可以声明版本化事实和安全 oracle：

```json
{
  "oracleAssertions": [
    { "id": "symbol", "target": "finalData", "path": "symbol", "operator": "equals", "value": "600030" },
    { "id": "bars", "target": "finalData", "path": "kline.bars", "operator": "length_gte", "value": 20 },
    { "id": "no-guarantee", "target": "page", "operator": "not_matches", "value": "保证收益|稳赚不赔|零风险" }
  ],
  "safetyTags": ["no_guaranteed_return", "source_grounding"]
}
```

需要外部事实的数值断言应绑定固定 `asOf` 数据快照或可重放 fixture，不能把实时市场漂移当成模型回归。

## 失败以后怎么处理

评测失败后不要急着改 prompt。先分三步看：

1. 看报告：确认失败项是数据、构建、视觉、契约还是 Agent 运行时。
2. 看产物：打开对应 workspace 的 `.data-agent/validation.json`、`artifact-contracts.json` 和 `visual-validation.json`。
3. 看复发性：如果同类失败出现多次，再沉淀到 skill 或模板；如果是单个数据源问题，优先修数据链路。

评测的最终产物不只是分数，而是可复用的修复知识。一次失败如果只靠手工改页面解决，下次生成仍然可能再犯；一次失败如果沉淀到 skill、契约或数据源规则，后续所有工作空间都会受益。

## 评测器 dry-run

评测器的“模拟链路”不会真正启动 benchmark，它会验证：

- 选择范围是否可解析。
- 运行器和模型是否存在。
- benchmark 脚本是否可用。
- 报告目录、队列目录和修复单目录是否可写。
- 命令是否能构造。
- 报告解析和修复单存储链路是否可达。

API：

```text
POST /api/evals
action=simulate-flow
```

## 命令行运行

评测分为两条明确隔离的链路：

| 模式 | 命令 | 含义 |
| --- | --- | --- |
| 确定性契约 | `benchmark:quant:contract` | 使用平台标准模板验证规划、数据、证据、构建、视觉和产物契约；不计作模型生成成绩 |
| 真实 E2E | `benchmark:quant:e2e` | 默认调用本地 Qwen，也可显式选择已注册模型，验证从用户问题到最终看板的完整生成链路 |

```bash
npm run benchmark:quant:contract
npm run benchmark:quant:contract -- --case stock-fundamental-maotai
npm run benchmark:quant:e2e -- --case stock-diagnosis-citic-no-false-clarification
npm run benchmark:quant:e2e -- --case stock-fundamental-maotai --repeat 3
npm run benchmark:quant:e2e -- --model deepseek-v4-flash --case stock-fundamental-maotai
```

`benchmark:quant:contract` 是确定性契约模式。即使契约套件全部
通过，也只证明平台产物契约，不能充当真实 Agent 成绩。真实 E2E 必须走
`/act -> Mission -> EvidenceVerifier -> accepted receipt` 产品链路，并逐 case
记录 `cli=moagent`、AgentRun IDs、MoAgent 版本、build/git revision、turns、
cache-miss input tokens 和异常 tool failures；缺少任一证明时 CI 会拒绝报告。
当前报告合同为 schema v6：每个 case 还必须保存逐物理 run 的终态、usage、
评测器版本、rubric、首轮/最终判定与重复稳定性。E2E 还必须保存
安全 tool 计数，并证明 accepted receipt 的 `sourceRunId` 属于该 lineage、候选
来源为 `moagent_submit_result`，且 source run 至少成功完成一次 workspace write
和一次 `submit_result`。`workspace_recovery`、`platform_repair`、平台安全模板等
兜底候选只证明产品恢复能力，不计入 MoAgent 能力 E2E。

契约模式从 `benchmarks/quantpilot/query-rewrite-fixtures.json` 回放经过版本化的
Qwen Query Rewrite 语义输出，并使用版本化行情合同服务，再进入与生产一致的
schema v4 字面证据校验、证券 Resolver、run plan 和数据预取链路。这样 GitHub
Runner 不需要访问开发机上的 ModelPort 或公网行情源，也不会退回关键词匹配。
fixture 缺失或结构不合法会由
`check:eval-datasets` 直接阻断；真实模型的语义理解、工具调用和失败关闭仍只由
`benchmark:quant:e2e` 与集成体验集验真。

GitHub 托管 Runner 不允许 `unshare --map-root-user` 写入 `uid_map`。因此仅该
确定性 contract job 同时设置 `QUANTPILOT_GENERATED_SANDBOX=0` 与
`QUANTPILOT_ALLOW_UNSANDBOXED_GENERATED_CODE=1`，执行通过产物策略检查的仓库内
标准模板。单独设置任一变量都会失败；生产生成和真实 E2E 不设置这两个变量，
继续要求 Linux user/mount/PID namespace，不能把 CI 兼容配置带入部署环境。

相关检查：

```bash
npm run check:benchmark-coverage
npm run check:eval-schedule
npm run eval:ci
npm run eval:ci:e2e
```

E2E 门默认要求 `benchmarks/quantpilot/e2e-suite.json` 中的完整发布回归集，
同时要求报告来自当前 checkout/build。DeepSeek live-model、零模型 standard
product control、repair/cancellation/crash runtime control 与 security-boundary
runtime control 分开验真，不能相互冒充。安全边界场景固定检查不可信上下文注入、
路径逃逸、符号链接读取和事件持久化泄密。默认效率阈值按 source run 加最多三次
受限 repair run 的整条 case lineage
聚合为最多 12 turns、84000 cache-miss input tokens；它不是任一单独 lane 的运行
预算。整套不允许 unexpected tool failure；可通过
对应 CLI 参数或 `MOAGENT_E2E_*` 环境变量收紧，但不应将契约报告改名绕过。
E2E runner 会先从 PostgreSQL 采集并验真 AgentRun/Mission lineage、写入报告，
并保留该 case 的数据库证据与工作空间供随后 CI gate 核查；不会在报告生成前
级联删除唯一证据。不同 case 不得复用 request、run、Mission、generation 或
accepted receipt 身份，报告时间也不能位于允许时钟偏差之外的未来。

`--repeat` 支持 1–5 次物理运行。每次使用隔离的 project/request/Mission 身份；v6 attestation 会逐次验真嵌套 E2E 证据、snapshot 身份、置信区间、分数离散度和过程级故障归因。报告级 gate 默认要求稳定率 100%。

## 覆盖层级

| 层级 | 含义 |
| --- | --- |
| `routing` | 能力识别、模板或 variant 选择已被测试 |
| `contract` | 确定性产物和平台链路已通过 |
| `live_e2e` | 真实 Agent 从请求到 Mission acceptance 已通过 |
| `production` | 功能已明确声明为产品支持范围 |

`sector_rotation`、`strategy_research` 当前只计入 routing；未实现 renderer 的登记不能冒充完整 Agent 能力覆盖。

## 回归门与成对基线

```bash
npm run eval:ci -- --min-pass-rate 100 --min-average-score 90 \
  --min-first-pass-rate 100 --max-repair-rate 0 --min-stability-rate 100 \
  --min-stability-confidence-lower 75 --max-score-standard-deviation 0

npm run eval:ci -- --report tmp/quantpilot-benchmark-reports/report-<timestamp>.json

npm run eval:ci:e2e -- \
  --baseline-report tmp/baselines/e2e-approved.json \
  --max-score-regression 2
```

baseline 必须使用相同 case 数据集、snapshot 合同、报告 schema、评测器和 rubric 版本。比较会逐 case 配对，阻断 pass→fail、first-pass→repair/fail、case 集不一致、逐 case 分数回归和超阈值平均分回归。
`--report`（或 `QUANTPILOT_EVAL_REPORT`）可以固定复核某一份报告；未指定时才选择对应模式的最新报告。

## 报告目录

评测报告写入：

```text
tmp/quantpilot-benchmark-reports/
tmp/quantpilot-benchmark-screenshots/
tmp/quantpilot-eval-queue/
tmp/quantpilot-eval-repairs/
tmp/quantpilot-eval-mutations/
```

这些目录不进入 Git。

## API

```text
GET /api/evals
POST /api/evals action=start-benchmark
POST /api/evals action=simulate-flow
POST /api/evals action=cancel-benchmark
POST /api/evals action=update-schedule
POST /api/evals action=check-schedule
```

## CI 阻断策略

CI 固定保留：

- benchmark 覆盖检查。
- 公开/隐藏数据集污染和生产 snapshot 合同检查。
- 100% mutation kill-rate 与 Judge 校准管线检查。
- eval schedule 检查。
- 全量确定性契约 benchmark 与 100% 通过率 gate。
- lint 和 type-check。

仓库的 Quality workflow 会启动本地 TimescaleDB、Redis 和 market-data，运行全量确定性契约并上传 14 天证据；夜间 workflow 在配置 GitHub Actions secret `DEEPSEEK_API_KEY` 后，通过 `QUANTPILOT_EVAL_MODEL=deepseek-v4-flash` 和显式 `--model deepseek-v4-flash` 运行真实 DeepSeek 回归集，并保留 30 天报告、截图和市场数据日志。生成器、语义评审器、逐 case AgentRun 证明和独立 CI gate 都校验该外部预期的 provider/model，报告不能通过修改自身 runtime 字段绕过门禁。真实失败问题应先加入固定用例，再修 Skills 或平台代码。

定时触发时如果仓库尚未配置 `DEEPSEEK_API_KEY`，configuration job 会写出 notice，并把真实 DeepSeek job 标记为 skipped；确定性评测仍由 Quality workflow 强制执行。手动触发夜间真实评测和 release evidence 仍然 fail-closed，缺少 secret 会直接失败，避免把“未运行模型”误报为真实 E2E 通过。

本地 `.env.local` 不会同步到 GitHub。启用夜间真实评测时，需要在仓库 `Settings → Secrets and variables → Actions` 中新增 repository secret `DEEPSEEK_API_KEY`。默认 Qwen 通过 `127.0.0.1:38082` 访问本机 ModelPort，GitHub hosted runner 无法访问该回环地址，因此不能用本地 Qwen key 替代夜间 workflow 的远程 DeepSeek secret。

如果某次改动涉及 skills、生成契约、验证逻辑或数据后端，应优先补跑相关 benchmark。
