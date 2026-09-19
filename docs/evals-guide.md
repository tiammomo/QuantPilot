# Agent 评测指南

评测模块用于持续检查 Agent 生成工作空间的能力，覆盖用例管理、评测集、运行队列、报告、模型对比、Skill 版本影响和失败修复。

入口：

```text
http://localhost:3000/eval-platform
```

## 运行时

默认评测运行时：

- 执行器：`PI Agent`
- 模型：`Qwen 3.5 9B (Local Q5_K_M)`
- Reasoning：由服务端 `PI_AGENT_REASONING` 控制；thinking 内容只在当前 tool-call 循环内回放，不展示、不持久化

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

2026-09-18 起评测器版本为 `2.2.0`。验收同时读取底层 validation、artifact、oracle、视觉和运行错误，不能仅凭顶层 `passed=true` 通过。报告必须包含完整且不重复的评分维度、正确权重与 rubric；CI 重算加权总分，并拒绝与底层失败信号冲突的成功判定。旧版本报告仍可查看，但不能充当当前版本的发布证据。

## Data Agent 取数与证据检查

`quant_api_get` 与平台预取共用行情一致性检查：标的代码、显式交易所、请求周期和复权、K 线日期顺序与重复、OHLC 范围、无效数值、观察窗口以及数据源声明的质量错误。最终看板验收也检查各资产的行情，不能通过直接写入 final 文件绕过取数检查。缺报价、空序列和显式过期标记保留为可见警告；它们不会被补成零价格或完整数据。

HTTP 200 中的非法 JSON、错误负载或超过读取上限的不完整响应会返回失败。读取超限时应缩小查询窗口或 limit；仅供模型查看的 JSON 样本窗口仍可成功返回，但带有截断信息，不能用它冒充完整序列做计算。成功调用结果携带 `DataAgentSourceReceipt`：规范化请求摘要、完整响应字节摘要、观察时间和数据时间。`fetchedAtOrigin=observed` 表示响应未提供来源抓取时间，不能据此判断原始数据新鲜。

来源证据要求实际的 provider、端点或产物引用，并检查重复 source ID、非法样本量、观察时间、关键数据错误和引用文件。引用文件必须位于工作空间的 `data_file/` 或 `evidence/`，可安全读取且非空；证据读取拒绝路径逃逸、符号链接和特殊文件，单文件上限为 8 MiB。缺少观察时间会保留警告。现有基础证据生成采用原子写入。

这些检查证明响应与声明口径一致，不证明第三方数据真实、历史时点可得或交易日历意义上的新鲜度；仍需数据源治理、point-in-time 数据与交易日历检查。

## 语义审阅的引用契约

审阅提示词升级为 `quantpilot-agent-review-prompt-v2`。四类必需证据（final 数据、sources、quality、run plan）先在本地安全读取并计算摘要；任一文件缺失、非法或超过 2 MiB，都不会调用模型。每份模型可见证据最多 24,000 字符；较大数据转换为有效 JSON 投影并标记 `truncated`，不在半个 JSON 字符串处截断，也不重复传入完整确定性产物。

五个评分维度必须完整、唯一，分数为 0–100 整数。每个正分维度要求 1–8 个不重复的 JSON Pointer 引用，例如 `sources#/sources/0/source`；引用指向本次实际展示的投影内容。不存在的字段、继承属性或伪造路径会使审阅失败，受影响维度计零分。报告记录 `evidenceValidation`、文件摘要和被裁剪的文件；观察不完整时最多得到 warning。

证据和问题中的指令均按不可信内容提供给模型，审阅不开放工具调用，设置 60 秒总时限；模型长度截断、过滤、资源耗尽或缺少完成信号时拒绝部分评分。引用可解析只说明评分有可追踪输入，不能替代人工盲评或独立事实核验。同源 reviewer 继续明确标为非独立，语义评分不能提高确定性检查已经降低的事实与安全得分。

## 评测器可信度（Eval of Evals）

