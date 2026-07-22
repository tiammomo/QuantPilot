# 配置、模型接入与可选组件指南

这篇文档是 QuantPilot 配置方式的权威入口。它回答几个最容易混淆的问题：配置应该放在哪个文件、模型是否必须经过 ModelPort、Memory 与受治理知识是否启用，以及不同组合如何验证。

QuantPilot 支持这些长期运行方式：

- 推荐拓扑：默认 Qwen 经 ModelPort，日常 DeepSeek 也经 ModelPort。
- 官方直连：某个项目直接调用 DeepSeek 官方 OpenAI-compatible API，不经过 ModelPort。
- Qwen-only：只安装 ModelPort 的本地 Qwen provider，不配置任何 DeepSeek 上游凭据。
- 不启用 Memory：保留模型、行情、生成和验证能力，但完全不请求 Evolvable User Memory。
- 不启用受治理知识：保留模型、行情、生成和验证能力，但不请求 AKEP ContextPack。
- 离线降级：主动关闭可选外部探测，适合局部开发和故障排查，不等同于常规的“关闭 Memory”。

模型、Memory 和 AKEP 知识是三条独立链路，可以自由组合。例如“DeepSeek 官方直连 + 不启用 Memory/AKEP”与“ModelPort Qwen + Memory + AKEP”都受支持。

## 配置文件职责与优先级

| 位置 | 是否提交 Git | 应该放什么 | 不应该放什么 |
| --- | --- | --- | --- |
| `.env.example` | 是 | 完整变量目录、安全开发默认值、字段说明 | 真实密钥、个人路径、线上地址 |
| `.env` | 否 | 由启动器维护的本地基础设施默认值，如端口、数据库和观测地址 | 上游 Provider 密钥 |
| `.env.local` | 否 | 本机凭据、机器级覆盖、个人开发开关 | 需要团队共享的唯一规范 |
| `.env.production.example` | 是 | 严格生产模板和占位值 | 可直接部署的真实 secret |
| `config/llm.json` | 是 | 允许使用的模型 profile、固定 Base URL、凭据变量名、Query Rewrite 策略 | 任何真实凭据、用户传入的任意 URL |
| 进程或部署 Secret | 否 | CI/生产凭据和最高优先级覆盖 | 可公开的默认配置 |

运行时优先级为：

```text
进程 / 容器环境变量 > .env.local > .env > 程序默认值
```

`npm install` 的 `postinstall` 和 `npm run ensure:env` 会运行 `scripts/dev/setup-env.js`，创建缺失的 `.env` / `.env.local`，并同步 Web 与预览端口。脚本不会用示例文件覆盖已有密钥。开发启动器也按上述顺序加载配置。

建议不要执行 `cp .env.example .env.local`。示例文件是完整字典，把它整体复制到本机覆盖层会制造大量重复值，之后很难判断哪个文件真正生效。`.env.local` 只保留本机确实需要的几行即可。

布尔开关统一接受 `1/0`；部分解析器也接受 `true/false`、`yes/no`、`on/off`。文档和部署模板统一使用 `1/0`，避免不同工具解释不一致。修改服务端变量后需要重启 QuantPilot；修改 ModelPort 或 Memory 自身变量后需要重启对应服务。

## 首次启动

```bash
npm install
npm run ensure:env
npm run db:up
npm run db:init
npm run dev
```

此时仍需根据下面的模型模式，在 `.env.local` 中放入最小凭据。默认页面是 `http://localhost:3000`；端口占用时启动器会选择 `3000-3099` 中的可用端口并更新本地文件。

## 模型接入方式

### 方式对照

| 模式 | QuantPilot 模型 ID | QuantPilot 凭据 | ModelPort 是否必需 | 适合场景 |
| --- | --- | --- | --- | --- |
| 本地 Qwen（默认） | `local_qwen:qwen3.5-9b-q5km` | `MODELPORT_API_KEY` | 是 | 日常默认、低成本本地推理 |
| DeepSeek 经 ModelPort | `deepseek:deepseek-v4-flash` | `MODELPORT_API_KEY` | 是 | 日常线上 DeepSeek、集中密钥/用量/余额治理 |
| DeepSeek 官方直连 | `deepseek-v4-flash` | `DEEPSEEK_API_KEY` | 否 | 绕过网关验证、独立部署或应急路径 |

