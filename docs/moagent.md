# MoAgent 架构

MoAgent 是 QuantPilot 自研的 Agent 框架。它以进程内 TypeScript 模块运行，直接调用 DeepSeek 官方 OpenAI-compatible API，不依赖外部 Agent SDK、CLI 子进程或供应商 session。

## 设计目标

- Provider 与运行循环解耦：模型协议只存在于 Provider Adapter。
- 工具默认拒绝：没有通用 Shell，所有能力均为带 Schema、超时和输出上限的类型化工具。
- 工作空间隔离：相对路径、realpath 与 symlink 三重校验，`.quantpilot` 永久只读。
- 可终止、可观测：每个物理执行使用新的服务端 UUID `runInstanceId`，并派生带 `moagent_` 前缀的 runtime `runId`；运行具有结构化公共事件、累计 usage、轮数/Token/总时长预算和 AbortSignal。
- 可审计、可阻断：PostgreSQL 保存 AgentRun、project/workspace 独占 lease、安全事件、replan checkpoint、工具 operation ledger、MissionSpec 物化节点与不可变 evidence receipt；数据库权威时钟、run/workspace 双重 lease、heartbeat、CAS version 和 fencing token 拒绝陈旧 worker，文件系统资源锁与一次性提交授权共同保护物理写入，未决副作用会阻断新 attempt。
- 显式完成：至少一次 workspace write 成功后才允许 `submit_result`；它只把物理 AgentRun 和 `workspace_generation` 节点推进到 `candidate_complete`。只有当前 candidate version 通过独立 EvidenceVerifier 并写入 accepted receipt，产品 Mission 才能进入 `completed`。
- 信息增益驱动：工作区版本未变化时，相同参数的可缓存读取只保留第一次真实观察；重复读取返回带原始结果摘要哈希的短引用并立即推动阶段收敛。实时行情/API 读取永不进入该缓存。
- Cache 可诊断：每轮 Provider 请求前持久化 Prompt Prefix Ledger 的哈希、长度、最长共同消息前缀、工具面变化和压缩原因，不保存 prompt 原文。
- 推理隐私：DeepSeek thinking 内容仅在当前 tool-call 循环内部回放，不写数据库、不推送前端；公共 assistant/终态事件也不包含 hidden reasoning、raw cause 或完整内部 messages。

## 分层

| 层 | 路径 | 责任 |
| --- | --- | --- |
| 协议 | `src/lib/agent/types.ts` | Provider-neutral message、event、tool、usage 和 result 类型 |
| Provider | `src/lib/agent/providers/deepseek.ts` | `/chat/completions`、SSE、严格 response/tool-call identity 状态校验、usage 和错误映射 |
| Run Engine | `src/lib/agent/core/run-engine.ts` | 多轮模型/工具循环、Observation Ledger、Prompt Prefix Ledger、阶段化工具面、预算、取消、工具调用身份校验与独占 terminal result |
| Context Manager | `src/lib/agent/context/` | 输入预算、工具簇原子性、旧结果确定性摘要和超限失败关闭 |
| Durable Runtime | `src/lib/agent/runtime/` | WorkspaceLease/Run/Event/Checkpoint/ToolExecution 契约、安全投影、双重 lease/fencing 与 Prisma repository |
| Mission Graph | `src/lib/agent/mission/`、`src/lib/services/moagent-mission-*.ts` | 编译受信 MissionSpec、物化阶段节点、冻结 candidate version、验证证据并通过 CAS 事务提交产品完成态 |
| Tools | `src/lib/agent/tools/` | 文件、量化 API、图片元数据和提交工具及安全策略 |
| Skills | `src/lib/agent/skills/`、`config/moagent-skill-capsules.json` | registry/version/SHA-256 完整性校验；按 phase、附件、标的解析、模板和当前 typed tools 投影原子 runtime capsule，并精确注入所需 reference 片段；项目初始化只配置 workspace 参考镜像 |
| 产品接入 | `src/lib/services/cli/moagent.ts` | 历史上下文、消息持久化、实时事件、用户取消和执行阶段终态 |
| 外层编排 | `src/app/api/chat/[project_id]/act/route.ts` | 意图规划、数据预取、队列、验证、自动修复和预览 |

## 一次运行

