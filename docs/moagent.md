# MoAgent 架构

MoAgent 是 QuantPilot 自研的 Agent 框架。当前框架身份为 `moagent:1.13.0`。它以进程内 TypeScript 模块运行；需要模型的 lane 默认通过 ModelPort 使用 Qwen，也可通过 ModelPort 使用 Anthropic 协议上游 DeepSeek，另保留 DeepSeek 官方 OpenAI-compatible 直连 profile；可信标准看板 lane 则执行零模型 Token 的确定性工具计划。这些路径都不依赖外部 Agent SDK、CLI 子进程或供应商 session。

## 设计目标

- Provider 与运行循环解耦：模型协议只存在于 Provider Adapter。
- 先编排、后执行：受信 PhaseGraph 在接触模型前确定 standard、custom、repair 或 data-preparation lane；模型不能自行选择能力面、预算或完成条件。
- 工具默认拒绝：没有通用 Shell，所有能力均为带 Schema、超时和输出上限的类型化工具。
- 协议面稳定：每个物理 run 的 Provider 可见工具 schema 一次确定并保持不变，动态权限在执行器内失败关闭，避免工具定义漂移破坏 prefix cache。
- 工作空间隔离：相对路径、realpath 与 symlink 三重校验，`.data-agent` 永久只读。
- 可终止、可观测：每个物理执行使用新的服务端 UUID `runInstanceId`，并派生带 `moagent_` 前缀的 runtime `runId`；运行具有结构化公共事件、累计 usage、轮数/Token/总时长预算和 AbortSignal。
- 可审计、可阻断：PostgreSQL 保存项目编排 lease、AgentRun、project/workspace 独占 lease、安全事件、replan checkpoint、工具 operation ledger、MissionSpec 物化节点与不可变 evidence receipt；数据库权威时钟、分层 heartbeat、CAS version 和 fencing token 拒绝陈旧 worker，文件系统资源锁与一次性提交授权共同保护物理写入，未决副作用会阻断新 attempt。
- 副作用可人工决策：受信应用可以为明确的 `workspace_write` / `external_write` 工具声明批准、编辑、拒绝策略；等待和恢复是 AgentRun 的持久状态，批准发生在 operation prepare 之前，拒绝和过期不会接触副作用。
- 显式完成：至少一次 workspace write 成功后才允许 `submit_result`；它只把物理 AgentRun 和 `workspace_generation` 节点推进到 `candidate_complete`。只有当前 candidate version 通过独立 EvidenceVerifier 并写入 accepted receipt，产品 Mission 才能进入 `completed`。
- 信息增益驱动：工作区版本未变化时，相同参数的可缓存读取只保留第一次真实观察；重复读取返回带原始结果摘要哈希的短引用并立即推动阶段收敛。实时行情/API 读取永不进入该缓存。
- Cache 可诊断：每轮 Provider 请求前持久化 Prompt Prefix Ledger 的哈希、长度、最长共同消息前缀、工具面变化和压缩原因，不保存 prompt 原文。
- 推理隐私：DeepSeek 官方直连的 thinking 内容仅在当前 tool-call 循环内部回放；ModelPort 的 OpenAI→DeepSeek Anthropic 协议桥因无法无损回传 Anthropic thinking block 而关闭 thinking，本地 Qwen adapter 也不发送 DeepSeek 私有字段。所有路径都不把 hidden reasoning 写入数据库或推送前端；公共 assistant/终态事件也不包含 raw cause 或完整内部 messages。

## 分层

| 层 | 路径 | 责任 |
| --- | --- | --- |
| 协议 | `src/lib/agent/types.ts` | Provider-neutral message、event、tool、usage 和 result 类型 |
| PhaseGraph | `src/lib/agent/core/phase-graph.ts` | 根据受信平台准备状态确定 deterministic standard、model custom、model repair 或 data-preparation lane，并冻结 lane 预算与安全不变量 |
| Provider | `src/lib/agent/providers/deepseek.ts`、`src/lib/agent/providers/openai-compatible.ts`、`src/lib/agent/providers/deterministic-tool-plan.ts` | ModelPort OpenAI-compatible `/chat/completions`（Qwen 与托管 DeepSeek）、DeepSeek 官方直连、SSE、严格 identity/usage 校验；或在 standard lane 生成可信预编译工具调用且不发起网络/模型请求、usage 恒为零 |
| Run Engine | `src/lib/agent/core/run-engine.ts` | 多轮 Provider/工具循环、Observation Ledger、Prompt Prefix Ledger、物理 run 内固定工具 schema、执行时动态权限、预算、取消、工具调用身份校验与独占 terminal result |
| Tool Executor | `src/lib/agent/core/tool-executor.ts` | 单次工具参数解析、typed input 校验、AbortSignal、副作用提交回调、结果 envelope 和可信 context receipt 投影 |
| HITL Control | `src/lib/agent/core/tool-approval.ts`、`src/lib/services/moagent-tool-approval-store.ts` | 受信工具审批策略、公开参数投影、决策校验、等待轮询和 PostgreSQL approval ledger；不持久化原始调用参数 |
| Progress Oracle | `src/lib/agent/core/progress-oracle.ts` | 可序列化的确定性进展判定器；已接入 Run Engine，只把新增可信只读事实、产物内容前进或已提供的失败项减少视为进展；custom/repair 在一轮无净进展后即触发 `progress_stalled` 收敛提示，不代替 terminal/验收合同 |
| Context Manager | `src/lib/agent/context/` | 输入预算、工具簇原子性、每工具专用可信 receipt projector、写后 read receipt 失效、优先级淘汰与非致命压缩降级 |
| Durable Runtime | `src/lib/agent/runtime/` | WorkspaceLease/Run/Event/Checkpoint/ToolExecution 契约、安全投影、双重 lease/fencing 与 Prisma repository |
| Generation Orchestration | `src/lib/quant/generation-queue.ts`、`src/lib/services/moagent-generation-lease-*.ts`、`src/lib/services/moagent-worker-capacity.ts`、`src/lib/services/moagent-worker-registry.ts` | 用户排队/运行结构配额、按 actor 公平 claim、数据库全局 Worker 槽位、进程注册/心跳/集群配置一致性，以及跨进程串行化 planning/data-prefetch、Agent execution 与 manual validation |
| Mission Graph | `src/lib/agent/mission/`、`src/lib/services/moagent-mission-*.ts` | 编译受信 MissionSpec、物化阶段节点、冻结 candidate version、验证证据并通过 CAS 事务提交产品完成态 |
| Tools | `src/lib/agent/tools/` | 通用文件/结构化读取、版本化语义编辑、文件批量提交、结果提交和安全策略；业务 artifact handle、alias、字段优先级由 Domain Pack 注入 |
| Skills | `src/lib/agent/skills/`、`config/moagent-skill-capsules.json` | registry/version/SHA-256 完整性校验；按 phase、附件、标的解析、模板和当前 typed tools 投影原子 runtime capsule，并精确注入所需 reference 片段；项目初始化只配置 workspace 参考镜像 |
| 产品接入 | `src/lib/services/cli/moagent.ts` | 历史上下文、消息持久化、实时事件、用户取消和执行阶段终态 |
| HTTP 接入 | `src/app/api/chat/[project_id]/act/route.ts` | 请求合同、权限、幂等、附件、配额接纳和调度响应；不承载金融规划或 Agent 执行实现 |
| 金融准备 | `src/lib/quant/finance-act-preparation.ts`、`src/lib/quant/chat-act-support.ts`、`src/lib/domains/finance/agent-tools/` | Query Rewrite、run plan、真实数据预取、受治理知识准备、Mission 创建，以及金融行情/看板/图片/JSON artifact typed tool 投影 |
| 领域执行 | `src/lib/data-agent/generation-runtime.ts`、`src/lib/quant/finance-generation-executor.ts` | 校验 schema v3 组合与 scope 信封，按 Profile ID 分派 handler；inline 与独立 Worker 共用同一执行实现 |

