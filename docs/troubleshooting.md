# 故障排查

## 先分层

遇到问题时先判断是哪一层，不要一上来就重启所有服务。QuantPilot 的问题大多可以落在这几层：

| 层 | 典型现象 | 第一入口 |
| --- | --- | --- |
| 环境层 | 端口打不开、CLI 找不到、数据库不可达 | `npm run doctor`、`/ops-platform` 基础环境 |
| 数据层 | K 线为空、成交额缺失、补数很慢 | 策略平台补数弹窗、market-data 日志 |
| 生成层 | Agent 报错、达到最大轮数、页面没生成完 | 项目聊天页、生成链路观测 |
| 契约层 | 产物缺失、验证失败、证据不完整 | 工作空间健康、`.quantpilot/*.json` |
| 视觉层 | 页面能打开但难看、溢出、图表空白 | Playwright 截图、视觉检查报告 |
| 评测层 | CI 或评测平台失败 | 评测报告、运行队列、失败修复 |

如果判断不出来，按“环境、数据、契约、页面、skill”的顺序排查。这个顺序通常比直接改页面更省时间。

配置问题先看[配置、模型接入与可选组件指南](configuration.md)。运行时优先级是“进程环境 > `.env.local` > `.env`”；容器或 shell 中遗留的同名变量会覆盖文件。不要靠复制整份 `.env.example` 排障，它会增加重复配置。

## 一键诊断

优先运行：

```bash
npm run doctor
```

它会快速检查：

- Node、npm、uv 版本。
- 默认本地 Qwen Provider 凭据，以及可选 DeepSeek 官方 API Key。
- 项目内置 Agent 执行引擎。
- 前端 `3000` 和后端 `8000` 可达性。
- PostgreSQL / TimescaleDB、Loki 可观测性和降级配置。
- workspace 目录。
- Skills 注册表、lock 和压缩包一致性。
- 生成产物策略。
- 验证修复契约。
- benchmark 覆盖。
- eval 定时器。
- 最近评测报告。

提交前或排查复杂问题时运行完整诊断：

```bash
npm run doctor:full
```

完整诊断会额外运行 `lint`、`type-check`、后端 `ruff` 和后端 `pytest`。

如果本机没有启动部分组件，可通过 `.env` 控制降级：

```bash
QUANTPILOT_DEGRADATION_MODE=offline npm run doctor
```

`offline` 会跳过市场数据后端、Memory、Loki/Grafana/Alloy 和 Redis 等可选外部探测；`auto` 适合本地开发；`strict` 适合 CI 或生产巡检。只想关闭 Memory 时使用 `QUANTPILOT_MEMORY_ENABLED=0`，不要切换整个系统到 `offline`。

前端开发启动还有一个恢复保护：如果曾经用降级方式启动，但下一次启动时数据库、market-data、Redis 或 Loki 已经恢复，`npm run dev` 会在本次进程里切回 `auto` 和启用状态。只有确实要保留降级时才加：

```bash
QUANTPILOT_AUTO_RESTORE_DEGRADATION=0 npm run dev
```

## 3000 端口被占用

```bash
lsof -i :3000
ss -ltnp | grep ':3000'
```

释放端口后重新执行：

```bash
npm run dev
```

主前端应优先使用：

```text
http://localhost:3000
```

`npm run dev` 会优先尝试 `3000`，占用时在 `3000-3099` 内选择可用端口，并把 `PORT`、`WEB_PORT`、`NEXT_PUBLIC_APP_URL` 写回 `.env` / `.env.local`。如果你只是临时排障，可以让它自动换端口；如果要给别人演示或跑截图，建议先释放 `3000`。

## 前端启动模式异常

当前前端启动链路是：

```text
npm run dev -> scripts/dev/run-full.js -> scripts/dev/run-web.js -> npx next dev
```

启动器只负责环境、端口、稳定 CSS、Prisma 检查和 Next dev 缓存保护；不再接入 `next-rspack`，也不再读取 `QUANTPILOT_BUNDLER` 做 bundler 切换。

如果启动日志看起来混乱，先确认依赖和缓存：

