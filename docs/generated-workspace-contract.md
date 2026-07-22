# 生成工作空间契约

生成工作空间是 Data Agent 输出的可运行交付物；QuantPilot 当前的 Delivery Pack 是 Next.js 金融看板。平台不只看页面是否能打开，还会检查通用任务身份、领域计划、数据、证据、事件、队列、验证、视觉呈现和产物契约。

这份契约的存在，是为了避免“看起来生成成功了，但没人知道数据从哪来、哪里失败过、修复过什么”。只要产物稳定，运行治理中心、评测平台和后续自动修复就都能读同一套事实。

## 基础模板

新建 workspace 会自动带上金融看板基础模板：

```text
app/page.tsx
app/globals.css
app/api/market/[...path]/route.ts
```

`app/api/market/[...path]/route.ts` 用于同源代理到 QuantPilot 后端，避免浏览器直连外部 API。

## 必需产物

平台预取数据、执行 Agent 和验证时会写入：

```text
.data-agent/workspace.json
.data-agent/profile.json
.data-agent/task.json
.data-agent/plan.json
.data-agent/finance-run-plan.json
.data-agent/finance-query-rewrite.json
.data-agent/events.jsonl
.data-agent/generation-state.json
.data-agent/generation-queue.json
.data-agent/validation.json
.data-agent/validation-repair-plan.json
.data-agent/artifact-contracts.json
.data-agent/visual-validation.json
data_file/raw/<run_id>/
data_file/final/dashboard-data.json
evidence/sources.json
evidence/data_quality.json
```

其中：

| 文件 | 作用 |
| --- | --- |
| `.data-agent/workspace.json` | 项目/工作空间身份以及当前 MoAgent executor、模型和模型 Profile |
| `.data-agent/profile.json` | 当前 Agent Profile、Domain Pack、Delivery Pack 和 capability 选择 |
| `.data-agent/task.json` | 跨业务通用的目标、实体、指标、维度、筛选、时间范围和输出合同 |
| `.data-agent/plan.json` | 跨业务通用的执行计划、领域计划引用、预期产物和验证规则 |
| `.data-agent/finance-query-rewrite.json` | schema v4 LLM 语义、Resolver 标的、安全决策与失败关闭状态 |
| `.data-agent/finance-run-plan.json` | 消费 Query Rewrite 后形成的任务规划、标准代码、能力域、预期数据和可视化模板 |
| `.data-agent/attachments.json` | 当前请求的附件清单；`attachments[].path` 必须是工作空间相对路径，不接受绝对路径字段 |
| `.data-agent/events.jsonl` | 生成链路事件审计 |
| `.data-agent/generation-state.json` | 当前请求的阶段状态、错误、修复次数和元信息 |
| `.data-agent/generation-queue.json` | PostgreSQL generation job/outbox 的可再生投影，显示 active request 和运行历史；不是跨进程 claim、锁、取消或完成态权威 |
| `.data-agent/validation.json` | 自动验证报告 |
| `.data-agent/validation-repair-plan.json` | 自动修复计划 |
| `.data-agent/artifact-contracts.json` | run plan、final data、证据、队列和视觉产物契约检查 |
| `.data-agent/visual-validation.json` | 页面视觉检查和截图检查结果 |
| `data_file/final/dashboard-data.json` | 页面绑定的最终结构化数据 |
| `evidence/sources.json` | 信源和接口证据 |
| `evidence/data_quality.json` | 数据质量、缺失字段和限制说明 |

## 这些文件怎么一起工作

可以把一个工作空间看成四层：

| 层 | 文件 | 作用 |
| --- | --- | --- |
| 组合层 | `.data-agent/workspace.json`、`.data-agent/profile.json` | 说明工作空间身份、运行时、Agent、业务包和交付方式 |
| 语义层 | `.data-agent/task.json`、`finance-query-rewrite.json` | 前者提供通用任务，后者保留金融 schema v4 细节和实体核验结果 |
| 规划层 | `.data-agent/plan.json`、`finance-run-plan.json` | 前者提供通用编排引用，后者说明金融取数和看板计划 |
| 数据层 | `dashboard-data.json`、`sources.json`、`data_quality.json` | 页面绑定数据和证据来源 |
| 运行层 | `events.jsonl`、`generation-state.json`、`generation-queue.json` | 记录生成过程、队列和当前状态 |
| 质量层 | `validation.json`、`validation-repair-plan.json`、`artifact-contracts.json`、`visual-validation.json` | 判断能否交付，并给出修复方向 |