`local_qwen:qwen3.5-9b-q5km` 始终是代码级默认模型。项目、账号全局设置或 URL 可以显式选择其他已注册模型；浏览器不能提交任意 Base URL 或任意 Provider。

### A. 推荐：Qwen 与 DeepSeek 都经过 ModelPort

QuantPilot 的 `.env.local` 只需 ModelPort 客户端 Key：

```dotenv
MODELPORT_API_KEY="replace-with-scoped-modelport-client-key"
```

ModelPort 负责保存和调用真正的上游凭据。其 DeepSeek provider 使用 Anthropic 协议：

```dotenv
# 只存在于 ModelPort，不要复制到 QuantPilot
DEEPSEEK_ANTHROPIC_AUTH_TOKEN="replace-with-deepseek-upstream-key"
```

```toml
[providers.deepseek]
protocol = "anthropic"
base_url = "https://api.deepseek.com/anthropic"
api_key_env = "DEEPSEEK_ANTHROPIC_AUTH_TOKEN"
default_model = "deepseek-v4-flash"
```

为 QuantPilot 签发的客户端 Key 应至少允许实际使用的 provider/model。只使用 Qwen 时不必给它 DeepSeek scope；两者都使用时应允许：

- `local_qwen:qwen3.5-9b-q5km`
- `deepseek:deepseek-v4-flash`
- `GET /v1/models`
- `POST /v1/chat/completions`

启动 ModelPort 后先检查客户端凭据：

```bash
set -a
source .env.local
set +a
curl -fsS \
  -H "Authorization: Bearer ${MODELPORT_API_KEY}" \
  http://127.0.0.1:38082/v1/models
```

`401` 表示客户端 Key 无效；`403` 通常表示 Key 有效但 scope 不允许目标 provider/model；连接失败才是 ModelPort 未启动、监听地址不对或网络问题。

### B. DeepSeek 官方直连，不经过 ModelPort

在 QuantPilot 的忽略文件 `.env.local` 中配置官方 OpenAI-compatible Key：

```dotenv
DEEPSEEK_API_KEY="replace-with-official-deepseek-api-key"
```

不要同时配置 `DEEPSEEK_ANTHROPIC_AUTH_TOKEN`。后者是 ModelPort Anthropic provider 的上游变量，QuantPilot 官方直连 profile 不读取它。

然后在以下任一入口显式选择 **DeepSeek V4 Flash (Official Direct)**，对应模型 ID 为 `deepseek-v4-flash`：

- 新建项目对话框；
- 设置页的 AI Agent 默认模型；
- 已有项目聊天页的模型选择器。

该 profile 固定连接 `https://api.deepseek.com`，不会经过 `127.0.0.1:38082`。如果机器上完全不运行 ModelPort，务必先把账号默认或新项目模型改成官方直连；否则代码级默认 Qwen 仍会尝试访问 ModelPort。这是显式选择保护，不会因为发现了一个 Key 就偷偷改变现有项目的 provider。

本地可以直接验证官方端点。下面的请求会产生真实 Token 费用：

```bash
set -a
source .env.local
set +a
curl -fsS https://api.deepseek.com/chat/completions \
  -H "Authorization: Bearer ${DEEPSEEK_API_KEY}" \
  -H 'Content-Type: application/json' \
  -d '{"model":"deepseek-v4-flash","messages":[{"role":"user","content":"只回复 ok"}],"stream":false}'
```

生产环境应由 Secret Manager 注入 `DEEPSEEK_API_KEY`，而不是把真实值写进镜像、仓库或 `.env.production.example`。当前严格生产模板以 ModelPort/Qwen 默认拓扑为基线；若部署为完全 direct-only，发布验收必须额外确认所有默认项目和评测任务都显式选择官方直连。

