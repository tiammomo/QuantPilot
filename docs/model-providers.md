# 模型 Provider 接入与使用

QuantPilot 使用三个受版本控制的模型 profile。默认 Qwen 和日常 DeepSeek 连接 ModelPort，同时完整支持某个项目直接调用 DeepSeek 官方 OpenAI-compatible API。浏览器只能选择已注册模型，不能提交任意 Base URL 或密钥。环境文件职责、Memory 组合与可复制配置先看 [配置、模型接入与可选组件指南](configuration.md)。

## 当前链路

| QuantPilot 模型 ID | QuantPilot → ModelPort | ModelPort → 上游 | QuantPilot 凭据 | 默认 |
| --- | --- | --- | --- | --- |
| `local_qwen:qwen3.5-9b-q5km` | OpenAI-compatible `http://127.0.0.1:38082/v1` | `local_qwen` OpenAI-compatible provider | `MODELPORT_API_KEY` | 是 |
| `deepseek:deepseek-v4-flash` | OpenAI-compatible `http://127.0.0.1:38082/v1` | `deepseek` Anthropic provider，`https://api.deepseek.com/anthropic` | `MODELPORT_API_KEY` | 否（日常 DeepSeek） |
| `deepseek-v4-flash` | 不经过 ModelPort | DeepSeek 官方 OpenAI-compatible `https://api.deepseek.com` | `DEEPSEEK_API_KEY` | 否（显式直连） |

这里的两个协议边界不要混淆：QuantPilot 日常只调用 ModelPort 的 `/v1/chat/completions`；ModelPort 再把 DeepSeek 请求转换为 Anthropic `/v1/messages` 并使用 `x-api-key` 调用官方上游。DeepSeek 官方同时提供 OpenAI 和 Anthropic 兼容格式，Anthropic Base URL 是 `https://api.deepseek.com/anthropic`。

## 凭据归属

QuantPilot 本地只保存 ModelPort 签发、按模型和 provider 限权的客户端 Key：

```dotenv
MODELPORT_API_KEY="your-scoped-modelport-client-key"
```

DeepSeek 上游 Key 只放在 ModelPort 的运行环境：

```dotenv
DEEPSEEK_ANTHROPIC_AUTH_TOKEN="your-deepseek-upstream-key"
```

不要把 `DEEPSEEK_ANTHROPIC_AUTH_TOKEN` 复制到 QuantPilot，也不要把真实值写进任一仓库的 `.env.example`、`config/llm.json`、manifest、截图或日志。ModelPort 客户端 Key 与 DeepSeek 上游 Key 必须不同；泄露客户端 Key 时，可以在 ModelPort 单独吊销而不轮换上游账号。

官方直连由 `deepseek-v4-flash` profile 提供。需要绕过 ModelPort 时，可以在忽略的 `.env.local` 中配置 `DEEPSEEK_API_KEY` 做本地调试；CI/生产应由平台 secret 注入。配置 Key 后还必须在项目或账号设置中显式选择官方直连模型，系统不会因为发现 Key 就改变默认 Qwen。

## 三种可独立运行的拓扑

### Qwen 与 DeepSeek 统一走 ModelPort

这是推荐日常拓扑。QuantPilot 只持有 `MODELPORT_API_KEY`，ModelPort 持有 Qwen/DeepSeek 上游凭据并集中提供 scope、用量、预算、健康和 DeepSeek 余额查询。客户端 Key 可以同时授权两个模型，也可以按环境拆成更小 scope。

### DeepSeek 官方直连，不走 ModelPort

QuantPilot `.env.local`：

```dotenv
DEEPSEEK_API_KEY="replace-with-official-deepseek-key"
```

在新建项目、全局 AI Agent 设置或聊天页选择 `deepseek-v4-flash`。该请求固定发送到 DeepSeek 官方 OpenAI-compatible 端点，既不读取 `MODELPORT_API_KEY`，也不访问 ModelPort。

`local_qwen:qwen3.5-9b-q5km` 仍是代码级默认值。如果完全不运行 ModelPort，应先把账号默认模型改为官方直连，并检查旧项目保存的模型选择；否则那些仍选择 Qwen 的任务会正常报告 ModelPort 连接失败，而不是静默换模型。

### 只使用 Qwen，不配置 DeepSeek

ModelPort 只启用 `local_qwen` provider，并签发只允许 `local_qwen:qwen3.5-9b-q5km` 的客户端 Key。QuantPilot 无需 `DEEPSEEK_API_KEY`，ModelPort 无需 `DEEPSEEK_ANTHROPIC_AUTH_TOKEN`。默认生成和 LLM Query Rewrite 都可工作；选择 DeepSeek 时会按凭据/scope 失败，不会自动改走 Qwen。

## ModelPort 配置

ModelPort 的 DeepSeek provider 使用以下结构：

```toml
[providers.deepseek]
display_name = "DeepSeek"
protocol = "anthropic"
base_url = "https://api.deepseek.com/anthropic"
api_key_env = "DEEPSEEK_ANTHROPIC_AUTH_TOKEN"
default_model = "deepseek-v4-flash"
models = ["deepseek-v4-pro", "deepseek-v4-flash"]
```