1. 外层编排生成只读 run plan，并优先预取真实量化数据和 evidence。
2. 产品入口限制 instruction 为 256 KiB UTF-8、requestId 为最多 128 个白名单字符；接入层校验 project/workspace 绑定，为本次执行生成 UUID `runInstanceId`，并派生带 `moagent_` 前缀的 runtime `runId`，随后加载有限条历史聊天消息。
3. 项目初始化阶段把通过 registry、版本与 SHA-256 完整性校验的 capability 完整 Skill 集合配置到 `.moagent/skills` 参考镜像，安装集合不受单次执行 phase 裁剪。执行时，仓库 `.claude/skills` 或受校验 tgz 只提供可追溯的源材料；`config/moagent-skill-capsules.json` 按 phase、附件、标的解析状态、模板和当前 typed tools 选择可执行增量。编译结果分成稳定 system manifest 与动态 task capsule，reference 只注入命中的完整 Markdown section，不把整份 `SKILL.md` 交给模型，也不截断关键步骤。
4. 产品层在首次 Provider 请求前先取得共享文件系统资源锁，再审计旧 attempt，并以数据库事务原子取得 project/canonical-workspace 独占 lease、创建 AgentRun，记录 prompt/tool/skill/workspace 的 SHA-256 provenance；PostgreSQL 权威时钟计算租约，workspace token 与 per-run token 共同组成数据库写栅栏。启动临界区完成后释放资源锁，后续每次物理写入单独重新取得它。
5. 平台先对 run plan、final data、sources 和 data quality 做语义就绪判定；空 `{}`、标的覆盖不足、模板不一致或证据 run identity 漂移都会留在 data-preparation，并保留量化 API 与 failure-scoped final/evidence 写权限。真正的预取模式才生成一次只读 `initial_dashboard_contract`，把计划、数据/证据摘要、页面合同和源码 outline 随首轮任务注入；该模式只投影数据质量与可视化 capsule，并移除泛目录读取、原始 JSON 读取、行情 API 和无附件图片工具。带图片任务先进入附件证据阶段。每轮请求前，Context Manager 再按内部输入预算压缩历史：保留 system、最新 user 和最近工具簇；普通旧 reasoning 优先删除，旧工具输出只做确定性摘要，工具调用簇只能整体保留或整体淘汰。产品历史只继承真实用户消息与标记为 final 的助手结论，自动验证、repair 流水线和 Agent 工具旁白不会进入下一次 run。
6. Run Engine 请求 DeepSeek；Provider 对 response ID、choice、tool-call identity 和终止顺序执行严格状态校验，文本、reasoning、tool-call 和 usage 进入受信运行循环。
7. reasoning 只保留在内存；durable projector 跳过高频 delta，assistant/tool 原文只保存长度与 SHA-256 审计信息，拒绝 hidden reasoning、raw cause、完整 messages 和凭据字段。
8. 每个工具动作使用框架派生的 `operationId`。`tool_started` 在副作用前写 `prepared` ledger，只有新建 ledger 才授权执行；重复 operation 会失败关闭。文件写工具先取得 `<workspace>/.moagent-workspace.lock`，再校验目标、生成并 fsync 临时文件；数据库在短事务内锁定 workspace/run/operation，验证当前 fence 后把 operation 原子推进到一次性的 `commit_authorized`。事务结束后，文件工具仍持有资源锁，重新校验目标 before hash 并完成最终 rename，再记录成功/失败/uncertain、result receipt 与可用的 before/after hash。UI/Message observer 失败不会反向中断已完成的工具动作。
9. 工具结果以标准 envelope 回灌模型；terminal 工具必须独占其模型轮次。执行前只做不发明字段的有界参数修复：去掉完整 JSON code fence、转义字符串内非法控制字符、移除尾逗号，并把唯一匹配的已注册工具名、常见字段别名和 `/app/**` 等虚拟工作区路径归一化；不完整 JSON、未知工具和非工作区绝对路径仍失败关闭。同一模型轮次内，同文件 `query_json`/`query_text_file` 会合并 pointer/anchor，完全相同的只读调用会删除，合并后才计入实际工具预算。文件/结构化读取声明 `workspace_generation` observation policy：相同工具与规范化 JSON 参数在工作区没有成功写入时只执行一次；重复调用返回原始 tool-call ID、turn 和结果 SHA-256 的短引用，并从下一轮移除 read 工具。任何成功 workspace write 都立即使全部旧 observation 失效。实时 `quant_api_get` 不缓存。QuantPilot 产品配置下连续 3 个预写只读轮次或写后连续 2 个只读轮次也会触发硬阶段切换。`submit_result` schema 在首次成功写入前不发送给模型；读预算耗尽后 read schema 同样移除，运行时仍会拒绝模型臆造的隐藏调用。收敛指令作为当次 Provider 请求尾部的临时 user 控制消息注入，不改写稳定 system 前缀、不污染持久历史。循环持续到提交、预算耗尽、超时、取消或失败。
10. 每轮实际请求 Provider 前生成 Prompt Prefix Ledger：只记录 system/messages/tools SHA-256、请求字节数、最长共同消息前缀、是否 append-only、是否发生 ContextManager 压缩、临时控制后缀轮换和工具集合变化。该事件与同 turn 的 DeepSeek cache hit/miss usage 一起进入 durable event ledger，用于定位非预期 cache break；不保存提示词、工具结果或 hidden reasoning，也不缓存/重放 completion。
11. `submit_result` 只提交候选产物，物理 AgentRun 以 `candidate_complete` 结束；平台为 Mission 当前 candidate version 写入 candidate receipt，并用数据库 CAS 独占认领该 candidate 的验证权，随后执行 build、HTTP、视觉、数据与 evidence 验证。第二个 Web worker 不能把同一可变工作区并发认领为自己的验证输入；失败项会把 Mission 推进到 `repair_required`，再由 repair profile 产生下一 candidate version。
12. EvidenceVerifier 在同一 workspace 资源锁内双读平台验证报告、冻结 subject/evidence manifest 并探测持久预览。manifest 除必需产物外，还逐文件覆盖现存的 `components/**`、`lib/**`、`src/**`、`scripts/**`、`public/**`、`data_file/final/**`、`evidence/**` 和构建配置/锁文件；单文件、总字节、文件数、realpath 与 symlink 都有硬限制。只有 Mission/spec/request/candidate identity、必需检查、报告与 manifest 前后稳定、本地 HTTP 200 全部匹配时，Mission store 才以 CAS 事务写 accepted receipt、关联 `accepted_receipt_id`，并与 UserRequest 完成态原子提交。Agent 文本、`submit_result` 或单独的 validation `passed` 都没有该权限。

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

