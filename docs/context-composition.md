# Memory、Knowledge 与 QuantPilot 联合上下文

QuantPilot 是两个外部上下文平台的编排者，但不是它们的共同数据库：

- Evolvable User Memory 提供“这个用户怎样工作和表达”的个性化偏好。
- Agent Knowledge Platform 提供“团队已经发布了什么”的受治理共享知识。
- QuantPilot 提供“本次任务做什么、用了什么数据、是否通过验证”的任务与结果事实。

三方保持独立仓库、部署、数据库、身份和发布周期。QuantPilot 只依赖两个版本化 HTTP Port，不导入平台源码或持久化实体；Memory 与 Knowledge 也不直接调用对方。

## 两层空间模型

所有外部调用都从已完成项目授权的路由参数 `Project.id` 派生同一份 `ProjectIntegrationScope`，不接受浏览器或模型提交 tenant/space：

| 层级 | 含义 | ModelPort | Memory | AKEP |
| --- | --- | --- | --- | --- |
| Consumer | 一个独立接入应用 | API Key 绑定 `organization/project/environment` | 独占 `tenant_id` | 独占 Tenant 或生产实例 |
| Workspace | QuantPilot 中的一个项目 | 通过本地 scope digest 关联，预算默认按 Consumer | `context.project_id` 且交付前再次过滤 | `shared Spaces + <project-base>/<Project.id>` |
| Subject | 当前用户 | principal/usage | `subject_id` | 不保存个人偏好 |

ModelPort 请求头只是对 API Key 绑定的断言；伪造另一 project 会返回 403。Memory 的 `tenant_id` 是硬安全边界，`context.project_id` 是工作区个性化选择器，不能把多个互不信任的产品放进同一 Memory tenant。AKEP Space 是工作区硬检索边界，返回任一未请求 Space 的 passage/citation 会被 QuantPilot 拒绝。

`consumerId` 是 QuantPilot 自己的接入身份，不是三个外部平台共享的 tenant 主键。Memory tenant、AKEP Tenant/Space 与 ModelPort organization/project 各自属于独立命名空间，不能相互 join 或用同一个字符串推导权限；联合清单只保存这些作用域的不可变投影与摘要。

作用域的 canonical SHA-256 同时写入 PostgreSQL 归因记录和 `ContextUseManifest`。同一 request ID 若换项目、租户或 Space 集合重放，会触发幂等冲突。

## 后续产品接入规范

ModelPort、Memory 与 AKEP 是共享基础设施，不代表接入它们的产品可以共享身份。每增加一个消费产品，至少分配下面这组资源；禁止复制 QuantPilot 的 Key、tenant 或项目私有 Space：

| 资源 | QuantPilot 示例 | 新产品要求 |
| --- | --- | --- |
| Consumer ID | `quantpilot` | 全局稳定且不复用，用于本地证据命名和审计 |
| ModelPort | `prj_quantpilot` + 独立 API Key | 管理员创建独立 project/environment、Key、预算与模型策略，再绑定 Key；请求头只是绑定断言 |
| Memory | `quantpilot-local` tenant | 独立 tenant、服务凭据和 subject token grant；不能只靠 `context.product` 隔离互不信任产品 |
| AKEP | QuantPilot Tenant/shared Spaces/project-Space base | 独立 Tenant 或明确授权的 Space 集合；每个 workspace 只追加自己的确定性 project Space |
| 本地数据库 | `Project.id` + scope digest | 保存完整作用域摘要；所有 Exposure、Usage、Feedback 必须带可追溯的 project 外键 |

接入顺序固定为“先建控制面资源，再注入 Secret，最后启用 REQUIRED 模式”。不要先共享一把通配 Key 再计划后续拆分，因为历史账本、配额和反馈归因无法可靠回切。生产验收必须包含至少四个负向用例：伪造 ModelPort project 返回 403、跨 Memory tenant/subject 无结果或拒绝、AKEP 返回未请求 Space 时消费者失败关闭、同一 request ID 换 scope 重放触发冲突。

QuantPilot 内新建 workspace 不需要创建新的 ModelPort Key 或 Memory tenant：它继承 QuantPilot Consumer 边界，并以服务端可信 `Project.id` 隔离 Memory facet、AKEP project Space 和本地 evidence。只有预算或合规要求必须按 workspace 独立核算时，才把 ModelPort scope 从 Consumer 级升级为 workspace 级；这需要显式的服务端 scope registry，不能允许浏览器自行选择 Key 或 project header。

## 一次任务的证据链

```text
Memory:    RecallTrace -> Projection -> Usage Receipt -> explicit Outcome
Knowledge: ContextPack -> Exposure Receipt -> Usage -> explicit business Feedback
QuantPilot: RunPlan -> ContextUseManifest -> Mission -> Accepted Receipt
```

QuantPilot 在 Agent 真正收到上下文前写入 `evidence/context-uses/<requestId>.json`。该清单只连接不透明 receipt、revision/citation ID 和摘要：

- Memory `usageId`、`traceId`、revision ID、源投影摘要和实际交付摘要；
- Knowledge `contextPackId`、Exposure Receipt、context digest、Policy Epoch、citation/revision/space ID；
- Mission accepted receipt 以及 AKEP Usage receipt。

