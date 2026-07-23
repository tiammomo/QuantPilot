# QuantPilot 持续完善路线图

这份路线图用来回答一个朴素问题：项目已经能跑起来以后，下一步最值得把力气花在哪里。

它不是承诺清单，也不是把所有想法都塞进来。这里优先收录会明显提升可用性、可维护性、生成质量和投研数据能力的工作。更细的操作步骤仍放在对应专题文档或 runbook 里。

## 当前判断

QuantPilot 的主平台、市场数据后端、评测平台、策略平台和基础设施已经具备可用主链路。现在最大的风险不再是“有没有功能”，而是：

- 功能多，入口多，新同学不知道先看哪条路径。
- 生成链路已具备自动验证与修复，但仍需用持续新建的回归工作空间控制模型、模板和数据变化带来的漂移。
- 策略平台和评测平台已经拆了一轮，但部分编排逻辑还偏重。
- 数据能力已经有 K 线、覆盖率、ClickHouse 短线筛选，但财报质量、真实资金流、行业中性化和日频因子批处理仍需补齐。
- 投研日报已经有观察池、报告契约、本地证据采样和企业微信/飞书/钉钉/Discord webhook adapter，后续要接新闻舆情源、LLM 摘要和定时 worker。
- generation 已由 PostgreSQL job/outbox 和独立 Worker 执行；评测、策略扫描和补数仍需统一暂停、恢复、失败重试与事件语义。
- 本地 Qwen 与 DeepSeek Anthropic 上游已通过 ModelPort 的限定模型发现、鉴权、流式工具调用和续写验收；ModelPort 已为 OpenAI Chat Completions 应用本地 Qwen 默认思考策略，避免工具任务耗尽隐藏推理预算。Query Rewrite 已升级为 schema v4 LLM-first 合同，保持“大位科技”等原文实体，并在模型不可用时停止规划/预取，不再走关键词语义降级。Evolvable User Memory 已通过隔离 subject 的写入、召回、项目隔离、提示注入和 Outcome 闭环；AKEP 已通过自然语言检索、Citation、Usage 与 Feedback 幂等闭环。服务级固定 30 题体验集连续两轮 60/60 通过；任务级 campaign 进一步以 24 个 Qwen、6 个 ModelPort DeepSeek 的真实 Project 验证 `/act`、Workspace、Validation、Mission receipt、持久预览和任务抽屉，最终 30/30 READY。当前本地长期使用链路已打通；Memory 的持久治理、耐久审计、可信 JWT 和 production profile 仍是生产阻塞项。

## 精炼优先级快照

文档不需要简单“删短”，需要压入口、去重复、把路线集中维护。代码不需要为了行数硬拆，需要优先拆职责最混杂、回归风险最高的文件。

| 类型 | 优先对象 | 当前问题 | 精炼方式 |
| --- | --- | --- | --- |
| 文档入口 | `README.md`、`docs/README.md` | 容易重复导航 | 根 README 保留启动入口，docs README 同时承担角色导读和完整索引 |
| 文档路线 | 各专题文档里的“后续建议” | 后续事项散落，读者不知道优先级 | 集中到本文，专题文档只保留本主题强相关下一步 |
| 生成脚手架 | `scaffold.ts`、`scaffold-base-templates.ts`、`scaffold-dashboard-templates.ts` | 基础模板和三类专用看板模板均已迁出并加入真实 Next build 门禁，writer 主文件从 5715 行降至约 685 行 | 继续拆 workspace writer、dependency planner、repair adapter，并压缩模板内部重复 helper |
| 聊天页面 | `src/app/[project_id]/chat/page.tsx`、`src/components/chat/ChatLog.tsx` | 页面状态、消息渲染、运行时控制和附件交互耦合 | 拆 hooks、message timeline、runtime controls、files panel |
| 验证链路 | `src/lib/quant/validation.ts` | build、HTTP、数据、证据、截图和 stale report 检查混杂 | 拆 validators、report writer、repair summary |
| 策略平台 | `src/lib/quant/strategies.ts`、`src/app/strategy-platform/*` | response mappers 已迁出并有单测，API client、dashboard 编排和部分页面交互仍集中 | 继续拆 market client、dashboard service、hooks、dialogs |
| 评测平台 | `src/lib/eval/runtime.ts` | report/database mappers 已迁出并有单测，当前约 1071 行，runs、queue、repairs、schedule 仍在运行时入口 | 继续拆 runs、queue、repairs、schedule |
| 市场数据后端 | `models.py`、`api.py`、`repositories/universes.py` | contracts 和应用装配偏大，universe repository 同时处理读取、写入、清洗 | 按 contract domains、routers、membership hygiene 拆小；旧 `database.py` 门面已删除 |