## 一次运行

1. HTTP 接入完成权限、幂等、附件和配额接纳后，把金融准备委托给领域应用服务。该服务先取得项目级 generation lease，再在共享文件系统资源锁内生成只读 run plan、预取真实量化数据和 evidence；同一 project 的另一 Web/worker 进程不能并发覆盖这些输入产物。
2. 产品入口限制 instruction 为 256 KiB UTF-8、requestId 为最多 128 个白名单字符；接入层校验 project/workspace 绑定，为本次执行生成 UUID `runInstanceId`，并派生带 `moagent_` 前缀的 runtime `runId`，随后加载有限条历史聊天消息。
3. 项目初始化阶段把通过 registry、版本与 SHA-256 完整性校验的 capability 完整 Skill 集合配置到 `.moagent/skills` 参考镜像，安装集合不受单次执行 phase 裁剪。执行时，仓库 `.moagent/skills` 或受校验 tgz 只提供可追溯的源材料；`config/moagent-skill-capsules.json` 按 phase、附件、标的解析状态、模板和当前 typed tools 选择可执行增量。编译结果分成稳定 system manifest 与动态 task capsule，reference 只注入命中的完整 Markdown section，不把整份 `SKILL.md` 交给模型，也不截断关键步骤。
4. 产品层在首次 Provider 请求前先取得共享文件系统资源锁，再审计旧 attempt，并以数据库事务原子取得 project/canonical-workspace 独占 lease、创建 AgentRun，记录 prompt/tool/skill/workspace 的 SHA-256 provenance；PostgreSQL 权威时钟计算租约，workspace token 与 per-run token 共同组成数据库写栅栏。启动临界区完成后释放资源锁，后续每次物理写入单独重新取得它。
5. 平台先对 run plan、final data、sources 和 data quality 做语义就绪与 DashboardSpec 预检；空 `{}`、标的覆盖不足、模板不一致、数据 run identity 漂移或已知编译前置条件不满足都会留在 data-preparation/custom surface，不让模型先调用一个必败工具。受信 PhaseGraph 随后在接触模型前选择执行 lane：满足标准 renderer 前置条件时进入 `deterministic_standard`；明确布局、样式、组件或“不要卡片”等定制进入最多 6 个模型回合的 `model_custom`；验证修复进入最多 3 个模型回合的 `model_repair`；其他任务进入最多 8 个模型回合的 `model_data_preparation`。standard lane 只携带带 digest 的短 DashboardSpec receipt，并预编译 `apply_dashboard_spec -> submit_result` 两步工具计划；custom lane 才生成有界源码合同并进入 semantic-edit surface。每个 lane 在物理 run 启动时一次确定 typed-tool schema，后续只收紧执行权限而不改变 Provider 可见定义；prepared generation 不注册泛目录读取、行情 API、无附件图片工具和 `write_file`/`edit_file`/`apply_patch` 三套冗余 mutation schema。需要模型的 lane 在每轮请求前由 Context Manager 处理上下文，且只接受框架为具体工具注册的浅层 canonical receipt projector；第三方工具即使自带同名字段也不能把路径或错误码提升为可信系统状态。没有 projector 的工具只生成框架自有 outcome tombstone：保留 call/tool/effect/status 与参数、结果摘要哈希，不吸收第三方原文或其声称的 target。被覆盖历史的最近精确 tombstone 有固定上限，更旧事实进入带计数的 hash-chain rollup；详细 read/artifact receipt 仍按重取成本淘汰，写入立即使旧 read receipt 失效。这样副作用簇可以被原子替换，而不会因永久保留大段 raw tool output 挤爆上下文。产品历史只继承真实用户消息与标记为 final 的助手结论。
6. `deterministic_standard` 使用 Provider-compatible 的可信工具计划执行器，不发起网络或模型请求，并为每一步报告严格的零 Token usage；它仍经过同一个 Run Engine、operation ledger、workspace fencing、事件和 terminal gate，任一步失败都会停止并交给平台恢复。其余 lane 才请求项目选中的模型 Provider；两个网络 Provider 都对 response ID、choice、tool-call identity、终止顺序和 Token 算术执行严格状态校验。`total != input + output`、cache hit/miss 不闭合或 reasoning 超过 output 均作为协议错误；Provider 完全缺少 usage 时，运行时按本轮 prepared request 做保守 input/cache-miss 估算并标记 `usageSource=estimated`，不能以零绕过累计预算。模型 lane 将单请求 prepared、全 run 累计 prepared 与 Provider 回报后的 cache-miss 分成三个独立预算：单请求上限为 custom 24k、repair 20k、data-preparation 60k，累计图上限分别为 72k、60k、480k（data 默认再由 160k 累计输入上限收紧）。每轮剩余累计额度会反向收紧 Context Manager，连同 nonce envelope 一起放不下时不接触 Provider；cache-miss 上限不会误伤可复用的缓存前缀。
7. reasoning 只保留在内存；durable projector 跳过高频 delta，assistant/tool 原文只保存长度与 SHA-256 审计信息，拒绝 hidden reasoning、raw cause、完整 messages 和凭据字段。
8. 每个工具动作使用框架派生的 `operationId`。`tool_started` 在副作用前写 `prepared` ledger，只有新建 ledger 才授权执行；省略 `effect` 的工具（包括 terminal）保守视为 `external_write/reconcile_required`。单文件和 DashboardSpec 双文件写入共用批量 writer：先取得 `<workspace>/.moagent-workspace.lock`，拒绝重复 canonical target，保存并 fsync `.moagent-mutation-journal` 中的 staged 内容、pre-image、hash 与 manifest，再只消费一次数据库 `commit_authorized`；授权后复验全部 before hash，manifest 持久化为 `committing` 后才逐文件 rename 并 fsync 目标目录。进程内中途失败走同一全量预检回滚；进程崩溃留下的 prepared/commit-authorized workspace operation 会在下一次启动锁内恢复为原状态并确定性终结 ledger。若目标后来被用户改成未知 hash，恢复拒绝覆盖并继续阻断。UI/Message observer 失败不会反向中断已完成的工具动作。
9. 工具结果以标准 envelope 回灌 Provider；terminal 工具必须独占其调用轮次。执行前只做不发明字段的有界参数修复：去掉完整 JSON code fence、转义字符串内非法控制字符、移除尾逗号，并把唯一匹配的已注册工具名、常见字段别名和 `/app/**` 等虚拟工作区路径归一化；不完整 JSON、未知工具和非工作区绝对路径仍失败关闭。同一模型轮次内，同文件 `query_json`/`query_text_file` 会合并 pointer/anchor，完全相同的只读调用会删除，合并后才计入实际工具预算。文件/结构化读取声明 `workspace_generation` observation policy：相同工具与规范化 JSON 参数在工作区没有成功写入时只执行一次；重复调用返回原始 tool-call ID、turn 和结果 SHA-256 的短引用。任何成功 workspace write 都立即使全部旧 observation 失效。实时 `quant_api_get` 不缓存。QuantPilot 产品配置下连续 3 个预写只读轮次或写后连续 2 个只读轮次会切换执行权限；首次成功写入前拒绝 `submit_result`，读取预算耗尽后在执行器内拒绝 read 工具，但这两类权限变化都不会增加、删除或重排本次物理 run 的 Provider 工具定义。ProgressOracle 只接收框架投影的成功 pure/read receipt、工具观察摘要和 workspace writer 的 `artifactSha256 + target` 内容状态；无 digest 写入、同内容重写、重复读取和 A→B→A 回访都不制造进展。Trusted ContextCapsule 与收敛指令合并为当次请求末尾的 request-local user JSON envelope，并用每个物理 run 随机生成的 192-bit nonce 与固定 system 协议绑定；调用方伪造相同 marker 或旧 nonce 不能取得控制权。该 envelope 不污染持久历史，循环持续到提交、预算耗尽、超时、取消或失败。
10. 每轮实际请求 Provider 前生成 Prompt Prefix Ledger：只记录 system/messages/tools SHA-256、请求字节数、最长共同消息前缀、是否 append-only、是否发生 ContextManager 压缩、临时控制后缀轮换和工具集合变化。该事件与同 turn 的 Provider cache hit/miss usage 一起进入 durable event ledger，用于定位非预期 cache break；不保存提示词、工具结果或 hidden reasoning，也不缓存/重放 completion。
11. `submit_result` 只提交候选产物，物理 AgentRun 以 `candidate_complete` 结束；平台为 Mission 当前 candidate version 写入 candidate receipt，并用数据库 CAS 独占认领该 candidate 的验证权，随后执行 build、HTTP、视觉、数据与 evidence 验证。第二个 Web worker 不能把同一可变工作区并发认领为自己的验证输入；失败项会把 Mission 推进到 `repair_required`，再由 repair profile 产生下一 candidate version。
12. EvidenceVerifier 在同一 workspace 资源锁内双读平台验证报告、冻结 subject/evidence manifest 并探测持久预览。manifest 除必需产物外，还逐文件覆盖现存的 `components/**`、`lib/**`、`src/**`、`scripts/**`、`public/**`、`data_file/final/**`、`evidence/**` 和构建配置/锁文件；单文件、总字节、文件数、realpath 与 symlink 都有硬限制。只有 Mission/spec/request/candidate identity、必需检查、报告与 manifest 前后稳定、本地 HTTP 200 全部匹配时，Mission store 才以 CAS 事务写 accepted receipt、关联 `accepted_receipt_id`，并与 UserRequest 完成态原子提交。Agent 文本、`submit_result` 或单独的 validation `passed` 都没有该权限。