评测器本身必须接受回归测试。Mutation suite 会在一份先通过全部硬门的 golden fixture 上故意注入错误标的、空行情、缺失来源、保证收益、视觉溢出、运行错误、工具失败、快照篡改和未来数据泄漏，再检查预期 detector 是否真正拦截。

当前有 25 个确定性反例，另覆盖错误复权、重复与倒序行情、越过声明观察时点的 K 线、无效价格、空来源对象、隐藏关键质量错误、底层失败被总状态覆盖、负错误计数、伪造审阅引用、重复评分维度和篡改报告总分。反例直接调用生产使用的数据检查与评测逻辑；全部拦截只证明这些检查有效，不等同于真实模型在金融对抗任务上全部通过。

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
| 评测器 | 选择评测策略、数据集、范围和并发，执行 dry-run；运行器固定为 PI Agent，默认模型为本地 Qwen |
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

## 持久化评测 Worker

评测面板通过 PostgreSQL `eval_queue_items` 提交任务，由 `npm run worker:eval` 独立消费。`npm run dev` 默认托管该 Worker；已有外部消费者时设置 `QUANTPILOT_DEV_MANAGE_EVAL_WORKER=0`。`npm run worker:eval:once` 只检查一次到期计划并尝试消费一个任务，适合运维验证。生产进程模板为 `deploy/systemd/quantpilot-evaluation-worker.service`，需与 Web 使用同一数据库、发布版本和工作目录/持久化产物挂载。

队列和定时计划只以数据库为准，不再读取或写回 `queue.json` / `schedule.json`。既有数据库记录继续有效；文件独有的历史记录不会自动导入。Web 只负责提交、查询和取消，Worker 每轮空闲等待 2 秒，以数据库事务锁保持全局一个 benchmark 并发；任务有 60 秒租约、10 秒心跳，写入结果必须匹配未过期的租约。取消后最多等待一次心跳，由持有进程的 Worker 终止其进程组；禁止根据数据库里的历史 PID 杀进程。

Worker 崩溃或数据库连接丢失后，过期任务会被下次调度标为失败，排队任务可继续领取。为避免重复模型计费，运行中断的评测不自动重跑，应检查日志后重新提交。报告使用独立文件名并绑定任务、租约、模式和模型，不按“最近生成的报告”猜测归属。定时计划的入队与下次执行时间在同一事务提交。此机制尚未冻结全部数据集和技能包版本；完整实验快照仍属于后续工作。

## 评测器 dry-run

评测器的“模拟链路”不会真正启动 benchmark，它会验证：

- 选择范围是否可解析。
- 运行器和模型是否存在。
- benchmark 脚本是否可用。
- PostgreSQL 队列及租约迁移是否可用，日志、报告和修复单目录是否可写。
- 命令是否能构造。
- 报告解析和修复单存储链路是否可达。

API：

```text
POST /api/evals
action=simulate-flow
```

Web 和评测 Worker 必须使用相同的 `QUANTPILOT_EVAL_ROOT`（完整发布目录绝对路径）。未配置时使用进程工作目录；standalone 会改变工作目录，因此生产 systemd 模板显式设为 `/opt/quantpilot/current`。根目录在进程启动时解析为真实路径，避免运行中切换 `current` 后执行不同版本代码；该目录的 `tmp/` 需挂载共享持久化产物存储。

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
记录 `cli=pi`、AgentRun IDs、PI Agent 版本、build/git revision、turns、
cache-miss input tokens 和异常 tool failures；缺少任一证明时 CI 会拒绝报告。
当前报告合同为 schema v6：每个 case 还必须保存逐物理 run 的终态、usage、
评测器版本、rubric、首轮/最终判定与重复稳定性。E2E 还必须保存
安全 tool 计数，并证明 accepted receipt 的 `sourceRunId` 属于该 lineage、候选
来源为 `pi_agent_submit_result`，且 source run 至少成功完成一次 workspace write
和一次 `submit_result`。`workspace_recovery`、`platform_repair`、平台安全模板等
兜底候选只证明产品恢复能力，不计入 PI Agent 能力 E2E。

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
对应 CLI 参数或 `PI_AGENT_E2E_*` 环境变量收紧，但不应将契约报告改名绕过。
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