## P0：先让项目更容易被理解和发布

| 工作 | 为什么重要 | 验收标准 |
| --- | --- | --- |
| 文档入口收敛 | `docs/` 文档很多，重复导读会让规则分叉 | `README.md` 指向 `docs/README.md`；同一页和 learning 路径能回答“我该读哪篇” |
| 发布前检查脚本 | 已新增确定性 `release:check` 与包含依赖审计/运行态诊断的 `release:check:full` | 后续继续把关键 API、页面 smoke 和 workspace 健康摘要纳入运行态 profile |
| 文档路径检查 | 已新增 `check:docs`，当前覆盖根 README、docs、market-data 与 SQL 文档 | 继续扩展锚点校验和已知旧路径规则 |
| 工作空间健康分层 | 历史 workspace 失败不应和主平台故障混在一起 | 已在运行治理中心增加可演示/有风险/待修复/归档候选分层，后续接归档动作和批量修复 |
| 基础组件状态准确性 | 状态面板误报会削弱系统可信度 | Foundation status 已按 TimescaleDB chunk 统计行情和因子估算行数，后续继续补精确审计入口 |
| 生成生命周期准确性 | `needs_clarification`、排队、运行、修复不能被统计成失败 | 健康度按生命周期分层，仅终态任务进入交付成功率；等待输入给出明确下一步 |
| 生成任务持久化 | 规划和预取也可能并发覆盖，长任务不能依赖请求进程 | 从请求入队开始串行执行，支持 request/run 级取消、幂等、恢复和终态 CAS |
| 评测真实性分层 | 模板契约通过不等于模型生成通过 | contract 与 DeepSeek E2E 报告明确分开，夜间 E2E 绑定 commit、prompt、Skills 和数据证据 |
| 长期集成契约门禁 | ModelPort、Memory、AKEP 独立升级后不能靠人工聊天猜兼容性 | `npm run check:integrations` 做基础只读验收；`npm run check:triad-experience` 固定 30 题覆盖语义、回执和组合回答；不共享源码或数据库 |
| 跨平台项目空间隔离 | 后续多个产品共享基础设施时，不能共享身份、账本、偏好或项目知识 | 已建立 Consumer + Workspace 两层作用域、API Key 绑定、Memory tenant/facet 边界、shared + project Space 白名单和 scope digest；新产品接入必须通过伪造 scope、跨 tenant/Space 与重放负向测试 |
| Query Rewrite 单一语义入口 | 关键词旁路会让模型配置正确时仍执行错误标的/周期 | schema v4、Provider 边界检查和单测共同保证 LLM-first；Resolver 只核验身份；模型失败时不进入 run plan/预取 |
| 任务终态与修复竞态 | 中间 Validation 失败不能抢先终止仍在运行的自动修复 | `pending/running/repairing` 始终保持非终态；只有编排完成或失败后才发布 ready/failed；任务级 E2E 原记录重试并复核 30/30 |

对应文档：

- [文档总览与角色路径](README.md)
- [文档写作风格指南](documentation-style-guide.md)
- [运行手册](operations-runbook.md)
- [运行治理中心使用与评分指南](ops-platform-guide.md)

## P1：继续强化生成结果质量