## PhaseGraph 与 ProgressOracle

PhaseGraph 是模型外的受信路由器。它只读取平台准备状态、prepared intent、附件和 DashboardSpec readiness，返回不可变的 lane、推理强度、预算与 `stableToolSchema`、`singleWriter`、`terminalSubmissionRequired`、`platformVerificationRequired` 四项安全不变量；模型文本不能改变路由结果。

| Lane | Provider 模式 | 回合 / 工具硬上限 | 单请求 prepared | 累计 prepared | Cache-miss |
| --- | --- | --- | ---: | ---: | ---: |
| `deterministic_standard` | 确定性两步工具计划，实际模型 Token 为 0 | 2 / 2 | 图内占位 1，实际 0 | 图内占位 1，实际 0 | 图内占位 1，实际 0 |
| `model_custom` | 项目模型 Provider | 6 / 12 | 24,000 | 144,000 | 24,000 |
| `model_repair` | 项目模型 Provider | 3 / 8 | 20,000 | 60,000 | 20,000 |
| `model_data_preparation` | 项目模型 Provider | 8 / 20 | 60,000 | 480,000；默认运行时收紧为 160,000 | 60,000 |

`ProgressOracle` 是独立、Provider-neutral、可序列化的纯状态机与类封装。通用默认连续 2 个回合没有可验证进展即报告 stalled；为让定制和修复尽快收敛，QuantPilot 的 custom/repair 明确收紧为 1 回合，data-preparation 保持 2 回合。只有新增可信事实、首次出现且没有让确定性检查变差的 workspace fingerprint、或调用方实际提供的失败检查数量下降才算进展。工具调用本身、重复 observation、仅“写入成功”以及 workspace fingerprint 的 A→B→A 回访都不算完成或净进展。

1.9 已把 ProgressOracle 接入实时 Run Engine 和 durable checkpoint：custom/repair 首个无进展回合只在下一轮注入 `progress_stalled` 软纠偏，仍允许针对冲突、失效 pointer 或 anchor 重新读取；连续第二个无进展回合、重复同一 observation，或独立 read-loop 阈值命中后，执行器才在保持 Provider schema 固定的同时硬拒绝 read。真实内容前进会清除 Oracle 的软、硬停滞状态。每个非终态工具轮结束后，Run Engine 发出不含原文的 `progress_evaluated`，durable sink 以 canonical JSON hash 写入 `model_turn_completed` checkpoint v2；恢复审计会在任何调和副作用前校验 hash 和 Oracle schema，异常立即失败关闭。停滞事件还会投影为前端状态，便于区分“模型仍在执行”和“运行时正在推动收敛”。Run Engine 当前没有回合内验证器，因此没有虚构 `failedCheckCount`；失败项减少信号只在未来接入确定性验证 observation 后启用。Oracle 只影响收敛，不判定完成，也不会绕过 terminal、Mission 或 EvidenceVerifier。

Checkpoint v2 仍固定声明 `recoveryMode=replan_required`。它保存的是完成 operation ID、阶段和哈希化 ProgressOracle 状态，不是 Provider session、完整 messages 或 hidden reasoning；新 attempt 会验证旧 checkpoint 后基于当前工作空间重新规划，不把旧 Oracle 快照冒充成模型已经看过的上下文。v1 checkpoint 可继续读取，但不会被误判为包含 Oracle 状态。

## Mission Graph 与完成语义

Mission 是一次用户请求的产品级执行合同，AgentRun 是其中一次物理模型执行，两者不能混用。当前受信编译器把 MissionSpec 物化为 `planning`、`data_prefetch`、`workspace_generation`、`validation`、`evidence_verification` 和 `preview_readiness` 六个节点；每个节点持久化依赖、effect、可用工具、所需 Skill section、输入/输出产物、预算与验收谓词。模型只能在分配给它的 `workspace_generation` 能力面内工作，不能自行改变图、预算或验收标准。

```text
AgentRun candidate_complete
  -> candidate receipt / candidateVersion N
  -> validation
  -> EvidenceVerifier + persistent preview probe
  -> accepted receipt
  -> AgentMission completed
```

PostgreSQL 使用三张 Mission 表承载这一边界：

- `agent_missions` 保存不可变 spec/spec hash、当前 candidate version、CAS version、产品状态、验证 lease/fencing 和最终 accepted receipt 引用；`(project_id, active_slot)` 唯一约束保证每个项目最多一个非终态 Mission，终态以 NULL 释放 slot。
- `agent_mission_nodes` 保存 MissionSpec 的物化节点及各节点状态；节点预算和能力范围是数据合同，不从模型输出反推。
- `agent_evidence_receipts` 保存候选、验证与验收的有界投影，以 receipt hash、subject hash、candidate version 和唯一约束提供幂等/陈旧证据防护。