```bash
npm install
rm -rf .next/dev/cache/webpack .next/dev/lock
npm run dev
```

如果日志里仍出现 `next-rspack`、`QUANTPILOT_DISABLE_RSPACK` 或 Rspack panic，说明本机依赖或旧启动进程没有清干净。先停止旧进程，再确认 `package.json` 中没有 `next-rspack` 依赖。

## 8000 后端不可用

```bash
curl http://127.0.0.1:8000/health
```

如果没有响应：

```bash
cd services/market-data
uv sync --extra baostock --extra akshare
uv run quantpilot-market-api
```

如果只是浏览平台页面而不需要实时行情，可临时关闭市场数据后端探测：

```bash
QUANTPILOT_MARKET_API_ENABLED=0 npm run doctor
```

## Loki / Grafana 不可用

启动本地可观测性组件：

```bash
npm run obs:up
```

默认入口：

```text
Loki: http://127.0.0.1:33100
Grafana: http://localhost:33012
Alloy: http://localhost:12345
```

如果不需要集中日志，可保持 Loki 停止。运行治理中心会降级读取本地日志文件；`npm run doctor` 在 `auto` 模式下只给 warning，不会失败。

## 默认 ModelPort Qwen 未就绪

确认 ModelPort 监听 `http://127.0.0.1:38082/v1`，并在 QuantPilot `.env.local` 中配置它签发的受限客户端 Key：

```dotenv
MODELPORT_API_KEY="your-scoped-modelport-client-key"
```

默认 profile 固定为 `local_qwen:qwen3.5-9b-q5km`。可先请求 `/v1/models` 验证鉴权；`401` 表示服务已连通但客户端 Key 未被接受，`403` 表示 Key 未获准访问该 provider/model。配置修改后重启 QuantPilot。新项目和未显式指定模型的 Query Rewrite 会自动使用 Qwen。

## 日常 ModelPort DeepSeek 未就绪

确认 ModelPort 自身运行环境包含 DeepSeek 上游 Key，QuantPilot 不保存该 Key：

```dotenv
DEEPSEEK_ANTHROPIC_AUTH_TOKEN="your-deepseek-upstream-key"
```

ModelPort `deepseek` provider 必须使用 `protocol = "anthropic"`、Base URL `https://api.deepseek.com/anthropic`，并公布 `deepseek:deepseek-v4-flash`。QuantPilot 的 `MODELPORT_API_KEY` 还必须获准访问 `deepseek` provider 和该限定模型。管理台“查询余额”成功但模型请求失败时，重点检查协议/工具兼容；余额查询失败时检查上游 Key 与 DeepSeek 账户状态。

只有显式选择 `deepseek-v4-flash` 官方直连 profile 时，QuantPilot 运行环境才需要注入 `DEEPSEEK_API_KEY`；默认本地使用不配置它。

## DeepSeek 官方直连失败

先确认项目选择的是 `deepseek-v4-flash`，不是带命名空间的 `deepseek:deepseek-v4-flash`。前者直连官方，后者经过 ModelPort。再检查当前 QuantPilot 进程能否读取：

```bash
test -n "${DEEPSEEK_API_KEY}" && echo configured || echo missing
```

如果 Key 写在 `.env.local`，修改后必须重启 QuantPilot。官方直连不读取 `MODELPORT_API_KEY` 或 `DEEPSEEK_ANTHROPIC_AUTH_TOKEN`；也不会访问 `127.0.0.1:38082`。完全不运行 ModelPort 时，还要把账号/新项目默认模型显式改为官方直连，否则代码级默认 Qwen 的连接失败是预期行为。

