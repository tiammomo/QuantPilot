# MoAgent × Claw Code 对照审计

本文记录 QuantPilot 对 Claw Code 的一次固定版本设计审计。审计基线为官方仓库提交 [`4ea31c1bc91c4e9bcbd67d51c550c01e127e6d0d`](https://github.com/ultraworkers/claw-code/tree/4ea31c1bc91c4e9bcbd67d51c550c01e127e6d0d)，后续上游变化不会自动改变本文结论。

Claw Code 的 [README（固定提交）](https://github.com/ultraworkers/claw-code/blob/4ea31c1bc91c4e9bcbd67d51c550c01e127e6d0d/README.md) 明确将项目描述为保留历史思路的 “museum exhibit”，而不是严肃的生产项目。因此，MoAgent 只借鉴可独立验证的设计思想，不引入 Claw Code 运行时，也不以其实现作为生产安全性的背书。

## 2026-07 扩展源码复核

本轮不只阅读 README，而是固定提交继续下钻运行循环、task/team、工具发现、上下文压缩、并行隔离和验收状态。用于交叉验证的源码样本如下；固定提交避免把后续上游变化误写成当前事实：

| 项目 | 固定提交 | 重点阅读 |
| --- | --- | --- |
| [Claw Code](https://github.com/ultraworkers/claw-code/tree/4ea31c1bc91c4e9bcbd67d51c550c01e127e6d0d) | `4ea31c1` | conversation loop、TaskPacket/registry、Agent/Team、GreenContract、ToolSearch、Skill、prompt cache/compaction |
| [Gajae Code](https://github.com/Yeachan-Heo/gajae-code/tree/774bc1677190804017eda6ef8eef6654e40703cd) | `774bc16` | BM25 tool discovery、task/worktree、AST edit、LSP、compaction pruning、session/read telemetry |
| [oh-my-codex](https://github.com/Yeachan-Heo/oh-my-codex/tree/fce27bfd6c17c7665a6f1505b6b8384cc2c8edd5) | `fce27bf` | consensus gate、freshness/run-state、worktree ownership |
| [clawhip](https://github.com/Yeachan-Heo/clawhip/tree/b9fc36d7b7653f9be777234a3845fc7cc6c2e073) | `b9fc36d` | routed events、状态监控、热索引与分片 memory offload |
| [oh-my-openagent](https://github.com/code-yeongyu/oh-my-openagent/tree/dec381ed201a1326883db9f42bdb3c2add91b299) | `dec381e` | LSP daemon、能力编排和生命周期实现的交叉检查 |
| [lazycodex](https://github.com/code-yeongyu/lazycodex/tree/098177c52a4fc989cc1f8ac6fb3f94e330fb63d3) | `098177c` | capability marketplace、按需上下文与工具表面的交叉检查 |

源码复核后的判断不是“复制更多 Agent”，而是把能力定义为：在限定 token、权限和时间内，产出能被独立证据验收、能在故障后安全恢复的结果。

### Claw Code 被高估的部分

- 核心仍是单模型 ReAct 循环；同轮工具调用串行执行，并没有独立 planner/executor 控制面。[conversation.rs](https://github.com/ultraworkers/claw-code/blob/4ea31c1bc91c4e9bcbd67d51c550c01e127e6d0d/rust/crates/runtime/src/conversation.rs)
- `TaskPacket` 定义了 acceptance、permission、verification 和 worktree，但正式 registry 主要做校验与内存状态记录，并未执行这些约束。[task_packet.rs](https://github.com/ultraworkers/claw-code/blob/4ea31c1bc91c4e9bcbd67d51c550c01e127e6d0d/rust/crates/runtime/src/task_packet.rs) / [task_registry.rs](https://github.com/ultraworkers/claw-code/blob/4ea31c1bc91c4e9bcbd67d51c550c01e127e6d0d/rust/crates/runtime/src/task_registry.rs)
- `TaskCreate` 主要写入 registry；`TeamCreate` 不负责可靠调度。线程式 Agent 默认权限宽，普通最终文本即可进入完成态，验收条件没有成为强制完成门。[tools/lib.rs](https://github.com/ultraworkers/claw-code/blob/4ea31c1bc91c4e9bcbd67d51c550c01e127e6d0d/rust/crates/tools/src/lib.rs)
- `GreenContract` 的结构值得参考，但没有贯通生产执行链。[green_contract.rs](https://github.com/ultraworkers/claw-code/blob/4ea31c1bc91c4e9bcbd67d51c550c01e127e6d0d/rust/crates/runtime/src/green_contract.rs)
- `ToolSearch` 返回候选名称，不等于真正延迟加载 schema；Skill 按需读取的方向是有效的，但不能据此宣称整个工具面已经 lazy。

### 其他源码真正值得吸收的部分

- Gajae Code 把工具发现做成 BM25 检索，并提供真实 task receipt/worktree、AST edit 与 LSP 接口；这比让模型反复读取整文件更能提升修改精度和 token 效率。[BM25](https://github.com/Yeachan-Heo/gajae-code/blob/774bc1677190804017eda6ef8eef6654e40703cd/packages/coding-agent/src/tools/search-tool-bm25.ts) / [task](https://github.com/Yeachan-Heo/gajae-code/tree/774bc1677190804017eda6ef8eef6654e40703cd/packages/coding-agent/src/task) / [AST edit](https://github.com/Yeachan-Heo/gajae-code/blob/774bc1677190804017eda6ef8eef6654e40703cd/packages/coding-agent/src/tools/ast-edit.ts) / [LSP](https://github.com/Yeachan-Heo/gajae-code/tree/774bc1677190804017eda6ef8eef6654e40703cd/packages/coding-agent/src/lsp)
- Gajae Code 的 compaction pruning 与 session/read telemetry 提醒我们：压缩不能只“删除旧消息”，还要保留任务语义，并用真实调用分布调优读取策略。[compaction pruning](https://github.com/Yeachan-Heo/gajae-code/blob/774bc1677190804017eda6ef8eef6654e40703cd/packages/agent/src/compaction/pruning.ts) / [session stats](https://github.com/Yeachan-Heo/gajae-code/tree/774bc1677190804017eda6ef8eef6654e40703cd/scripts/session-stats)
- oh-my-codex 的 consensus/freshness gate 表明“有人说完成”不是状态转换依据；验收证据必须属于当前 run、当前 artifact 和当前 epoch。[consensus gate](https://github.com/Yeachan-Heo/oh-my-codex/blob/fce27bfd6c17c7665a6f1505b6b8384cc2c8edd5/src/ralplan/consensus-gate.ts) / [run state](https://github.com/Yeachan-Heo/oh-my-codex/blob/fce27bfd6c17c7665a6f1505b6b8384cc2c8edd5/src/runtime/run-state.ts)
- clawhip 的小型热索引、分片明细和事件路由适合转化为受信 `ContextCapsule + EvidenceIndex`；但 QuantPilot 的事实源必须继续使用数据库与 artifact hash，不能直接采用本地 Markdown 作为权威运行状态。[memory offload](https://github.com/Yeachan-Heo/clawhip/blob/b9fc36d7b7653f9be777234a3845fc7cc6c2e073/docs/memory-offload-architecture.md)

### 这轮已经落地到 MoAgent 1.4

1. **Observation Ledger**：工作区未发生成功写入时，相同工具与规范化参数的确定性读取只执行一次；后续调用返回原观察的 ID、turn 与 SHA-256 短引用。写入立即切换 workspace generation、清空旧观察；实时行情/API 永不缓存。
2. **Prompt Prefix Ledger**：每个真实 Provider 请求前记录 system/messages/tools 哈希、最长共同消息前缀、工具面变化、压缩与临时控制后缀轮换。只持久化哈希和长度，不保存 prompt，也不缓存或重放 completion。
3. **阶段化工具 schema**：首次成功 workspace write 之前不发送 `submit_result` schema；读取收敛后移除 read schema。隐藏工具仍由运行时强制拒绝，不能靠模型自觉。

### 随后的 MoAgent 1.5 已落地

1. **Durable Mission Graph**：平台确定性编译并持久化 MissionSpec、阶段节点、candidate version 与有界 evidence receipt；`submit_result` 只结束物理运行并进入 `candidate_complete`。
2. **Independent EvidenceVerifier**：当前 run 的固定验证集合、完整 subject/evidence manifest、本机持久预览 HTTP 与验证期间文件稳定性全部通过后，才在同一事务写 accepted receipt、Mission 完成和 UserRequest 完成。验收面会完整哈希现存源码目录、final/evidence、构建配置与锁文件，并对报告和 manifest 双读防漂移。
3. **Generation slot 与验证认领**：PostgreSQL 唯一 active slot 阻止同一项目在多个 Web worker 中并发创建非终态 Mission；candidate 还必须通过 CAS 独占认领后才能开始 validation/evidence，终态释放 slot。完整的跨进程阶段 lease/fencing 仍是后续增强项。

没有照搬的机制包括：通用 ToolSearch（当前预取 profile 只有约 6～7 个工具，检索本身反而有成本）、无界 subagent、并行 writer、completion replay、thinking/raw tool 数据持久化，以及本地 JSON/Markdown 权威状态。

## 审计结论

早期固定审计从 Claw Code 吸收了请求边界、流建立前失败恢复和事件身份；扩展复核又把信息增益、缓存前缀、语义编辑、任务隔离与独立验收纳入比较。当前已实现 Observation Ledger、Prompt Prefix Ledger、阶段化工具面、Mission Graph、EvidenceVerifier 和 generation active slot；完整阶段 fencing、ContextCapsule 与 Semantic Edit 仍明确留在路线图，不能把审计建议写成现有能力。

| 主题 | 决策 | MoAgent 状态 |
| --- | --- | --- |
| Provider 请求体预检 | 采纳 | 已实现请求字节上限；超限时在发起网络请求前失败 |
| 瞬时失败重试 | 采纳并收紧 | 已实现仅在响应流开始前的有界重试，并支持有上限的 `Retry-After` |
| 事件身份 | 采纳并收紧 | 每个服务端执行实例使用 UUID `runInstanceId`，并派生 runtime `runId`；事件具有单调 `sequence` 和 run-instance 内唯一的 `eventId` |
| 公共事件投影 | MoAgent 安全收口 | `assistant_message` 与 `run_finished` 不暴露 hidden reasoning、raw cause 或完整内部 messages |
| DeepSeek 流身份 | MoAgent 安全收口 | response 与 tool-call identity 采用严格状态校验，身份缺失或流中漂移时失败关闭 |
| 产品入口上限 | MoAgent 安全收口 | instruction 与 requestId 在进入 Agent 前经过字节、长度与字符集校验 |
| 上下文治理 | MoAgent P0 | 已接入确定性 Context Manager，保持 system/latest-user/tool-cluster 原子约束；Observation Ledger 消除无信息增益的重复读取 |
| Prompt cache 诊断 | MoAgent 增强 | Prompt Prefix Ledger 区分 append-only、临时后缀轮换、压缩、system/history 前缀突变与工具面变化 |
| 阶段工具面 | MoAgent 增强 | terminal 在首次写入后才暴露，读取收敛后移除 read schema；运行时权限检查保持独立 |
| Durable ledger | MoAgent P0 | 已实现 PostgreSQL WorkspaceLease/Run/Event/Checkpoint/ToolExecution、双重 lease/fencing 与安全 projector |
| 通用 Bash 与 Shell hooks | 拒绝 | 不进入 Agent 工具面，也不能借 hook 提升权限 |
| reasoning 持久化 | 拒绝 | hidden reasoning 仍只存在于当前内存循环 |
| 宽松子 Agent | 拒绝 | 不开放无界任务、权限、上下文或并发的子 Agent |
| 本地 JSONL 权威状态 | 拒绝 | 不把进程本地文件当作产品运行状态的事实来源 |
| 多 Provider 扩张 | 当前拒绝 | 保持 DeepSeek-only 的窄适配面，避免无业务收益的配置与兼容性膨胀 |

## 本轮已采纳

### 请求字节预检

Provider 在调用 DeepSeek API 前序列化请求并检查 UTF-8 字节数。超过 `MOAGENT_MAX_REQUEST_BYTES` 时直接返回结构化错误，不把超大上下文交给网络层处理。

这道硬上限与 Context Manager 相互独立：前者阻止异常大请求接触网络，后者在每轮 Provider 调用前按内部预算选择、摘要或淘汰旧上下文。

产品 HTTP 入口还会在 Agent 执行前限制 instruction：原始指令与可选展示指令均不得超过 256 KiB UTF-8。requestId 最多 128 个字符，首字符必须是字母或数字，其余字符只能是字母、数字或 `._:-`。入口上限与 Provider 请求体预检分别保护外部输入和最终模型载荷，不能互相替代。

### 仅流前有界重试

MoAgent 仅对网络错误和明确的瞬时 HTTP 状态执行有界重试。退避时间支持服务端 `Retry-After`，并受本地最大等待时间约束。默认最多重试两次。

一旦成功响应流开始，MoAgent 不重放请求。这样可避免在部分输出或工具调用已经产生后，因盲目重试造成重复副作用。SSE 协议错误、输出超限和流中断仍按原有失败路径处理。

### 执行实例与公共事件身份

QuantPilot 产品接入层为每次执行生成新的服务端 UUID `runInstanceId`，再派生带 `moagent_` 前缀的 runtime `runId`；客户端 requestId 不充当运行身份。Run Engine 为该执行实例中的事件分配从 1 开始的单调 `sequence`，并生成包含 `runId` 与序号的 `eventId`。因此 `eventId` 只承诺在同一个 run instance 内唯一，可用于该实例内的日志关联、前端去重和顺序检查。

公共 `assistant_message` 是 assistant 消息的安全投影，不包含 hidden reasoning。公共 `run_finished` 只包含终态、轮次、usage、时间和经过筛选的错误 code/message，不暴露 raw cause 或完整内部 messages；完整内存结果仍只供当前受信运行循环使用。

事件现在会经过显式安全 projector 写入 PostgreSQL durable store，允许稀疏但严格递增的源序号，并对相同 event identity 做内容一致性去重。当前仍未提供面向 SSE/WebSocket 客户端的历史补发接口；持久 event ledger 也不等于原会话精确续跑。

### 严格 Provider 流身份状态机

DeepSeek 的语义流分片必须携带有效 response ID，同一条流中的 response ID 不得变化。工具调用按 index 聚合：首个分片必须给出非空 tool-call ID，此后该 index 的 ID 不得漂移；组装完成后，Run Engine 还会拒绝重复 tool-call ID。choice index、finish reason 和流终止顺序也接受严格检查。

身份缺失、身份漂移、重复 ID 或不完整终止都会作为协议错误失败关闭，并且不会因为流已建立而重放请求。这避免把两条响应或两个工具调用的分片错误拼接成一个可执行动作。

## 保留的 MoAgent 优势

- 工具默认拒绝，不提供通用 Shell；读写文件、量化 API 和结果提交均经过类型、路径、权限、超时与输出上限约束。
- DeepSeek wire format 被限制在 Provider Adapter 内，不泄漏到 Run Engine 和工具层。
- hidden reasoning 不写数据库、不进入前端事件，也不作为可恢复状态保存。
- 公共生命周期事件使用显式安全投影，不把完整内部消息、Provider raw cause 或 system/tool 上下文意外扩散给事件消费者。
- 服务端为每次执行生成新的 UUID `runInstanceId`，并派生 runtime `runId`；客户端 requestId 只承担产品请求关联与取消作用，不控制运行身份。
- 工作空间边界同时检查相对路径、真实路径和 symlink；平台内部目录保持只读。
- Agent 的 `submit_result` 只结束执行阶段，最终成功仍由 QuantPilot 的 build、HTTP、视觉、数据与 evidence 验证决定。
- 运行具有轮数、Token、工具调用、总时长、单项输出等预算，并支持取消。
- 工具调用 ID 在执行前做一致性与重复校验；terminal 工具必须独占模型轮次，不会完成后再静默忽略同批调用。

## 明确不采纳

### 通用 Bash 与可提升权限的 Shell hooks

MoAgent 不新增 Bash 工具，也不允许 middleware/hook 把一个被拒绝或只读的动作提升为可写、可执行动作。生成项目的 build/preview 继续由 Agent 之外的平台沙箱负责，不成为模型可任意调用的能力。

### 持久化 reasoning

reasoning 可能包含敏感上下文，也不是产品审计所需的稳定事实。MoAgent 只持久化用户可见消息、结果和必要的工具审计信息，不保存 hidden reasoning。

### 宽松子 Agent

不引入可自由创建、继承全部权限、无限扩散上下文或不受预算约束的子 Agent。未来即使增加并行 lane，也必须是只读、有限并发、有限预算和显式输出契约。

### 本地 JSONL 作为权威状态

本地 JSONL 可以作为开发诊断格式，但不能承担 QuantPilot 的 durable run、checkpoint 或幂等事实源。产品状态应绑定数据库事务、项目身份和服务端访问控制。

### 多 Provider 表面积膨胀

Provider-neutral 核心用于隔离协议，不等于必须同时支持多家模型供应商。当前业务只使用 DeepSeek；在没有明确迁移或容灾需求前，不增加多 Provider 配置矩阵、兼容分支和测试负担。

## 差距路线图

以下条目明确标注当前状态；“代码路径已实现”不等于生产迁移或完整端到端恢复已经验收。

### P0：Mission Graph 已落地；完整流水线世代继续收口

MoAgent 1.5 已具备以下 durable、可验收控制面：

```text
MissionSpec
  -> MissionCompiler
  -> Durable Mission Graph
  -> Node Executor / Effect Scheduler
  -> Evidence Verifier
  -> passed | repair | failed
```

每个 node 固定 dependencies、允许工具、Skill sections、effect、artifact refs、预算和 completion evidence。`submit_result` 只能进入 `candidate_complete`；只有当前 generation 的 validator receipt、artifact hash、数据绑定、build 与 preview readiness 全部通过，`EvidenceVerifier` 才能写 `completed`。平台验证已经由 Agent 之后的松散步骤提升为任务状态机中的强制验收门。

PostgreSQL active slot 已阻止同项目的并发非终态 Mission，并以 generationId 绑定 planning、prefetch、candidate、validation、preview 与 acceptance；candidate 的 CAS 验证认领和手工验证状态门也阻断了重复验收入口。尚未完成的是贯穿所有平台 writer 的 monotonic fencing token、可接管阶段 lease 与崩溃后的 dispatcher；外层 generation queue 仍有文件投影和分段锁区间，这是剩余的生产 P0 缺口。

### P0：可靠上下文与可恢复执行

1. **Context Manager（已实现）**：按输入预算压缩；assistant tool-call、reasoning 与对应 tool results 原子配对；保留全部 system、最新 user 和最近工具簇；输出结构化压缩元数据。
2. **Durable run / checkpoint（代码路径已实现）**：数据库保存安全投影后的运行状态、稀疏事件、replan checkpoint、预算和终态；不保存 hidden reasoning。版本化 migration 与 catalog readiness 已实现；自动 recovery dispatcher 尚未实现。
3. **工具执行门与双层提交锁（代码路径已实现）**：框架派生 operation ID，副作用前 `prepared`，只有首次创建 ledger 才授权执行；重复 operation 与 `prepared`/`commit_authorized`/`uncertain` 均不自动重放。文件写入从临时文件创建前开始持有共享文件系统资源锁；数据库短事务验证 workspace/run/operation fence 并消费一次性 `commit_authorized`，事务结束后资源锁继续覆盖目标 before-hash 复验和 rename。mutating failure 进入 `uncertain` 后立即终止当前 run，repository 同时禁止该 project 再 prepare 写操作。崩溃仍可能留下未确认 operation 或孤儿资源锁，因此继续阻断调和且不承诺 exactly-once。
4. **Project/workspace 独占 lease（代码路径已实现）**：deployment namespace + canonical realpath 形成不泄露路径的 workspace key；在资源锁内获取 lease 与创建 run，heartbeat/terminal release 同步更新 run/workspace 双层 fence，所有租约判断使用 PostgreSQL 权威时钟，过期 token 不能继续写数据库或消费提交授权。文件锁的自动化验收目前只覆盖本机进程，目标共享卷仍需多进程/多主机验收；外层 platform writer 也尚未纳入同一 durable generation coordinator。
5. **Event journal 与游标查询（代码路径已实现；客户端 replay 未实现）**：安全投影后的 durable 事件支持 repository 游标读取和重复事件去重；内部工具事件仍含 raw arguments/result，只能给受信进程内消费者。SSE/WebSocket 断线按游标补发尚未接入，因此当前不能称为端到端 event replay。

### P1：可信扩展面

1. **Trusted ContextCapsule + EvidenceIndex**：从任务合同、工具 receipt、artifact hash 和验证结果生成有上限、可重复合并的目标/决策/产物/失败/剩余工作索引；不让模型总结不可信原始工具输出，也不把 capsule 当数据库权威状态。
2. **Lazy Skill sections 与 node-scoped schema**：system 只保留 capability manifest，Mission node 按 section/hash/budget 加载正文；工具 schema 由 node 直接裁剪，而不是每轮把完整 registry 交给模型。
3. **Semantic Edit**：为 TypeScript/TSX/CSS 提供受路径策略和写栅栏保护的 AST/LSP 定位、编辑与诊断，减少整文件读取和脆弱文本替换。它必须复用现有 operation ledger，不能绕过 typed writer。
4. **ModelProfile + BudgetReservation**：先只定义 DeepSeek profile，记录 context/output、reasoning replay、tool protocol、cache usage 与 estimator calibration；每次请求前预留最坏 input/cache-miss 预算，响应后再按实报调账。
5. **Trusted typed middleware**：只允许经过注册的进程内 middleware 读取结构化上下文，并执行 deny、redact、annotate 或收紧预算；不能拼接 Shell、任意改写工具参数或扩大权限。

### P2：有限并行与证据化报告

1. **Bounded read-only lanes**：仅为 Inspector、Researcher、Verifier 等检索、代码阅读或验证任务开放只读 lane，限制并发数、深度、工具集合、Token 和总时长，禁止隐式继承写权限。唯一 Writer 持有 workspace lease；未来并行写入必须使用独立 overlay/worktree，再由 coordinator 合并并统一验证。
2. **Evidence report**：把运行输入版本、工具调用摘要、产物哈希、验证结果、失败原因和关键事件游标汇总为结构化报告；报告引用事实与证据，不暴露 hidden reasoning。

## 验收边界

本轮增强的验收覆盖：超限 instruction/requestId 在入口被拒绝；跨项目 requestId 在消息/状态/取消前被拒绝；超大 Provider 请求不会触发 `fetch`；瞬时错误仅在流前重试；Context Manager 保持工具簇原子并在受保护上下文超限时失败关闭；同参数 workspace 读取在未写入时只执行一次，参数键序变化不绕过指纹，成功写入后重新真实读取，实时 API 不复用；Prefix Ledger 区分 append-only、临时控制后缀轮换和 tool-set change，安全 projector 只保存哈希/长度；`submit_result` schema 在首次成功写入后才出现；每次物理执行生成新 UUID `runInstanceId`；事件 identity 单调且可去重；response/tool-call identity 漂移被拒绝；持久事件/checkpoint/receipt 不包含 hidden reasoning、raw arguments/result/cause；durable sink 在工具前失败时副作用为零；取消中的写操作先记录 uncertain 再终态；mutating outcome 不明时当前 run 立即停止且不能再 prepare 写；重复 operation 不执行；两个 Prisma client 的同项目/同 canonical workspace 数据库竞争互斥；worker 时钟漂移不改变数据库租约判断；本机资源锁串行化物理提交与 takeover，孤儿锁失败关闭；UI observer 失败不影响运行；`prepared`/`commit_authorized`/`uncertain` 写操作不会盲目重放。独立 PostgreSQL 契约套件目前包含 10 个并发/故障用例，并已接入 CI；目标共享卷验收、平台级跨实例 generation coordinator 和生产版本化迁移仍是发布前置条件。

路线图项目只有在具备独立实现、故障测试、持久化迁移和产品接入后，才能从“规划”移动到“已实现”。