Candidate receipt 与 accepted receipt 不是原始执行日志。数据库不得保存 prompt、hidden reasoning、HTML、截图、完整 build 日志或 unrestricted tool output；receipt 只包含经过边界校验的身份、哈希、检查状态、原因码和预览就绪摘要。一次修复会生成新的 candidate version，旧 version 的验证结果不能完成新 version。`completed`、`failed`、`cancelled` 是 Mission 终态；`candidate_complete`、`verifying`、`repair_required` 和 `repairing` 均保持原始 UserRequest 活跃。

1.10 起，`candidate_complete -> verifying` 不是永久占用状态，而是数据库权威时钟驱动的独占 lease。验证会话独立续心跳；异常退出会主动退回 `candidate_complete`，进程崩溃则允许新 worker 在 TTL 到期后接管，并把 `verification_fencing_token` 单调加一。Evidence receipt、UserRequest completion 和 Mission completion 的同一事务必须同时匹配 owner、candidate version、未过期 lease 与 fencing token。被接管的旧 worker 即使随后恢复，也不能写入 receipt 或完成 Mission。已有旧版 `verifying` 且没有 lease 的行会被视为可接管，不会永久卡死。

1.11 把同一可靠性模型扩展到最外层编排。`agent_generation_leases` 每个 project 只有一行，覆盖 `planning_data_prefetch`、`agent_execution` 和 `manual_validation`；租约以 PostgreSQL `clock_timestamp()` 计算期限，独立心跳续期，过期接管会单调增加 fencing token。新 generation 在写 run plan 前还会检查 active Mission，避免旧 Mission 存活时先覆盖输入产物、最后才因唯一约束失败。规划/预取持有共享文件系统资源锁；模型 workspace mutation 仍由 AgentRun/workspace lease 与逐次文件锁保护；build、preview 和 evidence commit 继续由 generation lease、Mission verification lease 与 evidence 文件锁分层保护。外层租约只决定“谁可编排”，不会替代各阶段自己的提交栅栏。

1.12 增加 PostgreSQL durable dispatch/outbox。`agent_generation_jobs` 在 HTTP 返回成功前保存 request、provider-neutral execution envelope、claim/attempt、数据库时钟租约、fencing token 与终态；`agent_generation_outbox_events` 和 job 状态在同一事务提交，并以 `(job_id, sequence)` 幂等投影。执行信封有严格字节上限，任何 `api_key`、authorization、cookie、password、secret、token 等 credential-shaped 字段都会在写库前拒绝；Provider 私有 session 和 hidden reasoning 从不进入信封。暂停会原子写 `cancelled`、提升 fencing token 并清空 lease，因此旧 worker 的 heartbeat 或完成写无法覆盖取消。

信封还固定本次准备阶段已经取得的 Personalization Recall 与 Governed Knowledge Preparation。Handler 只在实际执行时登记 exposure/usage，不会重新 query Memory 或知识库；因此 evidence、用户可见的准备状态和 Agent 实际收到的 capsule 属于同一份快照。信封解析会校验状态、计数和 prepared/capsule 不变量，持久数据异常时失败关闭。

`.data-agent/generation-queue.json` 从 1.12 起只由 PostgreSQL job/outbox 重新物化，不再参与 claim、取消或完成判定。生产模式由独立 generation worker 轮询 `pending/retry_wait`、claim、续租并分派严格版本化的 Data Agent execution envelope；Finance 只是运行时注册表中的一个 handler。读取投影时会审计过期 dispatch：只有 generation lease、AgentRun lease 和 Mission verification lease 都不能证明仍有活 worker，才允许旧 attempt 进入指数退避的 `retry_wait`；达到最大 attempt 后才封存为 `interrupted/failed + replan_required`。本地开发可显式使用 `inline`，生产 readiness 会拒绝该模式。

手工 `/quant/validation` 也服从同一完成门：运行中、修复中或验收中的 Mission 返回 busy；已完成 Mission 只返回既有 acceptance snapshot，不重写权威报告；只有可恢复的 `candidate_complete` / `repair_required` 能在项目生成锁内封存恢复候选。显式 requestId 必须已经存在、属于当前项目且与当前 generation 一致，验证接口不能伪造新的 generation 身份。前端只依据 Mission-aware generation status 决定是否恢复预览，`validation passed` 或数据库中的裸 `Project.previewUrl` 都不能旁路 accepted receipt。

## 回合耗时与 Token 口径

Workspace 在每个用户回合的最终回复下方显示一条非卡片式运行摘要。耗时使用根 `UserRequest.createdAt -> completedAt`，覆盖排队、规划、数据预取、主 Agent、自动验证、受限修复和持久预览，而不是只统计某一次模型请求。Token 使用同一请求 lineage 中实际创建的全部 `AgentRun` 求和，包含主执行、失败或中断的物理 attempt，以及 `${requestId}-validation-repair[-N]` 自动修复；仅走平台确定性生成或意图澄清而未调用模型时明确显示 `Tokens 0`。

模型 Provider 的 `include_usage` 是首选真值。Run Engine 严格校验 `input + output = total`、cache split 和 reasoning 子集，并把累计 usage 写入 durable run/event；Provider 缺失 usage 时使用保守估算。最终投影会根据 durable usage event 区分 provider、estimated、mixed 和 partial，非 provider 完整统计在界面使用“约”或“不完整”提示，不能冒充账单精确值。

统计结构只写入最终 Message metadata，由客户端严格校验非负安全整数和 Token 算术后渲染；不会拼进最终 Markdown 正文，因此下一轮 `buildBoundedHistory` 不会为指标重复支付上下文 Token。Stage 5 成功、失败和暂停消息都持久化同一结构，SSE/WebSocket 断线恢复和历史加载使用同一个权威消息。指标采集失败只记录观测错误，不能改变 Mission 已提交的业务终态。

自动修复还带有失败集收敛保护：如果某次 Agent repair 自身未正常提交，且修复前后的 blocking check ID 集合完全相同，平台会先判断这些失败是否全部属于可安全接管的页面展示类问题。只有满足该条件时才提前使用确定性看板模板并重新执行完整验证；数据、证据、策略、代理等失败，以及失败项已经减少的 repair，仍保留正常的受限修复预算。这样可以避免同一个展示失败连续消耗多个满轮次 run，同时不让模板恢复覆盖数据与 evidence。

## 中断与恢复语义

MoAgent 当前实现的是 **replan recovery 基础**，不是原会话 resume。DeepSeek thinking tool turn 所需的私有 reasoning 不写数据库，因此进程重启后不能完整重放旧协议历史。Checkpoint 固定声明 `recoveryMode=replan_required`；v2 包含阶段、turn、源事件序号、已终结 operation ID，以及只由框架哈希组成的 ProgressOracle 快照。v2 state hash 使用 canonical JSON 计算，避免 PostgreSQL jsonb 键顺序变化造成误判；恢复审计在取得 reconciliation lease 或执行回滚前完成 hash/schema 校验。旧 v1 checkpoint 仍按 replan-only 兼容读取。