可直接请求 `https://api.deepseek.com/chat/completions` 区分官方鉴权问题与 QuantPilot 运行问题；该验证会产生真实 Token 费用，示例见[模型 Provider 接入](model-providers.md#deepseek-官方直连不走-modelport)。

然后重启并检查：

```bash
npm run dev
npm run check:models
```

## 生成页面没有真实行情

先确认后端可用：

```bash
curl "http://127.0.0.1:8000/api/v1/quotes/realtime/600519"
```

再检查生成项目中是否存在：

```text
.moagent/skills/
.quantpilot/run_plan.json
.quantpilot/generation-state.json
.quantpilot/generation-queue.json
data_file/final/dashboard-data.json
evidence/sources.json
evidence/data_quality.json
```

如果这些文件都存在，但页面仍然没有真实行情，再看 `data_file/final/dashboard-data.json` 里是否真的有目标标的和足够样本。很多“页面问题”其实是 final data 只写了一天数据，或者字段名和页面绑定字段不一致。

## 可视化页面只有静态文案

通常说明取数、final 数据文件或 `dashboard-visualization` 没有完整执行。优先查看：

- 聊天页执行过程。
- `/ops-platform` 工作空间健康。
- `/ops-platform` 链路观测。
- `.quantpilot/events.jsonl`。
- `.quantpilot/validation.json`。
- `.quantpilot/validation-repair-plan.json`。
- `.quantpilot/artifact-contracts.json`。
- `.quantpilot/visual-validation.json`。

## 生成链路卡在运行中

检查：

```text
.quantpilot/generation-state.json
.quantpilot/generation-queue.json
```

如果用户已取消请求但队列仍显示 running，优先查看：

- PostgreSQL `agent_generation_jobs` 中该 request 的 `status`、`lease_expires_at`、`fencing_token` 和 `error_code`；这是权威状态，workspace JSON 只是投影。
- `agent_generation_outbox_events` 中同一 job 的 sequence 是否连续，以及 `published_at` 是否仍为空；未发布事件会在下一次状态读取时重投影。
- `POST /api/chat/<project_id>/pause`
- `/ops-platform` 中的 active request。
- `.quantpilot/events.jsonl` 中最近的 queue 事件。

如果数据库 job 已是 `cancelled`、`failed` 或 `interrupted`，但 JSON 仍显示 running，不要手改文件；重新读取项目状态触发投影修复。`DISPATCH_LEASE_EXPIRED_REPLAN_REQUIRED` 表示旧 worker 的细粒度 lease 也已失活，系统已封存旧 attempt，需要新请求基于当前 workspace 重规划。

## 自动验证失败后没有修复

检查：

- `.quantpilot/validation.json` 是否存在。
- `.quantpilot/validation-repair-plan.json` 是否生成。
- `.quantpilot/generation-state.json` 中 `repairAttemptCount` 是否增加。
- Agent runtime 是否已被取消。
- `npm run check:validation-repair` 是否通过。

## Playwright 检查时页面可见但点击无效

优先使用：

```text
http://localhost:3000
```

项目已在 `next.config.js` 中允许 `127.0.0.1` 作为本地 dev origin，但日常浏览和截图仍推荐使用 `localhost`。

## Skills 发布后生成项目仍使用旧版本

检查：

```bash
npm run check:skills
npm run package:skills
```

确认这些文件有同步更新：

```text
.claude/skills.registry.json
.claude/skills.lock.json
.claude/skills.changelog.json
.claude/skill-packages/<skill-id>.tgz
```

这里的 `.claude/**` 表示仓库根目录保留的 Skill 源兼容区，也是当前 Agent 的 source-first 编译输入，并不表示已经使用密码学签名。MoAgent 会校验 registry、lock、版本与 SHA-256；只有 source 缺失时才回退受校验 tgz。项目初始化把适配后的内容配置为生成工作空间 `.moagent/skills/` 参考镜像，Agent 执行阶段不会从 workspace 镜像发现能力，也不会重新安装 Skill。

## MoAgent 提示 workspace resource lock 被占用

`<workspace>/.moagent-workspace.lock/owner.json` 是 fail-closed 的物理写锁。它包含 `instanceId`、`hostname`、`pid`、`purpose`，以及适用时的 `projectId`、`requestId`、`runId`、`operationId`；容器环境应设置 `MOAGENT_INSTANCE_ID` 为可定位的 pod/instance ID。

MoAgent 启动恢复会处理一个严格子集：`owner.json` 必须是 schema v2、`hostname` 与当前主机完全一致，且操作系统确认 PID 已不存在；框架会先原子隔离旧锁，再依据 durable mutation journal 和数据库 ledger 回滚 `prepared/commit_authorized` workspace write。它不会按 `acquiredAt` 猜测，也不会接管远端、存活、损坏或身份不明的 owner。其余情况按下面顺序处理：

1. 暂停该 project 的新 generation，并 drain 所有可能挂载同一 workspace 的应用实例。
2. 读取 `owner.json`，在对应 instance/host 确认进程与 run 已停止；如果实例不可达，按崩溃现场处理。
3. 在 PostgreSQL 查询该 project/run 的 `agent_runs`、`agent_workspace_leases` 和 `agent_tool_executions`，重点检查 `prepared`、`commit_authorized`、`uncertain` 的 workspace/external write。
4. 检查 `.moagent-mutation-journal`、operation receipt、before/after SHA-256 和目标当前 hash。用户后续修改冲突、`uncertain`、external write 或缺少可靠 journal 时保持阻断，不要重放。
5. 只有确认没有存活 writer，且所有相关未决 operation 已通过受控人工流程完成调和后，才能移除孤儿锁目录并重新发起一个全新的 replan run。

当前自动调和只覆盖 MoAgent typed workspace writer 的同主机死亡 owner 与 v1 journal。删除锁本身不会清除数据库中的未决 ledger；远端实例、external/uncertain operation 仍是人工应急路径。在目标共享卷多主机断电验收和平台级 generation coordinator 完成前，不要让多个应用实例并发运行同一 project 的完整 generation pipeline。

## 策略补数看起来卡住

先确认它是“卡住”还是“正在低频推进”。补数任务会因为外部源限速、请求延迟和本地 preflight 跳过而显得慢。

优先看：

- 策略平台补数弹窗里的心跳、当前标的、完成批次和预计完成时间。
- market-data 后端日志中是否持续出现 ingestion job 更新。
- `quant.market_data_ingestion_jobs` 里 parent job 的 `status`、`completed_symbols`、`rows_upserted` 和 `metadata.last_heartbeat_at`。

如果本地已有完整数据，后端会返回 `skipped`，`skip_reason=local_coverage_ready`。这代表本地覆盖已满足目标，不需要再拉外部接口。

## 日志太多不知道看哪条

先缩时间范围，再搜关键词。常用关键词：

```text
error
failed
validation
artifact
ingestion
timeout
Reached maximum
```

Loki 可用时优先在运行治理中心日志页查集中日志；Loki 不可用时查看本地文件日志。Next dev 的编译成功日志很多，通常可以先忽略，重点看红色错误、API 失败、SSE 断连和 Agent runtime 返回的错误。

## Memory 已启动但聊天没有个性化

如果 `QUANTPILOT_MEMORY_ENABLED=0`，`personalization.status=disabled` 是正常结果，不需要启动 Memory 或继续排查 URL/token。`REQUIRED=0` 则不是关闭：服务健康时仍会召回，异常时状态为 `unavailable` 并允许核心任务继续。

先把“服务存活”“契约兼容”和“有匹配偏好”分开检查：

```bash
curl -fsS http://127.0.0.1:38089/
curl -fsS http://127.0.0.1:38089/readyz
curl -fsS http://127.0.0.1:3000/api/ready
npm run doctor
```

根路径必须包含 `api_contract=evolvable-memory-http/v1`，`/readyz` 必须是 `ready`，QuantPilot readiness 中的 `memory` 组件必须是 `ok`。根路径返回 200 但没有 `api_contract`，通常说明旧进程或旧镜像未重启；重新构建或重启 Memory 后再验证。

服务健康但消息 metadata 为 `personalization.status=empty` 时，检查是否真的写入了允许的 `analysis.*`、`output.*` 或 `research.*` 键，`context.product` 是否为 `quantpilot`，项目级偏好的 `project_id` 是否与当前项目一致。`prepared` 表示候选偏好已通过过滤，但只有最终回复显示“本轮实际使用了 N 条个人偏好”才证明 capsule 真正进入 Agent；澄清、拒绝和平台直出不会产生可反馈归因。`unavailable` 表示可选集成已降级，核心任务会继续；具体 API 示例、状态解释和 Outcome 归因规则见[用户记忆服务接入、使用与效果验证](user-memory-integration.md)。