| 工作 | 为什么重要 | 验收标准 |
| --- | --- | --- |
| 生成后自动修复闭环 | 用户真正关心的是页面最终能不能用 | 验证失败后能产生 repair plan、实际修改页面/数据/证据，并重新跑验证 |
| 视觉验证稳定化 | 很多失败不是功能坏，而是页面空白、布局粗糙或移动端溢出 | Playwright 视觉 smoke 覆盖首页、生成工作空间、评测平台、策略平台关键视图 |
| 真实数据绑定强制化 | 防止“看起来生成成功但其实是 mock/占位数据” | artifact contract 能稳定识别 mock、远程资源、未绑定 final 数据和缺 evidence |
| 新工作空间持续回归 | 模型、模板和数据变化会造成生成质量漂移 | 每次关键变更新建隔离工作空间，保存 Mission/validation/preview 证据并按发布门禁判定 |

对应文档：

- [AI 工作空间生成链路](learning/02-ai-workspace-generation.md)
- [Skills 与可视化看板](learning/04-skills-and-visual-dashboard.md)
- [生成工作空间契约](generated-workspace-contract.md)
- [Agent 评测指南](evals-guide.md)

## P1：继续拆清楚策略平台和评测平台

| 工作 | 为什么重要 | 验收标准 |
| --- | --- | --- |
| 策略平台 hooks 和 dialogs 拆分 | 主 client 仍承载部分弹窗和扫描编排 | `StrategyPlatformClient` 只负责顶层状态和视图切换，补数、K 线详情、扫描任务各有 hook/service |
| 策略数据 service 拆分 | `strategy-mappers.ts` 已迁出并补齐纯函数单测，`strategies.ts` 仍是稳定 public surface | 继续拆出 market client、dashboard service；调用方只使用新的显式 public surface，不保留旧路径转发层 |
| eval runtime 拆分 | report/database mappers 已迁入 `runtime-mappers.ts` 并补单测，runtime 当前约 1071 行 | 继续拆出 `runs.ts`、`queue.ts`、`repairs.ts`、`schedule.ts` |
| 模块边界预算收紧 | 当前大文件预算允许过渡，但不能长期放宽 | `npm run check:module-boundaries` 保持通过，大文件目标线逐步下降 |
| Chat Act Use Case 拆分 | 请求合同和附件层已完成，主 route 仍承载鉴权、规划、预取和派发 | 继续拆 identity/quota、planning、prefetch、dispatch 四个应用服务；route 降到 1400 行目标线 |

对应文档：

- [模块边界与模块化单体治理](module-boundaries.md)
- [项目结构与分层边界](project-structure.md)
- [策略平台使用与设计指南](strategy-platform-guide.md)
- [评测、运维与质量门](learning/05-evaluation-and-operations.md)

## P1：补齐真正有投研价值的数据能力

| 工作 | 为什么重要 | 验收标准 |
| --- | --- | --- |
| 投研日报外部源扩展 | 日报只靠本地行情还不能覆盖新闻、公告和舆情变化 | 观察池日报支持至少一个企业新闻源或自建搜索源，evidence 写明来源和时间 |
| 推送通道运维化 | webhook adapter 已可用，但还缺配置页面和发送测试入口 | 页面可新增/禁用通道，支持测试发送，失败写入 delivery 错误 |
| 日频衍生因子批处理 | 现在很多指标仍查询时计算，影响分页和筛选扩展 | MA、强弱、波动、回撤、成交额放大倍数可批量写入因子表或截面 rank 表 |
| 估值和财报质量 | 中期持有和基本面看板需要真实财报因子 | ROE、毛利率、净利率、营收同比、净利润同比、现金流质量有稳定表和披露日口径 |
| 真实资金流 | 当前板块资金代理不能等价为主力净流入 | DDE/大单/主力净流入字段必须带 provider、更新时间、覆盖率和口径说明 |
| 行业中性化 | 估值、质量、动量跨行业裸比较容易误导 | 行业内 rank、行业中位数、行业成分历史或至少当前行业映射可用 |
| ClickHouse 分析层扩展 | 短线筛选已接入并完成聚合下推，基础组件已按预期交易日判定 stale/partial，后续需要更完整分析宽表 | 同步任务也以同一 freshness gate 驱动，补齐回退说明、特征缓存和数据质量元信息 |

