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

### MoAgent 1.6：System Prompt × Skills 收口已落地

1. **四层提示合同**：稳定 Kernel、动态 Task Packet、按阶段投影的 Skill Capsules、最后注入且明确标为 untrusted data 的 initial dashboard contract。跨层重复的权限、完成语义和工具清单已经移除。
2. **原子 runtime capsule**：不再按字符均分并截断完整 `SKILL.md`。编译器按 phase、附件、标的解析状态、template/variant 和实际 typed-tool 面选择能力；required capsule 超预算直接失败。
3. **精确 reference 注入**：场景模板与视觉判读按 Markdown section 选择并做 hash provenance，模型不再自行查找相对路径。生产默认预算从 16000/6000 字符收敛到 6000/4000 字符。
4. **语义阶段与自适应推理**：空/stale 数据制品不会关闭取数工具；图片进入附件证据阶段；UI 生成默认 medium reasoning，数据与 repair 使用 high。

### MoAgent 1.7：可信压缩、语义编辑与证据门已落地

1. **Trusted ContextCapsule**：框架为每个内建工具注册浅层 canonical receipt projector，只接受固定 target/hash/bytes；additional tool 的 projector 被剥离。没有 projector 的执行只生成框架自有 outcome tombstone，不信任 raw payload 或其 target 声明；最近精确 tombstone 有固定上限，更旧操作进入 hash-chain rollup，因此副作用历史可被覆盖又不会形成上下文 DoS。历史工具簇只有在完整覆盖后才原子替换，写入会立即使旧 read receipt 失效。
2. **Semantic Edit**：TS/TSX 顶层声明由 AST 定位，CSS rule 由 PostCSS 定位，所有编辑都带 before SHA-256 并复用 durable writer。声明种类、export/default/async/generator、var/let/const 身份和完整文件语法在写前校验；运行时 parser 已进入 production dependencies。
3. **DashboardSpec 与最小工具面**：普通 prepared 生成先完成 renderer/data identity/precondition 预检，Provider 只见 compiler + submit 两个工具；明确视觉/布局定制走 4-tool query + semantic surface。compiler 对排名顺序、回测策略/交易明细、趋势/量能/风险和数据 run identity 失败关闭，已知必败任务不会先产生 tool failed。
4. **可证明 E2E**：AgentRun 持久化 `moagent:1.7.0` 与 dirty-content-aware build revision；schema v4 发布门只接受真实 `/act -> Mission -> EvidenceVerifier -> accepted receipt` 报告，逐 run 校验 source lineage、终态、工具与 Token/cache 算术。accepted source 必须来自 `moagent_submit_result` 并证明 workspace write 与 `submit_result` 成功，平台兜底候选单独计为产品恢复，不能冒充 MoAgent 能力成绩。

没有照搬的机制包括：通用 ToolSearch（当前预取 profile 只有约 6～7 个工具，检索本身反而有成本）、无界 subagent、并行 writer、completion replay、thinking/raw tool 数据持久化，以及本地 JSON/Markdown 权威状态。

## 审计结论

早期固定审计从 Claw Code 吸收了请求边界、流建立前失败恢复和事件身份；扩展复核又把信息增益、缓存前缀、语义编辑、任务隔离与独立验收纳入比较。当前已实现 Observation Ledger、Prompt Prefix Ledger、Trusted ContextCapsule、最小 prepared 工具面、Semantic Edit、DashboardSpec、原子 Skill Capsules、Mission Graph、EvidenceVerifier、generation active slot、typed writer durable pre-image journal 与真实 E2E 证据门。仍未完成的是贯穿全部平台 writer 的阶段 fencing/dispatcher、客户端事件补发和受限只读并行；typed workspace writer 可自动回滚，但 external/uncertain 操作仍必须阻断调和。