新 attempt 启动前会在 workspace 资源锁内审计 lease 已过期的旧 run 及其 `prepared`、`commit_authorized`、`uncertain` ledger。没有未决写操作的旧 attempt 会取得 reconciliation lease 后标为 `interrupted`；带 v1 durable journal 的 `prepared` / `commit_authorized` workspace write 会先校验每个目标只处于 before/after 两种已知 hash，再回滚 pre-image、fsync、把 execution 确定性记为 failed 并关闭旧 run。已 succeeded/failed 的 journal 只做一致性校验和清理。没有可证明 journal 的 `commit_authorized`、任意 `uncertain`、external write 或用户后续修改冲突仍继续阻断，绝不猜测性重放或覆盖。

旧 attempt 安全关闭后，独立 dispatcher 会在最大 attempt 范围内创建新的物理执行，并从原始 UserRequest、当前工作空间、run plan 和验证结果重新规划；不得把旧 Provider 会话当作可精确续跑状态。超出自动重试预算后才要求用户重新发起任务。

## 人工决策与副作用边界

MoAgent 1.13 把 Human-in-the-loop 作为工具运行时合同，而不是提示词约定。它默认关闭，也不会按工具名猜测：只有应用层拥有的 mutating tool 显式提供 `approval` 策略，并且 composition root 注入 `toolApprovalHandler`，调用才会进入等待。`pure` / `read` 工具声明审批会在 Run Engine 构造阶段失败；additional/plugin tool 自带的 `approval` 与 `projectContextReceipt` 一样会在组合边界被剥离。

```ts
const publishReport: MoAgentTool<PublishReportInput> = {
  name: 'publish_report',
  description: 'Publish a reviewed report to the business system.',
  inputSchema: publishReportSchema,
  effect: 'external_write',
  idempotency: 'operation_key',
  approval: {
    reason: 'Publishing makes the report visible outside this workspace.',
    allowedDecisions: ['approve', 'edit', 'reject'],
    timeoutMs: 10 * 60_000,
    projectPublicInput: (input) => ({
      reportId: input.reportId,
      channel: input.channel,
    }),
  },
  parseInput: parsePublishReportInput,
  execute: publishReport,
};
```

`projectPublicInput` 是安全边界，只能返回适合数据库和审批 UI 的有界 JSON。框架拒绝 credential、password、token、cookie、system prompt、messages 和 reasoning 等字段；原始工具参数只留在活跃 Worker 内存，数据库保存 `inputHash`、公开投影、原因、允许动作和决策人。若允许 `edit`，提交的 JSON 会再次经过同一凭据策略、原工具 `parseInput` 和公开投影一致性校验；只投影部分参数的工具因此只能批准或拒绝，不能编辑隐藏字段。

执行顺序固定为：

```text
tool_approval_requested
  -> AgentRun=waiting + waiting_for_external_input checkpoint
  -> agent_tool_approvals=pending
  -> approve/edit/reject/expire
  -> tool_approval_resolved + AgentRun=running
  -> tool_started + operation prepared
  -> physical effect
```

- `approve` 使用原始参数；`edit` 使用重新校验后的完整公开参数；`reject` 生成确定性的 `TOOL_APPROVAL_REJECTED` 工具失败，让模型基于拒绝结果重新规划。
- 审批过期等价于框架拒绝，`resolvedBy=expired`，不 prepare operation。
- 活跃 Worker 等待时继续 heartbeat，并仍占用当前 run/workspace lease 与 Worker slot，保证同一工作空间不会在用户决策期间被另一任务改写。总运行超时与用户取消仍可中止等待。
- Worker 在 pending、approved 或 edited 后崩溃，都不会让新 Worker 直接执行旧调用。旧 run 仍按 `replan_required` 封存；新 attempt 必须重新生成工具调用和新的 approval ID。旧 run 离开 `waiting` 后，尚未决策的审批会转为 `expired`，不会继续出现在可操作列表。
- `GET /api/projects/[project_id]/agent/approvals` 列出项目范围公开审批；`POST /api/projects/[project_id]/agent/approvals/[approval_id]` 提交决策；`GET /api/projects/[project_id]/agent/runs/[run_id]` 分页读取公开事件、最新 checkpoint 和审批时间线。读接口要求 `project.read`，决策要求 `project.update`，跨项目 ID 返回未找到。
- Chat 工作区会显示待确认卡片；即使页面刷新，也会从持久化审批表恢复待处理操作，不依赖浏览器保留某条实时消息。

MoAgent typed writer 与 takeover 遵守同一锁顺序：共享文件系统资源锁在外，数据库 workspace/run/operation 锁在内；数据库只提交一次性授权，不把事务悬挂在文件 I/O 上。journal 目录属于框架元数据，不进入模型路径、workspace provenance 或候选产物；正常工具终态可观测后清理，崩溃时用于恢复多文件 rename 的部分提交。普通调用永不按时间强拆锁；启动恢复只会对 schema-v2、同 hostname 且 PID 已由操作系统证明不存在的 owner 创建排他的 recovery claim，复验 owner 内容与 device/inode 后原子隔离，并在 quarantine 路径再次验证身份后才清理。失败清理只处理自己的 claim，绝不回头删除可能已属于新 owner 的原锁路径。远端、多主机、损坏或身份不明的孤儿锁仍按 runbook 人工处理。

这不是对任意共享存储的无条件跨主机保证。生产挂载必须让所有实例看到同一 canonical root，并支持跨客户端原子 `mkdir`、同文件系统原子 `rename` 和所需 fsync 语义；当前自动化覆盖单 Node 进程、两个 Prisma client、本机故障注入与启动回滚，目标 NFS/CSI/分布式卷仍必须另做多进程、多主机断电验收。generation job/outbox、generation lease、AgentRun/workspace 与 Mission verification 已有分层 lease/fencing，`.data-agent/generation-queue.json` 只是可再生投影。进程崩溃后旧 attempt 会被封存且旧写入被拒绝，独立 worker 会创建 replan attempt；系统仍不会恢复旧 Provider 私有会话，也不对外承诺跨数据库与任意存储的 exactly-once。

## 内置工具与权限

| 工具 | 权限 |
| --- | --- |
| `list_files`、`read_file`、`read_file_range`、`search_files` | 非预取流程的通用只读工具；拒绝越界与逃逸 symlink。预取 generation 不注册这些工具 |
| `inspect_dashboard_contract` | 固定检查 run plan、final/evidence、页面/样式/代理；在 6000 字符运行预算内优先保留组件/渲染行范围、根布局、CSS layout selector、卡片式 surface 整改目标，以及可直接传给 `query_text_file` 的分文件批量字面锚点，用于一次定向编辑，不代表验证通过；已有 `initial_dashboard_contract` 时禁止重复调用 |
| `query_json` | 单次批量查询最多 16 个 RFC 6901 JSON Pointer；核心产物优先使用 `final_dashboard`、`sources_evidence` 等 artifact handle。明确的 `public/data/dashboard*.json` 或匹配当前标的的代码文件别名会安全纠正到 `data_file/final/dashboard-data.json`，标的不一致时失败关闭；其他缺失路径返回实际存在的权威 JSON 候选。缺失 pointer 降级为根 shape，常见点路径自动转成 pointer；大数组只返回头部与较新的尾部样本，并显式记录省略信息、shape 与 SHA-256 |
| `query_text_file` | 单次批量查询最多 16 个组件、函数或 CSS selector 字面锚点；多行/超长锚点会拆成可执行的短字面量，缺失锚点降级为有界文件头，而不是浪费一轮模型调用；公平返回有界行窗，替代完整源码和连续区间扫描 |
| `apply_dashboard_spec` | 从只读 run plan 与 final data 编译平台持有的 TSX/CSS；template/variant 只能作断言。plan 状态、required flag、panel 集合、variant renderer capability 和真实数据前置条件全部匹配后才在一个 durable fence 内提交两个文件；个股综合指挥台和个股基本面快照均有受信 renderer，后者额外要求可归属的 0–100 财务质量评分、至少两期报表/趋势与明确公告数组；不支持项在写入前以稳定错误码返回 |
| `semantic_edit` | 使用 `query_text_file` 返回的 SHA-256 对单个 TS/TSX 顶层声明、唯一 CSS rule 或精确行范围做版本化编辑；保持 export/default/async/generator、声明种类和 var/let/const 身份，并在提交前重解析完整文件 |
| `write_file`、`edit_file`、`apply_patch` | 仅在非预取数据准备或 failure-scoped repair 中按需开放；generation 只写 UI/源码 allowlist，拒绝 env、package、lockfile、scripts 和执行配置 |
| `quant_api_get` | 仅允许固定本地服务上的行情、研究、基本面、指标、事件、回测和健康检查只读端点；拒绝补数、探测及其他管理端点；单次运行最多 32 次请求 |
| `quant_extract_uploaded_image` | 校验工作空间图片、格式、尺寸、大小和 SHA-256；不伪造 OCR 结果 |
| `submit_result` | 校验声明产物仍在工作空间内并返回 `candidate_complete`；成功后仅结束物理 AgentRun，不能声明 Mission 验证通过 |