对应文档：

- [市场数据与策略平台](learning/03-market-data-and-strategy-platform.md)
- [策略平台使用与设计指南](strategy-platform-guide.md)
- [投研日报自动化指南](research-automation-guide.md)
- [数据字典](data-dictionary.md)
- [行情数据源采集知识库](market-data-source-knowledge.md)

## P0-P1：把长任务和队列做得更稳

| 工作 | 为什么重要 | 验收标准 |
| --- | --- | --- |
| Worker 化 | 长任务不应长期依赖 Next.js 请求生命周期；该项已从 P2 提前 | 生成、评测、策略扫描、补数任务可由独立 worker 执行 |
| MoAgent 收敛 checkpoint | ProgressOracle 不能只存在于请求进程内 | 已完成 `progress_evaluated`、canonical-hash checkpoint v2、恢复前完整性校验和停滞状态投影；后续由 worker dispatcher 消费 replan 信号，而不是恢复旧 Provider session |
| Mutating tool 人工决策 | 外部发布、删除、通知等副作用不能只靠提示词约束 | 已完成 application-owned approval policy、公开输入投影、`waiting_for_external_input` checkpoint、approve/edit/reject/expire、项目授权 API 和崩溃后强制 replan；后续业务 Connector 按风险显式接入 |
| Mission 与外层编排接管 | 进程退出不能让任务永久占用，旧 worker 也不能晚到覆盖 | 已完成 Mission verification lease/fencing、项目级 generation lease，以及过期 dispatch 在细粒度 lease 全部失活后原子关闭 UserRequest/Mission 的 replan reconciliation |
| Durable dispatcher / outbox | `.data-agent/generation-queue.json` 只能做工作区投影，不能承担可靠派发 | 已完成 PostgreSQL job、claim/attempt/fencing、受限 execution envelope、事务 outbox、独立 polling worker、指数退避 replan、取消与崩溃封存；后续如引入 Redis，只把它用于可丢失唤醒 |
| 暂停、恢复、停止语义统一 | 当前不同任务类型语义容易不一致 | 所有长任务都明确 checkpoint、resume offset、stop grace 和失败重试 |
| 任务事件 outbox | 后续接 ClickHouse、日志或审计需要可重放事件 | 任务状态变化有事件记录，可用于运行治理中心和评测分析 |

对应文档：

- [基础设施配置](infrastructure.md)
- [运行手册](operations-runbook.md)
- [后端能力架构与持续优化边界](backend-capability-architecture.md)

## 暂时不建议做的事

| 事情 | 原因 |
| --- | --- |
| 为了“性能”立刻引入 Rust/Go | 当前瓶颈主要是 IO、外部数据源、缓存、批处理和任务组织，不是 Python 语言本身 |
| 引入 Dubbo3 或 Java 式注册中心 | 当前长期技术栈是 Python/Node，服务数量和部署形态还不需要重 RPC/注册中心 |
| 把策略平台整个拆成独立项目 | 现在更适合模块化单体；独立项目会增加共享类型、接口版本和部署复杂度 |
| 把所有 workspace 产物入库 | 大 JSON、截图、源码仍适合保留文件系统原件，数据库保存索引和摘要 |
| 用代理字段冒充真实资金流 | 成交额、涨跌占比可以做资金热度代理，但不能写成主力净流入或 DDE |

## 每次迭代的固定检查

```bash
npm run doctor:full
npm run build
npm run check:module-boundaries
cd services/market-data && uv run ruff check src tests && uv run pytest
```

如果改了页面体验，再加 Playwright 页面烟测；如果改了市场数据，再加覆盖率、ClickHouse health 和筛选器 smoke；如果改了生成链路，再加 artifact contract、visual validation 和至少一个 benchmark case。