排障时不要只盯 `app/page.tsx`。页面只是最后一层表现；如果规划、数据或质量层已经坏了，单独改页面很容易变成临时补丁。

`.data-agent/**` 是唯一的跨业务控制目录；通用合同和 Finance Domain Pack 扩展都在其中按稳定文件名区分。Agent 工具只读，平台编排器负责写入。完整设计见 [Data Agent 平台与 Domain Pack 架构](data-agent-architecture.md)。

## 页面生成规则

生成页面必须遵守：

- 使用真实数据，不保留 mock、static、sample 数据。
- 不引用外部 CDN、远程脚本、远程样式、远程字体。
- 不把 token、api key、cookie、authorization 写入生成项目。
- 浏览器取数只能读取 `data_file/final/dashboard-data.json` 或同源 `/api/market/**`。
- 金融图表应包含真实数据驱动的 K 线、成交量、指标、财务趋势、对比或风险组件。
- A 股视觉习惯使用红涨绿跌。
- 数据缺失时展示限制、warning 和人工确认项，不编造结论。
- 可视化应匹配具体分析场景，避免套用单一通用页面。

## 不建议的绕路

| 绕路 | 风险 |
| --- | --- |
| 页面里直接写死 mock 数据 | 验证和评测无法判断真实取数能力 |
| 为了让 build 过而删除图表 | 页面能打开但不再满足用户目标 |
| 缺字段时用 `0` 顶上 | 会把未知数据伪装成真实数值 |
| 只改生成项目，不改 skill | 同类错误下次还会出现 |
| 绕过 `/api/market/**` 直连外部网站 | 浏览器端容易跨域、泄露参数，也绕开本地事实库 |

## 自动验证

Agent 执行完成后，平台会自动验证生成项目。验证项包括：

- `npm run build`。
- 预览首页 HTTP 200。
- `data_file/final/dashboard-data.json` 存在且包含真实数据。
- `evidence/sources.json` 和 `evidence/data_quality.json` 存在。
- 页面绑定真实数据或同源 `/api/market` 代理。
- 页面包含金融图表。
- 生成项目没有外部 CDN、mock 数据或明文密钥。
- run plan、final data、证据、生成状态和视觉报告符合产物契约。
- Workspace、Profile、Task 与通用 Plan 存在，且在验证期间未发生身份漂移。
- Playwright 视觉检查能打开页面并识别关键内容。

手动验证：

```bash
curl -X POST "http://localhost:3000/api/projects/<project_id>/quant/validation"
curl "http://localhost:3000/api/projects/<project_id>/quant/validation"
```

本地检查脚本：

```bash
npm run check:homepage
PROJECT_ID=<project_id> npm run check:project-visual
npm run check:validation-repair
npm run check:generated-artifacts
```

## 自动修复链路

验证失败后，平台会：

1. 写入 `.data-agent/validation.json`。
2. 根据失败项生成 `.data-agent/validation-repair-plan.json`。
3. 将生成状态推进到 `repairing`。
4. 触发 Agent 执行修复指令。
5. 再次执行自动验证。
6. 成功则标记 `completed`，失败则保留错误和修复建议。

取消请求时，平台会同步更新：

- `.data-agent/generation-state.json`
- `.data-agent/generation-queue.json`
- 用户请求状态

## 工作空间健康

工作空间健康检查会聚合：

- run plan 是否存在。
- final data 是否存在。
- sources 和 data quality 是否存在。
- build/HTTP/视觉/产物契约是否通过。
- 生成队列是否仍有 active request。
- 失败修复计划是否存在。

控制台入口：

```text
http://localhost:3000/ops-platform
```