- `agent_missions` 保存不可变 spec/spec hash、当前 candidate version、CAS version、产品状态和最终 accepted receipt 引用；`(project_id, active_slot)` 唯一约束保证每个项目最多一个非终态 Mission，终态以 NULL 释放 slot。
- `agent_mission_nodes` 保存 MissionSpec 的物化节点及各节点状态；节点预算和能力范围是数据合同，不从模型输出反推。
- `agent_evidence_receipts` 保存候选、验证与验收的有界投影，以 receipt hash、subject hash、candidate version 和唯一约束提供幂等/陈旧证据防护。

Candidate receipt 与 accepted receipt 不是原始执行日志。数据库不得保存 prompt、hidden reasoning、HTML、截图、完整 build 日志或 unrestricted tool output；receipt 只包含经过边界校验的身份、哈希、检查状态、原因码和预览就绪摘要。一次修复会生成新的 candidate version，旧 version 的验证结果不能完成新 version。`completed`、`failed`、`cancelled` 是 Mission 终态；`candidate_complete`、`verifying`、`repair_required` 和 `repairing` 均保持原始 UserRequest 活跃。

手工 `/quant/validation` 也服从同一完成门：运行中、修复中或验收中的 Mission 返回 busy；已完成 Mission 只返回既有 acceptance snapshot，不重写权威报告；只有可恢复的 `candidate_complete` / `repair_required` 能在项目生成锁内封存恢复候选。显式 requestId 必须已经存在、属于当前项目且与当前 generation 一致，验证接口不能伪造新的 generation 身份。前端只依据 Mission-aware generation status 决定是否恢复预览，`validation passed` 或数据库中的裸 `Project.previewUrl` 都不能旁路 accepted receipt。

## 中断与恢复语义

