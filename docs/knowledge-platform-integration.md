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
7. 只有 Mission 取得 accepted Evidence Receipt 后，QuantPilot 才按实际进入 Agent 上下文的 Citation 写 AKEP Usage；取消、拒绝、澄清和失败任务不写 Usage。

当前第一阶段使用平台预取，不给模型增加动态知识工具。这样 MoAgent lane 的工具 schema 保持稳定，也不会让知识服务故障改变标准看板的确定性工具面。后续确需动态研究时，可在明确的 data-preparation lane 增加固定 schema 的只读工具，但 URL、Space、purpose、token 和预算仍由平台注入。

## 本地配置

Agent Knowledge Platform 默认使用统一入口 `http://localhost:8080`，QuantPilot/ModelPort 分别使用 `3000`/`38082`，AKEP Core 直连调试端口可使用 `43117`，避免与 QuantPilot 冲突。

```dotenv
QUANTPILOT_KNOWLEDGE_ENABLED=1
QUANTPILOT_KNOWLEDGE_REQUIRED=0
QUANTPILOT_KNOWLEDGE_API_URL=http://localhost:8080
QUANTPILOT_KNOWLEDGE_PURPOSE=quant-research
QUANTPILOT_KNOWLEDGE_SPACES=https://knowledge.local/spaces/default
QUANTPILOT_KNOWLEDGE_BEARER_TOKEN=dev-reader
```

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
curl --fail http://localhost:8080/.well-known/akep
curl --fail http://localhost:8080/health/ready
curl --fail http://127.0.0.1:38082/livez
npx vitest run src/lib/platform/knowledge src/lib/services/moagent-prompts.test.ts
npm run check:service-catalog
npm run type-check
```

代码入口：

- `src/lib/platform/knowledge/port.ts`：QuantPilot provider-neutral Port。
- `src/lib/platform/knowledge/akep-http.ts`：AKEP HTTP、Discovery、同源和响应边界。
- `src/lib/platform/knowledge/service.ts`：ContextPack、降级、Usage 与证据文件。
- `src/app/api/chat/[project_id]/act/route.ts`：规划后预取、Mission 验收后 Usage。
- `src/lib/services/moagent-prompts.ts`：不可信知识 capsule 的提示边界。
- `config/service-catalog.json`、`src/lib/ops/readiness.ts`：AKEP 与 ModelPort 运维可见性。