为 QuantPilot 签发的客户端 Key 至少允许：

- provider：`local_qwen`、`deepseek`；
- model：`local_qwen:qwen3.5-9b-q5km`、`deepseek:deepseek-v4-flash`；
- API：`GET /v1/models`、`POST /v1/chat/completions`。

启动 ModelPort 后检查：

```bash
set -a
source .env.local
set +a
curl -sS -o /dev/null -w '%{http_code}\n' \
  -H "Authorization: Bearer ${MODELPORT_API_KEY}" \
  http://127.0.0.1:38082/v1/models
```

返回 `2xx` 表示 QuantPilot 客户端凭据被接受；`401` 表示 ModelPort 已连通但拒绝该客户端 Key；`403` 通常表示 Key 的 provider/model scope 不包含当前模型。

## 运行时行为

- 新项目、生成、后续聊天、Query Rewrite 和本地评测默认使用 `local_qwen:qwen3.5-9b-q5km`。
- 选择 `deepseek:deepseek-v4-flash` 时，QuantPilot 仍使用同一个 ModelPort OpenAI-compatible adapter；上游协议转换、密钥、健康状态和本地用量由 ModelPort 管理。
- OpenAI Chat Completions 无法无损回传 Anthropic `thinking` block。ModelPort 因此只在“OpenAI 入口 → DeepSeek Anthropic 上游”的转换链关闭 thinking，保证强制工具调用和多轮 tool result 续写；原生 `/v1/messages` 不受该兼容规则影响。
- 选择 `deepseek-v4-flash` 时才启用 QuantPilot 的官方直连 adapter，并按 DeepSeek OpenAI 格式处理 thinking/reasoning 回放。
- Query Rewrite 总是调用当前项目 profile 做大模型语义解析，不使用关键词规则代替；未显式选择时使用 Qwen，并保留“大位科技”等原文实体。
- 三个 profile 共享同一套受控工具、执行预算、durable ledger、取消和最终看板验证，不因切换 provider 放宽 workspace 权限。

## DeepSeek 线上余额

DeepSeek 官方提供 `GET https://api.deepseek.com/user/balance`，返回 `is_available` 以及 CNY/USD 的总余额、赠金余额和充值余额。ModelPort 管理台对 `deepseek` provider 提供管理员手动“查询余额”：请求在服务端使用当前上游凭据，浏览器和 QuantPilot 都不会得到 Key。

能力边界如下：

- ModelPort 可做：实时只读查询、展示可调用状态、结合本地 usage/cost/budget 做监控和后续告警、在上游返回余额不足时标记需要充值。
- ModelPort 不做：充值、退款、发票、账单结算或修改 DeepSeek 账户资金；这些操作仍以 DeepSeek 控制台为权威。
- ModelPort 的本地成本是按配置价格和 Token usage 计算的运行账本，不等同于 DeepSeek 官方账单；两者应对账而不能互相覆盖。

## 长期联调

QuantPilot 不导入 ModelPort 的 Rust 模块，也不读取其数据库；ModelPort 不读取 QuantPilot workspace 或用户记忆。两者仅通过受鉴权的 OpenAI-compatible HTTP 契约连接。

日常只读验收：

```bash
npm run check:integrations
```

该命令针对“Qwen + ModelPort DeepSeek + Memory”完整拓扑，会真实验证：

- Qwen 与 ModelPort DeepSeek 的限定模型 ID 均可发现；
- 错误凭据被拒绝；
- 两个模型的流式 function tool call、usage、finish reason 和 tool result 续写完整；
- Qwen Query Rewrite 确实调用大模型，并保持“大位科技”和 dashboard 输出意图；
- Evolvable User Memory 的版本化契约和 readiness 可用。

命令会产生真实模型 Token，但不写 Memory；只输出模型 ID、状态和 Token 计数，不输出 API Key、原始记忆正文或模型完整回复。Qwen-only、官方 direct-only 或 Memory-disabled 环境缺少未启用组件是预期结果，应分别检查实际启用的端点，不把 `check:integrations` 当作这些精简拓扑的统一健康门。

要同时验证 agent-knowledge-platform 以及模型实际组合 Memory/Knowledge 后的效果，运行：

```bash
npm run check:triad-experience
```

该固定 30 题集额外覆盖 AKEP 自然语言检索、Citation、Usage/Feedback 幂等回执，以及 Qwen/DeepSeek 对两类上下文的选择性应用；报告落在 `tmp/triad-experience-latest.json`。

## 修改或新增 Profile

长期配置入口是：

- `config/llm.json`：模型、QuantPilot 侧 provider、Base URL、凭据变量和 Query Rewrite 参数；
- `src/lib/constants/models.ts`：UI 模型注册表、显示名和别名；
- `src/lib/agent/providers/`：QuantPilot wire adapter；
- ModelPort `config.toml`：上游 provider 协议、模型目录和上游凭据环境变量。

修改后运行：

```bash
npm run check:ai-provider-boundary
npm run type-check
npm run check:integrations
```

Base URL 必须是固定受信地址。不要从前端请求或普通项目配置透传任意 Base URL，也不要让 QuantPilot 读取 ModelPort 上游密钥。