MoAgent 当前实现的是 **replan recovery 基础**，不是原会话 resume。DeepSeek thinking tool turn 所需的私有 reasoning 不写数据库，因此进程重启后不能完整重放旧协议历史。Checkpoint 固定声明 `recoveryMode=replan_required`，只包含阶段、turn、源事件序号和已终结 operation ID。

新 attempt 启动前会审计 lease 已过期的旧 run 及其 `prepared`、`commit_authorized`、`uncertain` ledger。没有未决写操作的旧 attempt 会先取得 reconciliation lease，再标为 `interrupted`；存在未决 workspace/external write 时只会阻断新执行并保留现场。当前 run 一旦产生无法证明结果的 mutating failure，会持久化 `uncertain` 并立即失败关闭，在同一 run 内也禁止 prepare 下一次写操作。当前版本不会自动读取工作空间完成调和，也不会把未决写直接标失败后盲目重试。

旧 attempt 安全关闭后，只有用户重试或后续 dispatcher 发起恢复时，才会创建新的物理 run，并从原始 UserRequest、当前工作空间和验证结果重新规划；不得把旧 Provider 会话当作可精确续跑状态。当前版本不会自行排队启动这个新 run。

当前代码路径已提供检测、审计、阻断和后续显式调和所需的数据基础，并实现数据库层的 project/canonical-workspace 独占 lease。MoAgent typed writer 与 takeover 遵守同一锁顺序：共享文件系统资源锁在外，数据库 workspace/run/operation 锁在内；数据库只提交一次性授权，不把事务悬挂在文件 I/O 上。若进程在授权或 rename 周边崩溃，operation 会保持 `prepared`、`commit_authorized` 或 `uncertain` 并阻断新 attempt。资源锁 `owner.json` 记录 instance/host/pid/purpose/project/request/run/operation 中适用的定位信息，锁目录不会按时间自动强拆；运维必须按排障 runbook 确认 writer 已退出、核对 ledger 与目标文件后才能移除孤儿锁。

这不是对任意共享存储的无条件跨主机保证。生产挂载必须让所有实例看到同一 canonical root，并支持跨客户端原子 `mkdir`、同文件系统原子 `rename` 和所需 fsync 语义；当前自动化只在单 Node 进程、两个 Prisma client 与本机文件系统上验证，目标 NFS/CSI/分布式卷必须另做多进程、多主机故障验收。数据库 active Mission slot 已阻止合规入口为同一 project 并发创建两条完整 generation；但外层 data prefetch、scaffold、build、preview 和 validation writer 尚未统一持有可接管的阶段 lease/fencing token，进程崩溃后会失败关闭而不是自动 takeover。真正的 reconciliation worker、数据库驱动 dispatcher 和平台级阶段 fencing 仍属于下一阶段；不对外承诺进程崩溃后自动续跑或 exactly-once 文件写入。

## 内置工具与权限

| 工具 | 权限 |
| --- | --- |
| `list_files`、`read_file`、`read_file_range`、`search_files` | 非预取流程的通用只读工具；拒绝越界与逃逸 symlink。预取 generation 不注册这些工具 |
| `inspect_dashboard_contract` | 固定检查 run plan、final/evidence、页面/样式/代理；在 6000 字符运行预算内优先保留组件/渲染行范围、根布局、CSS layout selector、卡片式 surface 整改目标，以及可直接传给 `query_text_file` 的分文件批量字面锚点，用于一次定向编辑，不代表验证通过；已有 `initial_dashboard_contract` 时禁止重复调用 |
| `query_json` | 单次批量查询最多 16 个 RFC 6901 JSON Pointer；核心产物优先使用 `final_dashboard`、`sources_evidence` 等 artifact handle。明确的 `public/data/dashboard*.json` 或匹配当前标的的代码文件别名会安全纠正到 `data_file/final/dashboard-data.json`，标的不一致时失败关闭；其他缺失路径返回实际存在的权威 JSON 候选。缺失 pointer 降级为根 shape，常见点路径自动转成 pointer；大数组只返回头部与较新的尾部样本，并显式记录省略信息、shape 与 SHA-256 |
| `query_text_file` | 单次批量查询最多 16 个组件、函数或 CSS selector 字面锚点；多行/超长锚点会拆成可执行的短字面量，缺失锚点降级为有界文件头，而不是浪费一轮模型调用；公平返回有界行窗，替代完整源码和连续区间扫描 |
| `write_file`、`edit_file`、`apply_patch` | generation 只写 UI/源码 allowlist；拒绝 env、package、lockfile、scripts 和执行配置 |
| `quant_api_get` | 仅允许固定本地服务上的行情、研究、基本面、指标、事件、回测和健康检查只读端点；拒绝补数、探测及其他管理端点；单次运行最多 32 次请求 |
| `quant_extract_uploaded_image` | 校验工作空间图片、格式、尺寸、大小和 SHA-256；不伪造 OCR 结果 |
| `submit_result` | 校验声明产物仍在工作空间内并返回 `candidate_complete`；成功后仅结束物理 AgentRun，不能声明 Mission 验证通过 |

