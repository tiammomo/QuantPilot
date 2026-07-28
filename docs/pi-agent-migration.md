# PI Agent 采用与治理边界

QuantPilot 的唯一 Agent 执行框架是开源
[earendil-works/pi](https://github.com/earendil-works/pi)。PI Agent 负责模型与工具之间的
完整多轮循环；QuantPilot 负责产品权限、副作用治理、持久化、并发、预算和交付验收。
项目不保留第二套 Agent loop、旧品牌兼容入口或旧配置回退。

## 当前版本

| 项目 | 当前值 |
| --- | --- |
| 上游仓库 | `earendil-works/pi` |
| Agent runtime | `@earendil-works/pi-agent-core@0.82.1` |
| 模型与流类型 | `@earendil-works/pi-ai@0.82.1` |
| Durable framework identity | `pi-agent:0.82.1` |
| Node.js | `>=22.19.0` |

两个上游依赖使用相同精确版本，`package-lock.json` 是传递依赖事实源。版本常量位于
`src/lib/agent/pi/identity.ts`。升级时必须同时更新依赖、锁文件、身份常量、上游边界检查
和测试，不能使用浮动版本。

## 唯一命名合同

| 边界 | 合同 |
| --- | --- |
| 产品 CLI ID | `pi` |
| 产品展示名 | `PI Agent` |
| TypeScript 公共符号 | `PiAgent*` |
| 活动模块文件 | `pi-agent-*` |
| 环境变量 | `PI_AGENT_*` |
| Skill 权威根目录 | `.pi/` |
| Skill capsule 配置 | `config/pi-agent-skill-capsules.json` |
| 工具结果元数据 | `$piAgent` |
| Candidate source | `pi_agent_submit_result` |
| Framework identity | `pi-agent:<version>` |

设置、消息、任务信封、评测报告和 API 响应只接受并输出规范值，不做旧值归一化。活动源码、
配置、测试和文档由自动检查禁止旧框架名称；已部署过的 Prisma 历史迁移是不可变审计记录，
不允许通过改名或改内容破坏 migration name 与 checksum。

## 实际执行路径

```text
HTTP / Generation Worker
  -> Data Agent Profile + Domain Pack + Delivery Pack
  -> QuantPilot Skills、Mission 与类型化工具
  -> PiAgentRunEngine
       -> QuantPilot messages/context -> PI `AgentContext`
       -> runAgentLoopContinue(...)
            -> QuantPilot Provider adapter -> PI StreamFn
            -> PI `AgentTool` adapter -> governed tool executor
       -> PI events/messages -> durable public events/result
  -> Delivery validation
  -> EvidenceVerifier accepted receipt
```

`src/lib/agent/pi/run-engine.ts` 直接调用并完整等待上游
`runAgentLoopContinue(...)`。PI 负责 assistant turn、工具调用、工具结果回注和后续 turn，
直到 loop 结束。项目已删除原有自定义多轮 Run Engine；不得再引入另一套
`while provider -> tool -> provider` 状态机。

Provider adapter 把 QuantPilot 的 ModelPort、本地 Qwen、受控 DeepSeek 和确定性测试
Provider 转成 PI `StreamFn`。Tool adapter 把 `PiAgentTool` 转成 PI `AgentTool`，并按以下
顺序执行：

```text
PI tool call
  -> schema validation
  -> QuantPilot approval policy
  -> durable prepare-before-effect ledger
  -> typed tool execution
  -> durable outcome
  -> PI tool result
```

审批编辑后的输入必须使用同一 schema 再验证。副作用结果不确定、durable 写入失败、重复
tool-call ID、超出工具/字符/Token 预算或 terminal batch 不合法时，当前 run 必须立即
失败关闭，不能继续执行同批次后续工具。

## 治理边界

| 层 | 责任 |
| --- | --- |
| PI Agent core | 多轮 loop、assistant/tool 消息流、结果回注、hook、取消 |
| QuantPilot Agent 治理 | Context Manager、预算、收敛、工具允许列表、审批、operation ID |
| Durable runtime | Job/outbox、Worker claim、lease、heartbeat、fencing、公开事件、checkpoint |
| Profile / Domain Pack | Skills、领域工具、实体与数据规则、Mission Definition |
| Delivery / EvidenceVerifier | 产物验证、冻结 evidence、accepted receipt、业务完成态 |

PI 不提供内建权限系统。能够被 PI 调用的工具仍必须通过 QuantPilot 的 schema、路径、
权限、审批、资源锁和副作用 ledger。项目不启用 PI Coding Agent 的通用 Shell、默认文件
工具、扩展自动发现或 session 文件恢复。

PI `agent_end` 只结束一次物理 loop。业务请求只有在当前 candidate version 通过 Delivery
validation，并由 EvidenceVerifier 在事务中写入 accepted receipt 后才能进入
`completed`。

## 恢复与隐私

Durable runtime 只保存安全公共事件、operation、用量、状态和 `replan_required`
checkpoint，不保存 Provider 私有 session、完整 prompt、hidden reasoning、原始工具参数
或原始工具结果。

Worker 丢失后的固定规则：

1. lease/fencing 关闭旧 attempt；
2. 结果不确定的 mutation 先调和，禁止盲目重放；
3. 新 attempt 从持久化 Task、Plan、Skills、Mission 和 evidence 重新规划；
4. 之前的批准不能授权新 tool call。

## 升级与验收

升级 PI 前必须核对上游 Node 要求、`runAgentLoopContinue` 签名、事件类型、消息类型、
tool hook 和 usage 口径。最低验收：

```bash
npm run type-check
npm run lint
npm run test:unit
npm run test:backend
npm run check:ai-provider-boundary
npm run check:skills
npm run check:docs
npm run build
```

涉及工具、恢复或持久化时，还必须覆盖取消、审批等待、编辑后再验证、工具失败、Token 上限、
mutation 不确定结果、Worker takeover、Mission receipt 和 candidate lineage。