| 主题 | 决策 | MoAgent 状态 |
| --- | --- | --- |
| Provider 请求体预检 | 采纳 | 已实现请求字节上限；超限时在发起网络请求前失败 |
| 瞬时失败重试 | 采纳并收紧 | 已实现仅在响应流开始前的有界重试，并支持有上限的 `Retry-After` |
| 事件身份 | 采纳并收紧 | 每个服务端执行实例使用 UUID `runInstanceId`，并派生 runtime `runId`；事件具有单调 `sequence` 和 run-instance 内唯一的 `eventId` |
| 公共事件投影 | MoAgent 安全收口 | `assistant_message` 与 `run_finished` 不暴露 hidden reasoning、raw cause 或完整内部 messages |
| DeepSeek 流身份 | MoAgent 安全收口 | response 与 tool-call identity 采用严格状态校验，身份缺失或流中漂移时失败关闭 |
| 产品入口上限 | MoAgent 安全收口 | instruction 与 requestId 在进入 Agent 前经过字节、长度与字符集校验 |
| 上下文治理 | MoAgent P0 | Context Manager 保持 system/latest-user/active tool-cluster 原子约束；Trusted ContextCapsule 用框架 receipt 安全替换已完整覆盖的历史簇，Observation Ledger 消除重复读取 |
| Prompt cache 诊断 | MoAgent 增强 | Prompt Prefix Ledger 区分 append-only、临时后缀轮换、压缩、system/history 前缀突变与工具面变化 |
| 阶段工具面 | MoAgent 增强 | prepared standard/custom 由平台分流到 2/4 个最小工具；standard 预检后只运行 compiler + submit，custom 才开放定向 query + semantic edit |
| 语义修改 | MoAgent 增强 | AST/CSS 定位、SHA-256 乐观并发、声明身份和完整语法校验复用 durable mutation fence |
| 发布证据 | MoAgent 增强 | framework/build/git、真实 accepted receipt、case completeness 与 Token/cache 算术进入 E2E release gate |
| Durable ledger | MoAgent P0 | 已实现 PostgreSQL WorkspaceLease/Run/Event/Checkpoint/ToolExecution、双重 lease/fencing、fsynced pre-image journal 与过期 operation 启动回滚 |
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
2. **Durable run / checkpoint（代码路径已实现）**：数据库保存安全投影后的运行状态、稀疏事件、replan checkpoint、预算和终态；不保存 hidden reasoning。版本化 migration 与 catalog readiness 已实现；启动审计会关闭无副作用旧 run，并调和具有可靠 journal 的 workspace write，但不会自动续跑 Provider 会话。
3. **工具执行门、提交锁与 pre-image journal（代码路径已实现）**：框架派生 operation ID，副作用前 `prepared`，只有首次创建 ledger 才授权执行；重复 operation 不重放。typed writer 在共享资源锁内先持久化 staged 内容、pre-image、hash 和 manifest，消费一次性 `commit_authorized` 后把状态 fsync 为 committing，再逐目标 rename/fsync。进程内失败与重启审计共用全量 hash 预检回滚；prepared/commit-authorized 可确定性终结，部分 rename 不再永久污染工作区。用户后续修改、无 journal 的 authorized、external write 与 uncertain 仍失败关闭。
4. **Project/workspace 独占 lease（代码路径已实现）**：deployment namespace + canonical realpath 形成不泄露路径的 workspace key；在资源锁内获取 lease 与创建 run，heartbeat/terminal release 同步更新 run/workspace 双层 fence，所有租约判断使用 PostgreSQL 权威时钟，过期 token 不能继续写数据库或消费提交授权。文件锁的自动化验收目前只覆盖本机进程，目标共享卷仍需多进程/多主机验收；外层 platform writer 也尚未纳入同一 durable generation coordinator。
5. **Event journal 与游标查询（代码路径已实现；客户端 replay 未实现）**：安全投影后的 durable 事件支持 repository 游标读取和重复事件去重；内部工具事件仍含 raw arguments/result，只能给受信进程内消费者。SSE/WebSocket 断线按游标补发尚未接入，因此当前不能称为端到端 event replay。

### P1：继续收口的可信扩展面

Trusted ContextCapsule 与 Semantic Edit 已在 1.7 移出路线图。剩余工作是：

1. **Node-scoped schema 继续收口（Skill 与 prepared surface 已实现一部分）**：system 已只保留 Skill manifest，运行时按 phase/signal/hash/budget 注入原子 capsule；prepared generation 已按 standard/custom 缩面。下一步让每个 Mission node 直接决定更细粒度的 schema 与数据 prerequisite，而不是依赖运行阶段和关键词分流。
2. **ModelProfile + BudgetReservation**：DeepSeek usage 已在 provider 边界校验 total/cache/reasoning 算术，缺报按 prepared input 保守计费。下一步是把 estimator calibration 与“请求前预留、响应后调账”物化为独立持久预算对象，而不仅是累计硬门。
3. **Trusted typed middleware**：只允许经过注册的进程内 middleware 读取结构化上下文，并执行 deny、redact、annotate 或收紧预算；不能拼接 Shell、任意改写工具参数或扩大权限。

### P2：有限并行与证据化报告

1. **Bounded read-only lanes**：仅为 Inspector、Researcher、Verifier 等检索、代码阅读或验证任务开放只读 lane，限制并发数、深度、工具集合、Token 和总时长，禁止隐式继承写权限。唯一 Writer 持有 workspace lease；未来并行写入必须使用独立 overlay/worktree，再由 coordinator 合并并统一验证。
2. **Evidence report**：把运行输入版本、工具调用摘要、产物哈希、验证结果、失败原因和关键事件游标汇总为结构化报告；报告引用事实与证据，不暴露 hidden reasoning。

## 验收边界

本轮增强的验收覆盖：超限 instruction/requestId 与 Provider 请求在网络前被拒绝；DeepSeek identity/usage 算术漂移失败关闭，缺失 usage 保守计入 input/cache miss；Context Manager 保持工具簇原子，内建 projector 生成详细 canonical receipt，第三方执行只留下框架 outcome tombstone，旧 tombstone 有界汇总为 hash-chain rollup；同参数 workspace 读取在未写入时只执行一次；standard/custom 工具面为 2/4；DashboardSpec 对数据 identity、排名、交易明细、趋势/量能/风险失败关闭；持久事件/checkpoint/receipt 不包含 hidden reasoning 或 raw tool payload；durable sink 在工具前失败时副作用为零；多文件写入中途故障、进程重启、部分 rename、目录 fsync、用户修改冲突与 terminal old run 均有 journal 回归；本机死亡锁接管具备排他 claim、owner inode 复验和替换锁竞态回归；两个 Prisma client 的数据库竞争、权威时钟和 takeover 仍有独立 PostgreSQL 契约。目标共享卷验收、平台级跨实例 generation coordinator 和生产迁移演练仍是发布前置条件。

路线图项目只有在具备独立实现、故障测试、持久化迁移和产品接入后，才能从“规划”移动到“已实现”。