平台预取 generation 的默认工具面只有定向写入、`inspect_dashboard_contract`、`query_json`、`query_text_file` 和 `submit_result`；无附件时不注册图片工具，已预取时不注册行情 API。repair 没有静态宽权限：平台把本轮 failed check ID 编译成写入 allowlist；纯视觉失败只能写安全的页面源码面，纯数据失败会关闭默认源码写面并只开放命中的 final/evidence 路径。失败报告缺失或没有明确失败项时，模型调用前即失败关闭。任何 profile 都不能写 `.quantpilot/**`，final/evidence 和超过工具输出预算的有效大 JSON 也不能再通过 raw reader 顺序扫描。

`list_files`、文件读取、`inspect_dashboard_contract`、`query_json` 与 `query_text_file` 使用工作区代际 observation cache。它不是跨请求缓存，也不是 completion cache：只在当前 run 内、且没有成功 workspace write 时复用完全相同的读取。`quant_api_get` 等实时/外部读取明确不使用该机制。

前端不再逐条倾倒底层读取尝试：同一 request 中相同工具与目标被压成一条连续活动，后续成功会吸收之前的参数失败；路径被 artifact resolver 安全纠正时显示规范化后的真实目标与“已纠正”，只有最终未恢复的失败保留“待恢复”和可展开诊断。模型每轮的自由文本旁白始终标记为内部消息，用户只看到平台阶段、typed tool 的有效结果和最终结论。

## 生成代码执行边界

MoAgent 本身没有 Shell 工具，但生成项目仍需要由平台执行 build 和 preview。Linux 上，这些命令默认进入 user、mount 和 PID namespace：只读挂载当前生成工作空间、共享 `node_modules` 和 Node runtime，仅开放工作空间 `.next` 写入；宿主项目其余目录、用户主目录和平台密钥不会挂载，进程环境也会按白名单重建。执行前的 artifact policy 会先拒绝子进程、动态执行、任意网络客户端、宿主绝对路径等高风险代码，策略不通过时不会启动 build 或 preview。

当前沙箱不创建独立 network namespace；网络出口依赖 artifact policy、固定本地量化 API 和部署层网络策略共同约束。因此生产环境仍应在容器或主机防火墙层限制出站访问。非 Linux 平台默认拒绝执行生成代码；只有已经处于外部隔离环境的本地开发机，才可显式设置 `QUANTPILOT_ALLOW_UNSANDBOXED_GENERATED_CODE=1` 作为不安全覆盖，生产环境不得开启。

## 扩展规则

- 新 Provider 实现 `MoAgentModelProvider`，不得让其 wire format 泄漏到 Run Engine。
- 新工具实现 `MoAgentTool`，必须声明 JSON Schema、输入校验、AbortSignal、超时、有界输出、`effect` 和 `idempotency`；可写工具默认 `reconcile_required`，不要加入通用 Shell。只有结果完全由当前 workspace generation 决定的只读工具才能声明 `observationCache: 'workspace_generation'`，行情、网络与时间敏感读取禁止声明。
- 新 AgentRun 终态只能通过结构化 `MoAgentRunResult` 和 `run_finished` 事件表达；产品完成态只能由当前 candidate version 的 accepted evidence receipt 驱动。
- 内部 `MoAgentEvent` 的工具事件可包含 raw arguments/result，只允许受信的进程内消费者读取；数据库、Message、SSE/WebSocket 和其他产品边界必须分别使用显式安全投影，不得直接序列化内部事件或完整 `MoAgentRunResult`，也不得保存内部 messages、hidden reasoning、raw tool arguments/result 或 raw cause。
- Provider 必须拒绝响应与工具调用身份缺失、身份漂移、重复 ID 和不完整终止，不能容错拼接成可执行动作。
- 新 Skill 必须进入 registry/lock，并在 `config/moagent-skill-capsules.json` 声明 phase、typed-tool 依赖、原子步骤、完成条件和可选 reference selector。发布检查会拒绝缺失 capsule、越界引用或包含 Bash/MCP/curl/npm 执行指令的 runtime capsule。
- 产品层不能持久化 hidden reasoning，也不能把 Agent 阶段成功当作整条生成请求成功。