平台预取 generation 不再使用一个固定的宽工具面。PhaseGraph 为 standard lane 固定 `apply_dashboard_spec` 与 `submit_result` 两项 schema，并由可信确定性 Provider 依次调用，模型 Token 为零；custom lane 固定 `query_json`、`query_text_file`、`semantic_edit`、`submit_result` 四项 schema，最多请求模型 6 回合。两者都不注册平台 inspector、legacy whole-file mutation、行情 API 或无附件图片工具。repair 最多请求模型 3 回合，平台把 failed check ID 编译成 `app/page.tsx`、`app/globals.css`、明确 final/evidence 目录或唯一 API route 的精确 allowlist；未知失败项不再退化为 `app/**`。失败报告缺失、陈旧或没有明确失败项时，模型调用前即失败关闭。lane 启动后的 schema 保持固定；首次写入、读取预算和 failure scope 只改变执行器授权，不能扩大能力。

`list_files`、文件读取、`inspect_dashboard_contract`、`query_json` 与 `query_text_file` 使用工作区代际 observation cache。它不是跨请求缓存，也不是 completion cache：只在当前 run 内、且没有成功 workspace write 时复用完全相同的读取。`quant_api_get` 等实时/外部读取明确不使用该机制。

前端不再逐条倾倒底层读取尝试：同一 request 中相同工具与目标被压成一条连续活动，后续成功会吸收之前的参数失败；路径被 artifact resolver 安全纠正时显示规范化后的真实目标与“已纠正”，只有最终未恢复的失败保留“待恢复”和可展开诊断。模型每轮的自由文本旁白始终标记为内部消息，用户只看到平台阶段、typed tool 的有效结果和最终结论。

Workspace 的可见回答由平台确定性投影为五个阶段：理解问题、准备数据与证据、分析并生成工作区、执行平台校验、完成或未完成。第一阶段的三列表格直接来自权威 `run_plan`，不是模型推测；第五阶段只有在自动校验、独立证据验收和持久预览 HTTP 就绪全部成功后才允许显示“已完成”。每条阶段消息使用 project、request 和 stage 派生的稳定 ID 持久化，路由重入或进程恢复不会在历史中制造重复阶段。模型不再接收前端逐轮追加的过程旁白长提示，也不重复阶段编号、识别表、Todo 或 `Skill executing...` 占位文本，从而减少输入和输出 Token。typed tool 的开始事件使用临时执行态，完成结果以相同 tool call 收敛为一条可核验记录。

## 生成代码执行边界

MoAgent 本身没有 Shell 工具，但生成项目仍需要由平台执行 build 和 preview。Linux 上，这些命令默认进入 user、mount、network 和 PID namespace：只读挂载当前生成工作空间、共享 `node_modules` 和 Node runtime，仅开放工作空间 `.next` 写入；宿主项目其余目录、用户主目录和平台密钥不会挂载，进程环境也会按白名单重建。执行前的 artifact policy 会先拒绝子进程、动态执行、任意网络客户端、宿主绝对路径等高风险代码，策略不通过时不会启动 build 或 preview。

network namespace 内只启用 loopback，不存在宿主或外网路由。preview 由平台在宿主 `127.0.0.1` 监听受控端口，再经 `/tmp/qp-preview/<runtime-id>/p.sock` 转发到隔离网络中的 Next.js；固定的同目录 `m.sock` 只向沙箱提供配置的无凭据 market-data host/port，以支持标准 `/api/market/**` 只读路由，目标不能由生成代码选择。短运行时目录规避 Linux Unix Socket 路径长度上限，只绑定当前预览的两个 socket，不暴露宿主 `/tmp`，并随预览生命周期清理。build 不创建任何桥接，preview 也不能访问 ModelPort、数据库、Memory、AKEP 或通用外网。生产环境仍应保留容器/主机防火墙作为纵深防御。非 Linux 平台默认拒绝执行生成代码；只有已经处于外部隔离环境的本地开发机，才可显式设置 `QUANTPILOT_ALLOW_UNSANDBOXED_GENERATED_CODE=1` 作为不安全覆盖，生产环境不得开启。

生成工作区的依赖安装固定使用 `--ignore-scripts`，宿主侧不执行 `preinstall/install/postinstall/predev` 等项目代码；项目自身 `predev` 只会由沙箱内的标准 `npm run dev` 生命周期执行。需要原生构建脚本的依赖必须先进入平台审核过的共享依赖或专用构建镜像，不能通过放宽生成工作区权限临时解决。

## 扩展规则

- 新 Provider 实现 `MoAgentModelProvider`，不得让其 wire format 泄漏到 Run Engine。
- 新工具实现 `MoAgentTool`，必须声明 JSON Schema、输入校验、AbortSignal、超时、有界输出、`effect` 和 `idempotency`；漏声明 effect 会被保守当成 `external_write/reconcile_required`，不要依赖默认值获得更宽执行语义。需要人工控制的 mutating tool 还必须由受信应用声明 `approval` 与无凭据的完整公开投影；含隐藏参数的工具不得开放 edit。只有框架内建工具可注册逐工具 `projectContextReceipt`，projector 必须浅层校验固定字段并只返回 bounded canonical target/hash/bytes；产品 additional tool 的 receipt/approval projector 都会被剥离。只有结果完全由当前 workspace generation 决定的只读工具才能声明 `observationCache: 'workspace_generation'`。
- 新 AgentRun 终态只能通过结构化 `MoAgentRunResult` 和 `run_finished` 事件表达；产品完成态只能由当前 candidate version 的 accepted evidence receipt 驱动。
- 内部 `MoAgentEvent` 的工具事件可包含 raw arguments/result，只允许受信的进程内消费者读取；数据库、Message、SSE/WebSocket 和其他产品边界必须分别使用显式安全投影，不得直接序列化内部事件或完整 `MoAgentRunResult`，也不得保存内部 messages、hidden reasoning、raw tool arguments/result 或 raw cause。
- Provider 必须拒绝响应与工具调用身份缺失、身份漂移、重复 ID 和不完整终止，不能容错拼接成可执行动作。
- 新 Skill 必须进入 registry/lock，并在 `config/moagent-skill-capsules.json` 声明 phase、typed-tool 依赖、原子步骤、完成条件和可选 reference selector。发布检查会拒绝缺失 capsule、越界引用或包含 Bash/MCP/curl/npm 执行指令的 runtime capsule。
- 产品层不能持久化 hidden reasoning，也不能把 Agent 阶段成功当作整条生成请求成功。

