# Agent Knowledge Platform 接入、证据与解耦边界

QuantPilot 通过 AKEP v0.1 HTTP 协议使用独立的 Agent Knowledge Platform。这个接入用于已发布、可引用、受 Space 和 purpose 约束的共享知识，不替代行情事实库、用户记忆、Skills 或 ModelPort。

## 组件职责

```text
Agent Knowledge Platform -- AKEP HTTP --> QuantPilot KnowledgePort --> MoAgent
ModelPort -- OpenAI-compatible HTTP --> QuantPilot Provider Adapter --> MoAgent
market-data -- Quant HTTP --> QuantPilot data prefetch --> workspace
```

- Agent Knowledge Platform 管理知识 Candidate、审核、发布、Revision、Citation、Exposure、Usage 和 Feedback。
- QuantPilot 管理用户/项目授权、RunPlan、Mission、Agent 上下文、工作空间、验证和最终交付。
- ModelPort 管理 Qwen、DeepSeek 等模型的协议、路由、客户端鉴权、配额和用量。AKEP 不调用模型。
- market-data/TimescaleDB 仍是行情、财务、因子和回测事实的权威来源。
- Evolvable User Memory 只保存用户明确授权的个性化偏好。

两个仓库不共享数据库、Compose、源码包、文件路径或发布流程。QuantPilot 不使用 AKEP 私有 Console API，也不通过相对路径依赖 AKEP 仓库内尚未发布的 TypeScript SDK。

## 运行链路

1. QuantPilot 完成用户、项目和请求授权，并由受信 `run-planner` 生成 RunPlan。
2. 只有 `ready` 的计划才调用 `prepareGovernedKnowledge`；被拒绝或需要澄清的请求不会检索知识。
3. Adapter 先读取 `/.well-known/akep`，验证协议版本、ContextPack extension、操作、过期时间和同源 Base URL。
4. QuantPilot 用配置固定的 Space、purpose、obligation 和字符预算请求 ContextPack。模型不能选择 AKEP URL、token、Space 或 purpose。
5. ContextPack 被包装成不可信 JSON capsule。系统提示明确禁止其中内容覆盖用户请求、金融事实、权限、Skills、工具合同、验证和风险控制。
6. 平台把 Citation、Revision、Payload digest、Policy Epoch 和 Exposure Receipt 写入 `evidence/knowledge-sources.json`，不建立正文镜像。
7. QuantPilot 在 Agent 调用前把 AKEP Exposure 与 Memory Usage 的不透明引用写入[联合上下文清单](context-composition.md)，不复制两边正文。
8. 只有 Mission 取得 accepted Evidence Receipt 后，QuantPilot 才按实际进入 Agent 上下文的 Citation 写 AKEP Usage；取消、拒绝、澄清和失败任务不写 Usage。
9. QuantPilot 将 Usage、Citation 绑定和 Mission receipt 写入服务端 `governed_knowledge_uses` 归因账本；工作空间 JSON 只用于审计展示，不能作为反馈授权依据。
10. Mission 验收不抢占 AKEP 每个 Usage 唯一的最终 Feedback。最终消息显示“有帮助 / 一般 / 有伤害”，只有用户明确选择后才使用固定 evaluator 版本、业务事件 ID 和幂等键提交 AKEP Feedback。

## 越用越强的治理闭环

```text
Published Knowledge -> ContextPack -> Accepted Mission -> Usage
       ^                                             |
       |                                             v
review + publish <- evaluated Candidate <- helped / neutral / harmed
```

- `helped` 是可聚合的正向效果证据；`neutral` 表示使用过但没有确认增益；`harmed` 必须进入 AKEP 复审队列。
- Feedback 不直接修改检索分数、正文或 Published Channel，避免单次评价、恶意评价或模型自评造成知识漂移。
- 反复成功的业务模式可由独立 contributor workload 结合 accepted Mission receipt 和脱敏业务指标生成 Candidate。Qwen/ModelPort 可以辅助形成候选草稿，但模型输出只标记为 `generatedBy`，不能自评、自审或自发布。
- AKEP 对 Candidate 执行固定数据集评测、证据检查和 Curator Review；Publisher 通过后，新 Revision 才进入下一次 ContextPack。
- 因此“越用越强”是可回滚、可解释的发布循环，不是生产 Agent 在线改提示词或直接写知识库。

当前代码已经打通 ContextPack、accepted Usage、服务端归因账本、显式 helped/neutral/harmed 和 AKEP 效果聚合。AKEP 已提供 Candidate、Evaluation、Review、Publish 与 harmed queue；候选内容的运营规则和评测集由接入业务按 Space 配置。

当前第一阶段使用平台预取，不给模型增加动态知识工具。这样 MoAgent lane 的工具 schema 保持稳定，也不会让知识服务故障改变标准看板的确定性工具面。后续确需动态研究时，可在明确的 data-preparation lane 增加固定 schema 的只读工具，但 URL、Space、purpose、token 和预算仍由平台注入。

## 本地配置

Agent Knowledge Platform 使用同尾号端口对：统一 Web 入口 `http://localhost:33005`、Core 直连 `http://localhost:38085`。QuantPilot/ModelPort 分别使用 `3000`/`38082`，端口职责互不重叠。