### C. 只使用本地 Qwen，不安装 DeepSeek

这是有效的长期拓扑。ModelPort 只启用 `local_qwen` provider，QuantPilot 使用一个仅允许该 provider/model 的客户端 Key：

```dotenv
MODELPORT_API_KEY="replace-with-qwen-only-client-key"
```

不配置以下变量：

```dotenv
# QuantPilot 不需要
# DEEPSEEK_API_KEY=

# ModelPort 不需要
# DEEPSEEK_ANTHROPIC_AUTH_TOKEN=
```

默认 Qwen、Query Rewrite、workspace 生成、工具调用和自动验证都能工作。DeepSeek 模型仍可能出现在 QuantPilot 的受控模型目录中，但选择它会得到清晰的未授权或凭据缺失错误，不会自动把请求转给 Qwen。

### 模型总开关与 Query Rewrite

```dotenv
QUANTPILOT_LLM_AGENT_ENABLED=1
QUANTPILOT_LLM_QUERY_REWRITE_ENABLED=1
QUANTPILOT_QUERY_REWRITE_LLM_TIMEOUT_MS=15000
QUANTPILOT_QUERY_REWRITE_LLM_MAX_RETRIES=0
QUANTPILOT_QUERY_REWRITE_LLM_INVALID_OUTPUT_RETRIES=2
```

正常运行时，Query Rewrite 总是调用项目当前选择的大模型进行语义改写，并保留“大位科技”一类原始实体，不用关键词匹配替代模型理解。设置 `QUANTPILOT_LLM_QUERY_REWRITE_ENABLED=0` 会让量化规划明确失败关闭，不会启用旧的关键词 rewrite。

设置 `QUANTPILOT_LLM_AGENT_ENABLED=0` 会关闭模型执行能力，workspace 生成等需要 Agent 的任务不可用。它不代表切换 provider，也不是某个模型失败时的自动备用方案。

## 受治理知识接入方式

Agent Knowledge Platform 是可选的独立 AKEP HTTP 服务。它只提供已发布、带 Citation 的共享知识，不参与模型路由，也不替代 market-data 或用户 Memory。

```dotenv
QUANTPILOT_KNOWLEDGE_ENABLED=1
QUANTPILOT_KNOWLEDGE_REQUIRED=0
QUANTPILOT_KNOWLEDGE_API_URL="http://localhost:33005"
QUANTPILOT_KNOWLEDGE_PURPOSE="quant-research"
QUANTPILOT_KNOWLEDGE_SPACES="https://knowledge.local/spaces/default"
QUANTPILOT_KNOWLEDGE_PROJECT_SPACES_ENABLED=1
QUANTPILOT_KNOWLEDGE_PROJECT_SPACE_BASE_URL="https://knowledge.local/spaces/quantpilot/projects"
QUANTPILOT_KNOWLEDGE_BEARER_TOKEN="dev-reader"
```

`KNOWLEDGE_SPACES` 是 Consumer 共享知识；开启 project Spaces 后，每个可信 `Project.id` 自动增加一个独立 Space。不要在请求 body 中接收 Space，也不要把多个项目的私有知识放入 shared Space。

`REQUIRED=0` 时契约不兼容、超时、拒绝或空结果会显式降级；`REQUIRED=1` 时知识准备失败会在 Mission 创建前失败关闭。生产禁止静态 bearer token，必须配置 OAuth client credentials。完整链路、安全边界和验收见 [Agent Knowledge Platform 接入、证据与解耦边界](knowledge-platform-integration.md)。

## Memory 接入方式

### 模式对照

| 配置 | 是否请求 Memory | Memory 故障时 | 适合场景 |
| --- | --- | --- | --- |
| `ENABLED=1, REQUIRED=0` | 是 | 标记 unavailable，核心任务继续 | 本地开发、渐进接入 |
| `ENABLED=1, REQUIRED=1` | 是 | readiness/相关任务失败关闭 | 已完成治理的生产环境 |
| `ENABLED=0` | 否 | 不受影响 | 不需要个性化或尚未部署 Memory |
| `DEGRADATION_MODE=offline` | 否 | 同时关闭多项外部能力 | 局部开发、网络故障排查 |