清单不保存个人记忆正文、知识正文、Citation quote、用户原始问题、token 或平台内部主键关系。它是可重建的消费者审计投影，不是第三个知识库。

## 何时记为“使用”

`prepared` 不等于使用。只有满足以下条件才生成联合清单：

1. QuantPilot 已完成项目和用户授权；
2. Memory capsule 已取得服务端可验证的 Usage Receipt；
3. Knowledge ContextPack 已通过本地契约、purpose 和边界检查；
4. 清单已原子写入工作空间；
5. 随后才把两个 capsule 交给 MoAgent。

澄清、拒绝、取消、空召回和平台确定性直出不冒充 Agent 使用。相同 `requestId` 的不同清单会触发幂等冲突，不能静默覆盖。

## 结果如何回流

- Memory 只接受用户明确的 helpful/rejected/corrected 等反馈，且 Outcome 必须引用本轮 `usageId` 中真实出现的 revision。Mission 通过本身不自动强化个人偏好。
- Knowledge 在 Mission 取得 accepted receipt 后只记录实际 Citation Usage；Mission 验收证明交付通过验证，但不证明某条 Citation 产生了正向因果效果。
- 后续只有用户或独立评测器给出 helped/neutral/harmed 时，才作为新的、带 evaluator 身份与业务事件 ID 的 AKEP Feedback 提交；不能改写既有 Usage 或把自动验收冒充用户反馈。

## 故障语义

- Memory/Knowledge 的 `REQUIRED=0` 只控制外部准备失败是否允许核心 Quant 任务降级；不得伪造空 receipt。
- 已选择外部上下文后，如果本地联合曝光清单不能持久化，Agent 调用失败关闭，防止出现不可审计的上下文使用。
- Mission 已经提交 accepted receipt 后，外部结果证据或本地最终投影失败会保留日志和平台侧既有 receipt，供同一幂等键重试；不会回滚已验收的工作空间。
- 删除、抑制和保留仍由各平台自己的治理 API 执行。删除 Memory 不会删除 AKEP 知识；撤回知识也不会改变用户偏好。

## 代码入口

- `src/lib/platform/memory/`：Memory Port、Usage Receipt、本地归因与显式 Outcome。
- `src/lib/platform/knowledge/`：AKEP ContextPack、Usage 和显式业务结果 Feedback。
- `src/lib/platform/context/integration-scope.ts`：从可信 Project 派生跨平台作用域和 digest。
- `src/lib/platform/context/use-manifest.ts`：仅在 QuantPilot 内连接两类不透明 receipt。
- `src/app/api/chat/[project_id]/act/route.ts`：真实任务编排和 Mission 验收时机。

验证命令：

```bash
npx vitest run src/lib/platform/memory src/lib/platform/knowledge src/lib/platform/context
npm run type-check
npm run check:integrations
npm run check:triad-experience
npm run check:triad-experience:large
npm run check:task-e2e -- --campaign=20260719a
```

`check:integrations` 是 ModelPort/Memory 的轻量契约探测；`check:triad-experience` 运行固定 30 题服务级真实体验集；large 模式把每题扩成四种不改变业务语义的自然语言表达，共执行 120 个 case。大规模模式不是复制通过结果：48 个 Query Rewrite 会分别调用 Qwen，24 个 Memory case 分四个稳定测试 subject 执行真实写入/召回/隔离/退出/Usage/历史闭环，24 个 AKEP case 分别创建 ContextPack/Usage/Feedback，24 个组合 case 分别调用模型并核对偏好、Citation 和工具协议。报告分别写入 `tmp/triad-experience-latest.json` 与 `tmp/triad-experience-4x-latest.json`。

这些 service-level case 不创建 Project，不能用任务抽屉数量证明执行过。`check:task-e2e` 才走和首页一致的认证后端入口：创建带 `[E2E <campaign>/<case>]` 前缀的 Project，提交 `/api/chat/:projectId/act`，轮询权威 generation terminal snapshot，并核对当前 run 的 Validation、Mission accepted receipt、Workspace 核心产物、持久预览 HTTP 200 和任务抽屉可见性。固定数据集有 30 个任务，默认并发 2、单任务最长 20 分钟；可先用 `--limit=2` 校准，再用同一 campaign 继续全量，已有 Project 会被恢复而不是复制。失败子集使用 `--only=Cxx,Cyy --retry-failed=N` 在原任务记录内重试；运行中或自动修复中的 generation 保持非终态，不能被中间 Validation 失败抢先判死。报告写入 `tmp/task-e2e-<campaign>-latest.json`，生成的任务默认保留，便于人工打开看板复核。`latest` 反映最后一次命令选择的 case，正式留档前必须再跑一次完整 30 题。

AKEP 的验收记录位于隔离 Space `https://knowledge.local/spaces/quantpilot-acceptance`；若本地长期运行也要使用这些已发布规则，需要把该 Space 显式加入 `QUANTPILOT_KNOWLEDGE_SPACES`，不能用空的默认 Space 假装知识接入有效。