## 外部项目对照审计

MoAgent 可以参考其他 Agent 项目的可验证设计，但不直接引入外部运行时。当前实现与能力边界以本文、[生成工作空间契约](generated-workspace-contract.md) 和受版本控制的质量门为准；历史项目对照审计不再作为长期文档，避免把阶段性结论误认为现状。

仓库 `.moagent/skills` 是受 registry/lock/hash 校验的唯一 MoAgent Skill 编译输入；旧 `.claude` 源目录和 Skill alias 均不再读取。少量历史数据库字段只用于数据审计，不参与 MoAgent 执行控制流。

MoAgent 执行前必须把 `prisma/schema.prisma` 中的 durable Agent runtime 表、项目级 generation lease、generation job/outbox 和三张 Mission/evidence 表、`user_requests(id, project_id)` 复合唯一约束、每项目唯一 active Mission/job slot、AgentRun `build_revision`、严格 workspace identity 以及全部关联外键一并应用到 PostgreSQL，并生成对应 Prisma Client。只读 catalog readiness 的当前契约版本是 `20260722000300_enforce_agent_run_workspace_identity`；它同时检查 `agent_runs.workspace_key` 没有默认值，并存在已验证的 `sha256:<64 hex>` check constraint。本地开发与生产启动都执行非破坏性的版本化 `prisma migrate deploy`，并通过 readiness 后才接收运行。

PostgreSQL 并发契约有独立、不可静默跳过的验收入口。测试工具会对目标执行隔离 schema 同步，因此必须指向全新或可销毁的隔离测试数据库，绝不能指向开发共享库或业务库：

```bash
MOAGENT_TEST_DATABASE_URL='postgresql://...' npm run test:moagent:postgres
```

该套件当前覆盖同项目与同 canonical workspace 数据库竞争、数据库时钟抗 worker clock skew、generation 与 Mission verification 过期接管/旧 token 拒写、request 绑定、一次性提交授权、`uncertain` 后禁止继续写、终态释放和资源锁/接管线性化；CI 的 contract evaluation job 会提供临时 PostgreSQL 并强制执行。资源锁测试仍是本机进程内测试，不替代目标共享卷验收。外层编排 lease、Mission validation/evidence lease 与 typed workspace-write run fence 是三层不同职责，不能合并成一个长期持有的数据库事务。

## 版本溯源与真实 E2E 门禁

每条 AgentRun 持久化 `frameworkVersion=moagent:1.13.0` 与 `buildRevision`。CI/deployment 优先使用显式 revision；本地 dirty checkout 会把 tracked diff 以及所有 untracked path、类型、长度和内容 SHA-256 纳入有界 fingerprint，无法完整读取时显式标记 `dirty.unavailable`，不会冒充干净 HEAD。数据库 migration 曾为 1.7 之前的旧记录写入 `legacy:pre-1.7`；这是历史迁移标记，不会把旧运行重标为 1.13 证据。

确定性 contract benchmark 只验证平台合同，不能证明模型 Agent 能力。正式发布证据把三类结果分开验收：默认本地 Qwen live-model cases、零模型 `deterministic_standard` product control，以及 repair/cancellation/crash runtime controls。live-model 证据必须由真实 `/act -> Mission -> EvidenceVerifier -> accepted receipt` 链路产生，并同时匹配当前 framework/build/git、OpenAI-compatible provider/Qwen model、request identity、完整 case 集、时间顺序和 receipt hash；`unversioned:*` 与 `dirty.unavailable` 构建不能作为发布证据。每个 case 保存逐物理 run 的有界安全摘要，accepted receipt 必须绑定 lineage 中状态为 `candidate_complete` 的 source run，候选来源必须是 `moagent_submit_result`，且 ledger 至少证明一次成功 workspace write 与一次 `submit_result`；平台恢复或安全模板候选不能冒充 MoAgent 能力成绩。live-model Token 证明按 run 与聚合双重要求 `input > 0`、`cached + cacheMiss = input`、`input + output = total`；deterministic product control 则要求全部 usage 分量严格为零并证明 `apply_dashboard_spec -> submit_result`。字段缺失或把 cache miss 伪装为零都不能通过效率门。

## 配置