`REQUIRED=0` 不等于关闭 Memory。只要 `ENABLED=1`，服务健康时 QuantPilot 仍会进行 discovery、recall 和可归因反馈。如果要求完全没有 Memory 网络请求，必须设置 `QUANTPILOT_MEMORY_ENABLED=0`。

### 启用 Memory，本地可降级

```dotenv
QUANTPILOT_MEMORY_ENABLED=1
QUANTPILOT_MEMORY_REQUIRED=0
QUANTPILOT_MEMORY_REQUIRE_PRODUCTION_READY=0
QUANTPILOT_MEMORY_API_URL="http://127.0.0.1:38089"
QUANTPILOT_MEMORY_TENANT_ID="quantpilot-local"
QUANTPILOT_MEMORY_TIMEOUT_MS=5000
QUANTPILOT_MEMORY_RECALL_LIMIT=6
QUANTPILOT_MEMORY_MAX_CONTEXT_CHARACTERS=2000
```

Memory tenant 是消费应用的硬隔离边界，不是随请求变化的 workspace ID。每个后续接入产品必须使用独立 tenant 和独立 workload token；QuantPilot 内部 workspace 由服务端写入的 `context.project_id` 选择，并在 capsule 交付前再次过滤。

本地单用户调试可以临时使用静态 Bearer Token：

```dotenv
QUANTPILOT_MEMORY_BEARER_TOKEN="replace-with-local-development-token"
```

多用户生产禁止静态通配 token，必须通过可信 broker 按 tenant、subject 和 purpose 换取短期 JWT：

```dotenv
QUANTPILOT_MEMORY_REQUIRE_PRODUCTION_READY=1
QUANTPILOT_MEMORY_TOKEN_BROKER_URL="https://identity.internal.example.com/memory-token"
QUANTPILOT_MEMORY_TOKEN_BROKER_CLIENT_ID="quantpilot-production"
QUANTPILOT_MEMORY_TOKEN_BROKER_CLIENT_SECRET="replace-with-secret"
QUANTPILOT_MEMORY_TOKEN_AUDIENCE="evolvable-memory-api"
```

完整启动、API 契约、归因和效果验证见 [用户记忆服务接入、使用与效果验证](user-memory-integration.md)。

### 不启用 Memory

只需要一行：

```dotenv
QUANTPILOT_MEMORY_ENABLED=0
```

此模式下：

- 不需要启动 `/home/tiammomo/projects/dev/evolvable-user-memory`；
- 不需要 Memory URL、Bearer Token 或 Token Broker；
- 聊天不会请求 discovery/recall/outcome，个性化状态为 `disabled`；
- 模型调用、Query Rewrite、行情读取、workspace 生成、自动验证和预览不受影响；
- 账号记忆管理、偏好召回和“本轮使用了哪些偏好”的反馈能力不可用。

如果 `.env` 已经写了 Memory URL 或 token，也无需删除；`ENABLED=0` 是总闸。密钥不再使用时仍建议从本地文件和 Secret Manager 中撤销，减少遗留风险。

### 不要用 offline 代替单独关闭 Memory

```dotenv
QUANTPILOT_DEGRADATION_MODE=offline
```

`offline` 会连带关闭或绕过市场 API、Memory、集中观测和 Redis 等可选外部依赖，适合前端/模板局部开发或故障隔离。正常使用模型和行情、只是不要个性化时，应保持 `auto` 或 `strict`，单独设置 `QUANTPILOT_MEMORY_ENABLED=0`。

## 可直接复制的组合

### 默认 Qwen + ModelPort DeepSeek + Memory + AKEP