```dotenv
QUANTPILOT_KNOWLEDGE_ENABLED=1
QUANTPILOT_KNOWLEDGE_REQUIRED=0
QUANTPILOT_KNOWLEDGE_API_URL=http://localhost:33005
QUANTPILOT_KNOWLEDGE_PURPOSE=quant-research
QUANTPILOT_KNOWLEDGE_SPACES=https://knowledge.local/spaces/default
QUANTPILOT_KNOWLEDGE_PROJECT_SPACES_ENABLED=1
QUANTPILOT_KNOWLEDGE_PROJECT_SPACE_BASE_URL=https://knowledge.local/spaces/quantpilot/projects
QUANTPILOT_KNOWLEDGE_BEARER_TOKEN=dev-reader
```

`QUANTPILOT_KNOWLEDGE_SPACES` 是所有工作区都可读的共享 Space。每次请求还会由服务端追加 `<PROJECT_SPACE_BASE_URL>/<url-encoded Project.id>`；模型、浏览器 body 和生成 workspace 都不能选择或扩大它。生产 token 必须只授权所需 shared Space 与当前项目 Space。关闭 `PROJECT_SPACES_ENABLED` 表示明确采用 shared-only 模式，不适用于含项目私有知识的部署。

`dev-reader` 只允许非生产 development auth。生产配置会拒绝静态 bearer token，必须提供 HTTPS OAuth client-credentials token endpoint、client ID/secret、AKEP resource 和最小 scopes。

```dotenv
QUANTPILOT_KNOWLEDGE_OAUTH_TOKEN_URL=https://identity.example/oauth2/token
QUANTPILOT_KNOWLEDGE_OAUTH_CLIENT_ID=quantpilot
QUANTPILOT_KNOWLEDGE_OAUTH_CLIENT_SECRET=inject-from-secret-manager
QUANTPILOT_KNOWLEDGE_OAUTH_RESOURCE=https://knowledge.example/akep/0.1
QUANTPILOT_KNOWLEDGE_OAUTH_SCOPE="akep:query akep:read akep:feedback"
```

当前 AKEP Core 是固定单 Tenant 进程模型。生产 token 的签名 Tenant claim 必须与该部署完全一致；请求参数不能自报 Tenant。普通 QuantPilot workload 不获得 review、publish、incident 或 erase scope。

## 可用性语义

- `QUANTPILOT_KNOWLEDGE_REQUIRED=0`：超时、401/403、契约不兼容或空结果显式降级，核心量化任务继续，不能伪造知识。
- `QUANTPILOT_KNOWLEDGE_REQUIRED=1`：知识准备失败时任务在 Mission 创建前失败关闭。
- `offline` degradation mode：不访问 AKEP 和 ModelPort 等外部可选依赖。
- 空 ContextPack 是合法结果；只说明当前授权 Space、purpose、词法检索和预算下没有匹配项。

Readiness 会分别展示 `knowledge` 与 `modelPort`，不能用顶层 `ok=true` 代替组件检查。

## ModelPort 与 Qwen

默认 profile `local_qwen:qwen3.5-9b-q5km` 继续通过 ModelPort `/v1/chat/completions` 使用本地 Qwen。知识检索本身不消耗模型 Token；Qwen 只负责 QuantPilot 已有的 Query Rewrite、自定义生成和评测 lane。标准可信看板 lane 仍使用零模型 Token 的确定性工具计划。

即使本地 Qwen 可高频使用，仍保留 MoAgent 的上下文、轮数、工具调用和超时上限：这些限制用于收敛、防循环和故障隔离，不是模型计费限制。

## 验证

```bash
curl --fail http://localhost:33005/.well-known/akep
curl --fail http://localhost:33005/health/ready
curl --fail http://127.0.0.1:38082/livez
npx vitest run src/lib/platform/knowledge src/lib/services/moagent-prompts.test.ts
npm run check:service-catalog
npm run type-check
```

代码入口：

- `src/lib/platform/knowledge/port.ts`：QuantPilot provider-neutral Port。
- `src/lib/platform/knowledge/akep-http.ts`：AKEP HTTP、Discovery、同源和响应边界。
- `src/lib/platform/knowledge/service.ts`：ContextPack、降级、Usage、显式业务 Feedback 与证据文件。
- `src/lib/platform/knowledge/growth.ts`、`use-repository.ts`：accepted Usage 归因、幂等反馈和服务端可信账本。
- `src/lib/platform/context/use-manifest.ts`：连接 AKEP、Memory 与 Mission receipt 的无正文审计投影。
- `src/app/api/chat/[project_id]/act/route.ts`：规划后预取、Agent 前联合曝光、Mission 验收后 Usage。
- `src/app/api/projects/[project_id]/knowledge/*`、`src/components/chat/GovernedKnowledgeFeedback.tsx`：业务效果归因与用户强反馈。
- `src/lib/services/moagent-prompts.ts`：不可信知识 capsule 的提示边界。
- `config/service-catalog.json`、`src/lib/ops/readiness.ts`：AKEP 与 ModelPort 运维可见性。