`config/llm.json` 是仓库级 LLM profile 事实源，固定 provider、model、Base URL、凭据环境变量名、Agent 开关和 Query Rewrite 默认策略。项目创建或下一次执行时，解析后的无密钥模型选择会同步到数据库 `Project.settings.llm`、`.data-agent/workspace.json.runtime` 和 `.data-agent/finance-run-plan.json.llm`。QuantPilot 本地只保存受限 `MODELPORT_API_KEY`；DeepSeek 上游 Key 只存在于 ModelPort。可选官方直连的 `DEEPSEEK_API_KEY` 仅作为部署/CI 进程 secret 注入，不写项目文件或本地默认配置。

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `MODELPORT_API_KEY` | 无 | 默认 Qwen 与日常 DeepSeek 共用的受限 ModelPort 客户端凭据 |
| `DEEPSEEK_API_KEY` | 无 | 可选 DeepSeek 官方直连凭据；本地默认不配置 |
| `QUANTPILOT_LLM_AGENT_ENABLED` | `1` | 项目级 MoAgent 模型执行总开关；无密钥选择会写入 `.data-agent/workspace.json.runtime` 与 Finance Run Plan |
| `QUANTPILOT_LLM_QUERY_REWRITE_ENABLED` | `1` | Query Rewrite 总开关；关闭后量化规划失败关闭，不启用关键词改写 |
| `QUANTPILOT_QUERY_REWRITE_LLM_TIMEOUT_MS` | `15000` | Query Rewrite 语义调用硬超时，允许 500–15000ms |
| `QUANTPILOT_QUERY_REWRITE_LLM_INVALID_OUTPUT_RETRIES` | `2` | 本地量化 Qwen 的强制工具参数不符合 schema 时最多再请求两次；每次仍由 LLM 重写，绝不使用关键词/正则语义兜底 |
| `QUANTPILOT_QUERY_REWRITE_LLM_MAX_RETRIES` | `0` | Query Rewrite Provider 瞬时错误重试次数，上限 1；最终失败会停止规划和预取 |
| `MOAGENT_MAX_REQUEST_BYTES` | `2000000` | 单次 Provider 请求体的 UTF-8 字节硬上限；超限时不发起网络请求 |
| `MOAGENT_PROVIDER_MAX_RETRIES` | `2` | 响应流开始前，网络错误与瞬时 HTTP 状态的最大重试次数 |
| `MOAGENT_PROVIDER_RETRY_BASE_MS` | `500` | Provider 指数退避的基础等待时间 |
| `MOAGENT_PROVIDER_RETRY_MAX_MS` | `10000` | 单次 Provider 重试等待上限，包括服务端 `Retry-After` |
| `MOAGENT_TOOL_OUTPUT_CHARS` | `6000` | 单个 typed tool 的模型可见输出上限；结构化工具会在该预算内继续投影或返回分批查询提示 |
| `MOAGENT_MAX_TURNS` | 未设置 | 可选的更严格上限，不能突破 PhaseGraph：standard 为 2 个确定性工具回合，custom 为 6 个模型回合，repair 为 3 个模型回合，data-preparation 为 8 个模型回合 |
| `MOAGENT_MAX_TOTAL_TOOL_CALLS` | 未设置 | 可选的更严格上限，不能突破 PhaseGraph 的 standard 2、custom 12、repair 8、data-preparation 20 次累计工具调用预算 |
| `MOAGENT_PRE_WRITE_READ_ONLY_TURNS` | `3` | 首次成功写入前允许的连续只读轮数；达到后 Provider schema 保持不变，执行器从下一轮拒绝 read 调用 |
| `MOAGENT_POST_WRITE_READ_ONLY_TURNS` | `2` | 成功写入后允许的连续只读轮数；达到后 Provider schema 保持不变，执行器再次硬切回写入/提交阶段 |
| `MOAGENT_MAX_TURN_OUTPUT_TOKENS` | `12000` | 单次 Provider 调用的输出 Token 上限 |
| `MOAGENT_MAX_RUN_OUTPUT_TOKENS` | 未设置 | 可选的更严格上限，不能突破 PhaseGraph 的 standard 1（实际 usage 为 0）、custom 8,000、repair 6,000、data-preparation 16,000 |
| `MOAGENT_CONTEXT_WINDOW_TOKENS` | `128000` | MoAgent 内部上下文治理窗口；是产品保守值，不等同于 Provider 宣传上限 |
| `MOAGENT_MAX_INPUT_TOKENS` | `48000` | 每次 Provider 请求的内部输入预算；运行时还会收紧到 PhaseGraph 的 custom 24k、repair 20k、data-preparation 60k 单请求上限，并按本 run 剩余累计 prepared-input 额度逐轮继续收紧。data lane 因此默认实际单请求上限仍为 48k。估算包含最终 request-local envelope，采用带安全余量的多语种启发式并对高熵长串提高权重 |
| `MOAGENT_CONTEXT_CAPSULE_MAX_BYTES` | `2048` | 单次 Trusted ContextCapsule 上限；显式配置只能进一步收紧。超限先按优先级淘汰，仍放不下则保留 canonical 历史并跳过压缩，不让压缩失败影响工具正确性 |
| `MOAGENT_MAX_RUN_INPUT_TOKENS` | `160000` | 累计输入 Token 上限；同时收紧网络前的累计 full prepared 预留，但不改变单请求或 cache-miss 上限。默认有效累计 prepared 为 custom 144k、repair 60k、data-preparation 160k。优先使用严格校验的 Provider usage，缺失时按完整 prepared request 保守估算 |
| `MOAGENT_MAX_RUN_CACHE_MISS_INPUT_TOKENS` | 未设置 | 独立的 Provider 回报后累计 cache-miss breaker；可选值只能更严格，不能突破 PhaseGraph 的 standard 1（实际 usage 为 0）、custom 24,000、repair 20,000、data-preparation 60,000。它不收紧 full prepared 预留；Provider 缺少 cache breakdown/usage 时才把完整输入保守计为 cache miss |
| `MOAGENT_TIMEOUT_MS` | `1200000` | 总运行超时 |
| `MOAGENT_LEASE_TTL_MS` | `60000` | Durable run lease 有效期 |
| `MOAGENT_HEARTBEAT_INTERVAL_MS` | `15000` | Durable run 独立心跳间隔，必须小于 lease TTL |
| `MOAGENT_APPROVAL_POLL_INTERVAL_MS` | `500` | 活跃 Worker 查询 pending tool approval 的间隔，允许 1–10000ms；只影响已显式声明 approval 的 mutating tool，不会全局开启审批 |
| `MOAGENT_MISSION_VERIFICATION_LEASE_TTL_MS` | `120000` | Mission validation/evidence 独占租约；进程崩溃后到期候选才允许被新 worker 接管 |
| `MOAGENT_MISSION_VERIFICATION_HEARTBEAT_INTERVAL_MS` | `30000` | Mission 验证独立心跳，必须小于 verification lease TTL；心跳失败后当前 worker 失败关闭 |
| `MOAGENT_GENERATION_LEASE_TTL_MS` | `120000` | 项目级 planning/data-prefetch、Agent execution、manual validation 外层编排租约；数据库时钟到期后才允许接管 |
| `MOAGENT_GENERATION_HEARTBEAT_INTERVAL_MS` | `30000` | 外层编排独立心跳，必须小于 generation lease TTL；失去 fencing 后当前 orchestrator 失败关闭 |
| `MOAGENT_DISPATCH_LEASE_TTL_MS` | `120000` | durable generation job worker claim 有效期；只使用 PostgreSQL 权威时钟 |
| `MOAGENT_DISPATCH_HEARTBEAT_INTERVAL_MS` | `30000` | dispatch worker 独立心跳，必须小于 dispatch TTL；取消/接管后旧 worker 被 fencing |
| `MOAGENT_DISPATCH_PENDING_ORPHAN_GRACE_MS` | `120000` | job 已入库但未 claim 的崩溃窗口宽限期；到期且无细粒度活 lease 时封存为 replan-required |
| `MOAGENT_DISPATCH_ENVELOPE_MAX_BYTES` | `262144` | provider-neutral replan 信封的最大 JSON 字节数；credential-shaped 字段始终拒绝，允许范围 1 KiB–4 MiB |
| `MOAGENT_RESOURCE_LOCK_WAIT_MS` | `5000` | workspace 锁等待上限；启动仅可接管同主机、PID 已死亡的 schema-v2 owner，远端/不明锁超时失败关闭 |
| `MOAGENT_INSTANCE_ID` | `hostname:pid` | 写入资源锁 owner metadata 的稳定实例标识；容器部署建议设置为 pod/instance ID，不能包含换行或超过 256 UTF-8 bytes |
| `MOAGENT_WORKSPACE_NAMESPACE` | `quantpilot-local` | canonical workspace 身份命名空间；共同执行同一 project 的实例必须共享 PostgreSQL、namespace 与物理文件系统。不共享工作区的部署必须隔离数据库/project identity，不能只靠改 namespace 绕过 project lease |
| `MOAGENT_SKILL_CONTEXT_CHARS` | `6000` | 数据准备阶段的 Skill manifest + task capsule 总字符预算；原子内容超限时失败，不做语义截断 |
| `MOAGENT_PREFETCHED_SKILL_CONTEXT_CHARS` | `4000` | 平台预取 generation/repair 的 Skill manifest + task capsule 总字符预算 |
| `MOAGENT_REASONING_EFFORT` | 空 | 遗留兼容配置，当前 runtime 不读取；执行强度由 PhaseGraph 固定为 standard 不调用模型、custom/repair `medium`、data-preparation `high` |
| `MOAGENT_REASONING` | `1` | 设为 `0` 关闭 thinking |
| `QUANTPILOT_GENERATED_SANDBOX` | `1` | Linux 上启用生成项目 namespace 沙箱；设为 `0` 仍需显式不安全覆盖 |
| `QUANTPILOT_ALLOW_UNSANDBOXED_GENERATED_CODE` | `0` | 仅供已外部隔离的非生产开发环境使用；生产必须保持关闭 |