```dotenv
MODELPORT_API_KEY="replace-with-scoped-modelport-client-key"
QUANTPILOT_MEMORY_ENABLED=1
QUANTPILOT_MEMORY_REQUIRED=0
QUANTPILOT_MEMORY_API_URL="http://127.0.0.1:38089"
QUANTPILOT_KNOWLEDGE_ENABLED=1
QUANTPILOT_KNOWLEDGE_REQUIRED=0
QUANTPILOT_KNOWLEDGE_API_URL="http://127.0.0.1:33005"
QUANTPILOT_KNOWLEDGE_PURPOSE="quant-research"
QUANTPILOT_KNOWLEDGE_SPACES="https://knowledge.local/spaces/default,https://knowledge.local/spaces/quantpilot-acceptance"
```

### 默认 Qwen + 不启用 Memory

```dotenv
MODELPORT_API_KEY="replace-with-qwen-client-key"
QUANTPILOT_MEMORY_ENABLED=0
```

### DeepSeek 官方直连 + 不启用 Memory

```dotenv
DEEPSEEK_API_KEY="replace-with-official-deepseek-api-key"
QUANTPILOT_MEMORY_ENABLED=0
```

保存后还需在 QuantPilot 中选择 `deepseek-v4-flash`；只配置 Key 不会改变默认 Qwen。

### 完全离线的界面/模板开发

```dotenv
QUANTPILOT_DEGRADATION_MODE=offline
QUANTPILOT_MEMORY_ENABLED=0
QUANTPILOT_MARKET_API_ENABLED=0
QUANTPILOT_OBSERVABILITY_ENABLED=0
QUANTPILOT_REDIS_CACHE_ENABLED=0
```

该组合不适合验收真实数据投研、Agent 生成或生产 readiness。

## 其他配置分组

`.env.example` 是逐项完整字典，下面是定位问题时应先看的分组。

| 分组 | 关键变量 | 说明 |
| --- | --- | --- |
| PostgreSQL/TimescaleDB | `DATABASE_URL`, `POSTGRES_*`, `TIMESCALEDB_IMAGE` | 应用状态、项目、消息、时序数据；Compose 与应用连接信息要同步 |
| Redis | `REDIS_URL`, `REDIS_NAMESPACE`, `QUANTPILOT_REDIS_*` | 缓存；`REQUIRED=0` 允许降级但不代表关闭 |
| ClickHouse | `CLICKHOUSE_*`, `QUANTPILOT_CLICKHOUSE_*` | 可选分析存储，默认关闭 |
| Web/预览 | `PORT`, `WEB_PORT`, `NEXT_PUBLIC_APP_URL`, `PREVIEW_PORT_*` | 主站与生成 workspace 预览端口池 |
| 认证 | `QUANTPILOT_AUTH_*`, `BETTER_AUTH_URL` | 本地可关闭；生产必须强 secret、安全 Cookie、可信 Origin |
| 管理接口 | `QUANTPILOT_ADMIN_TOKEN`, `QUANTPILOT_MARKET_ADMIN_TOKEN` | 保护 host 级写操作和 market-data 写接口 |
| 市场数据 | `QUANTPILOT_MARKET_*`, `QUANTPILOT_SCREENER_*` | FastAPI 地址、启动与缓存超时 |
| Model/Agent | `MODELPORT_API_KEY`, `DEEPSEEK_API_KEY`, `QUANTPILOT_LLM_*`, `MOAGENT_*` | Provider 凭据、运行预算、超时、lease 和上下文上限 |
| Memory | `QUANTPILOT_MEMORY_*` | 可选召回、broker、租户和有界上下文 |
| 受治理知识 | `QUANTPILOT_KNOWLEDGE_*` | AKEP ContextPack、Space、Purpose、Citation、Usage 与 Feedback |
| 观测 | `LOKI_*`, `GRAFANA_*`, `GRAFANA_ALLOY_*` | 集中日志和本地兜底 |
| 评测 | `QUANTPILOT_EVAL_*`, `QUANTPILOT_REQUIRE_*` | 隐藏集、replay、独立 judge 与发布门禁 |
| workspace 安全 | `QUANTPILOT_GENERATED_SANDBOX`, `MOAGENT_WORKSPACE_NAMESPACE` | 生成代码隔离和多实例共享资源边界 |