## 外部项目对照审计

MoAgent 会参考其他 Agent 项目的可验证设计，但不会直接引入其运行时。针对 Claw Code 固定提交的采纳、拒绝与后续差距路线图，见 [MoAgent × Claw Code 对照审计](./moagent-claw-code-review.md)。审计文档区分已落地的 project lease、mutation execution gate/commit lock 与仍待实施的 reconciliation worker、durable dispatcher 和客户端事件补发；规划项不应视为当前能力。

仓库仍把历史命名的 `.claude/skills` 作为受 registry/lock/hash 校验的 MoAgent 编译输入，也保留少量遗留数据库字段；该目录名不会加载 Claude Agent SDK，除只读 Skill 编译外的遗留兼容字段不参与 MoAgent 执行控制流。

MoAgent 执行前必须把 `prisma/schema.prisma` 中的五张 durable runtime 表和三张 Mission/evidence 表、`user_requests(id, project_id)` 复合唯一约束、每项目唯一 active Mission slot 以及全部关联外键一并应用到 PostgreSQL，并生成对应 Prisma Client。只读 catalog readiness 的当前契约版本是 `20260715000400_add_moagent_generation_epoch_slot`；缺失 Mission spec、节点、receipt 索引、active slot 或 accepted-receipt 外键时同样拒绝运行。本地开发启动会执行非破坏性的 `prisma db push` 漂移同步；生产环境必须使用仓库内的版本化 baseline 与三次 MoAgent 增量 migration，并通过 readiness 后才接收运行。新库、旧版存量库以及曾由 `db push` 同步过的数据库采用不同接入步骤，详见 `prisma/migrations/README.md`；半升级或无法分类的结构必须 fail closed，禁止 reset 或猜测性 resolve。

PostgreSQL 并发契约有独立、不可静默跳过的验收入口。它会先对目标执行 `prisma db push --skip-generate`，因此必须指向全新或可销毁的隔离测试数据库，绝不能指向开发共享库或业务库：

```bash
MOAGENT_TEST_DATABASE_URL='postgresql://...' npm run test:moagent:postgres
```

该套件当前包含 10 个用例，覆盖同项目与同 canonical workspace 数据库竞争、数据库时钟抗 worker clock skew、过期接管、request 绑定、一次性提交授权、`uncertain` 后禁止继续写、终态释放和资源锁/接管线性化；CI 的 contract evaluation job 会提供临时 PostgreSQL 并强制执行。资源锁测试仍是本机进程内测试，不替代目标共享卷验收。外层数据预取、build、preview 和验证编排不在 MoAgent 工具写栅栏内，它们仍使用各自的平台协调机制；本节能力只覆盖 MoAgent typed workspace-write 工具与 run takeover。

## 配置

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `DEEPSEEK_API_KEY` | 无 | 唯一必需模型凭据 |
| `MOAGENT_MAX_REQUEST_BYTES` | `2000000` | 单次 Provider 请求体的 UTF-8 字节硬上限；超限时不发起网络请求 |
| `MOAGENT_PROVIDER_MAX_RETRIES` | `2` | 响应流开始前，网络错误与瞬时 HTTP 状态的最大重试次数 |
| `MOAGENT_PROVIDER_RETRY_BASE_MS` | `500` | Provider 指数退避的基础等待时间 |
| `MOAGENT_PROVIDER_RETRY_MAX_MS` | `10000` | 单次 Provider 重试等待上限，包括服务端 `Retry-After` |
| `MOAGENT_TOOL_OUTPUT_CHARS` | `6000` | 单个 typed tool 的模型可见输出上限；结构化工具会在该预算内继续投影或返回分批查询提示 |
| `MOAGENT_MAX_TURNS` | `12` | 最大模型轮数；代表性预取看板实测 5 轮完成 |
| `MOAGENT_MAX_TOTAL_TOOL_CALLS` | `20` | 一次 run 的累计工具调用硬上限 |
| `MOAGENT_PRE_WRITE_READ_ONLY_TURNS` | `3` | 首次成功写入前允许的连续只读轮数；达到后 read 工具从下一轮硬移除 |
| `MOAGENT_POST_WRITE_READ_ONLY_TURNS` | `2` | 成功写入后允许的连续只读轮数；达到后再次硬切回写入/提交阶段 |
| `MOAGENT_MAX_TURN_OUTPUT_TOKENS` | `12000` | 单次 Provider 调用的输出 Token 上限；`MOAGENT_MAX_OUTPUT_TOKENS` 仅作为升级期间的兼容回退名 |
| `MOAGENT_MAX_RUN_OUTPUT_TOKENS` | `24000` | 一次完整 MoAgent run 的累计输出 Token 上限 |
| `MOAGENT_CONTEXT_WINDOW_TOKENS` | `128000` | MoAgent 内部上下文治理窗口；是产品保守值，不等同于 Provider 宣传上限 |
| `MOAGENT_MAX_INPUT_TOKENS` | `48000` | 每次 Provider 请求的内部输入预算；默认使用带安全余量的多语种启发式估算，并对高熵长串提高权重 |
| `MOAGENT_MAX_RUN_INPUT_TOKENS` | `160000` | 累计 Provider 实报输入 Token 上限；达到后阻止下一次请求，不丢弃当前轮结果 |
| `MOAGENT_MAX_RUN_CACHE_MISS_INPUT_TOKENS` | `120000` | 累计 Provider 实报非缓存输入 Token 上限；Provider 未报告该字段时不猜测 |
| `MOAGENT_TIMEOUT_MS` | `1200000` | 总运行超时 |
| `MOAGENT_LEASE_TTL_MS` | `60000` | Durable run lease 有效期 |
| `MOAGENT_HEARTBEAT_INTERVAL_MS` | `15000` | Durable run 独立心跳间隔，必须小于 lease TTL |
| `MOAGENT_RESOURCE_LOCK_WAIT_MS` | `5000` | 启动临界区或文件最终提交等待 workspace 资源锁的上限；超时失败关闭，不会自动清除孤儿锁 |
| `MOAGENT_INSTANCE_ID` | `hostname:pid` | 写入资源锁 owner metadata 的稳定实例标识；容器部署建议设置为 pod/instance ID，不能包含换行或超过 256 UTF-8 bytes |
| `MOAGENT_WORKSPACE_NAMESPACE` | `quantpilot-local` | canonical workspace 身份命名空间；共同执行同一 project 的实例必须共享 PostgreSQL、namespace 与物理文件系统。不共享工作区的部署必须隔离数据库/project identity，不能只靠改 namespace 绕过 project lease |
| `MOAGENT_SKILL_CONTEXT_CHARS` | `6000` | 数据准备阶段的 Skill manifest + task capsule 总字符预算；原子内容超限时失败，不做语义截断 |
| `MOAGENT_PREFETCHED_SKILL_CONTEXT_CHARS` | `4000` | 平台预取 generation/repair 的 Skill manifest + task capsule 总字符预算 |
| `MOAGENT_REASONING_EFFORT` | 空 | 可选 `low/medium/high/max` 覆盖；默认 UI 生成用 `medium`，数据准备与验证修复用 `high` |
| `MOAGENT_REASONING` | `1` | 设为 `0` 关闭 thinking |
| `QUANTPILOT_GENERATED_SANDBOX` | `1` | Linux 上启用生成项目 namespace 沙箱；设为 `0` 仍需显式不安全覆盖 |
| `QUANTPILOT_ALLOW_UNSANDBOXED_GENERATED_CODE` | `0` | 仅供已外部隔离的非生产开发环境使用；生产必须保持关闭 |