MoAgent 的 Token、轮次、工具调用和 lease 默认值已经按完整 workspace 任务校准。除非有运行 trace 证明瓶颈，不要通过无限调大预算掩盖模型不收敛、工具契约错误或终态提交缺失。

generation dispatch 的关键配置是 `MOAGENT_DISPATCH_LEASE_TTL_MS=120000`、`MOAGENT_DISPATCH_HEARTBEAT_INTERVAL_MS=30000`、`MOAGENT_DISPATCH_PENDING_ORPHAN_GRACE_MS=120000` 和 `MOAGENT_DISPATCH_ENVELOPE_MAX_BYTES=262144`。heartbeat 必须严格小于 TTL；pending 宽限期用于封存“已入库但尚未 claim 就崩溃”的窄窗口；信封上限只约束 provider-neutral replan 输入，不能用来放宽 Secret 边界，credential-shaped 字段无论大小都会拒绝写库。`.data-agent/generation-queue.json` 可删除并由 PostgreSQL job/outbox 重建，不能通过修改该文件取消、重试或完成任务。

## Secret 边界

必须保持以下归属：

| Secret | 所属服务 | 是否放入 QuantPilot |
| --- | --- | --- |
| `MODELPORT_API_KEY` | ModelPort 签发给 QuantPilot 的客户端凭据 | 是，`.env.local` 或 Secret Manager |
| `DEEPSEEK_ANTHROPIC_AUTH_TOKEN` | ModelPort 的 DeepSeek 上游凭据 | 否 |
| Qwen 上游 Key（如有） | ModelPort 的本地/远端 Qwen provider | 否 |
| `DEEPSEEK_API_KEY` | QuantPilot 官方直连 profile | 仅启用 direct 模式时 |
| `QUANTPILOT_MEMORY_BEARER_TOKEN` | 本地单用户 Memory 调试 | 仅开发；生产禁止静态通配 token |
| `QUANTPILOT_MEMORY_TOKEN_BROKER_CLIENT_SECRET` | QuantPilot 到可信 broker | 生产 Secret Manager |

密钥不得出现在 `config/llm.json`、`.env.example` 的真实值、前端请求、截图、生成 workspace、GitHub Actions 日志或故障文档中。日志只记录 provider/model、状态码、trace ID 和用量，不记录 Authorization header。

## 校验与排障

基础静态校验：

```bash
npm run check:ai-provider-boundary
npm run check:docs
npm run type-check
```

推荐完整拓扑先做 ModelPort/Memory 基础契约联调，再做包含 AKEP 的 30 题体验验收：

```bash
npm run check:integrations
npm run check:triad-experience
```

两条命令都会产生真实模型 Token；第二条还会在固定合成 subject 和隔离 AKEP Space 中验证 Memory、Citation、Usage 与 Feedback 幂等性。Qwen-only、direct-only、Memory-disabled 或 Knowledge-disabled 环境不应把缺少未启用组件当成产品故障，应按本篇对应章节验证实际启用的端点。

生产模板校验：

```bash
npm run check:production -- --env-file /secure/path/quantpilot.env
```

常见判断顺序：

1. 先确认项目选择的模型 ID，避免把 `deepseek-v4-flash` 与 `deepseek:deepseek-v4-flash` 混淆。
2. 再确认凭据归属：ModelPort client key、ModelPort upstream key、官方 direct key 三者不能互换。
3. 检查目标服务 `/health`、`/readyz` 或 `/v1/models`，区分连接失败、`401` 和 `403`。
4. 确认 `.env.local` 没有被外部进程环境变量覆盖；容器编排环境优先级最高。
5. Memory 显示 `disabled` 时先看 `ENABLED`，显示 `unavailable` 才继续查 URL、契约、token 和 production-ready。
6. 配置变更后重启所属服务，并查看运行治理中心或 [故障排查](troubleshooting.md)。
