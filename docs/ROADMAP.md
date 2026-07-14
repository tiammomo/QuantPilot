# QuantPilot 持续完善路线图

这份路线图用来回答一个朴素问题：项目已经能跑起来以后，下一步最值得把力气花在哪里。

它不是承诺清单，也不是把所有想法都塞进来。这里优先收录会明显提升可用性、可维护性、生成质量和投研数据能力的工作。更细的操作步骤仍放在对应专题文档或 runbook 里。

## 当前判断

QuantPilot 的主平台、市场数据后端、评测平台、策略平台和基础设施已经具备可用主链路。现在最大的风险不再是“有没有功能”，而是：

- 功能多，入口多，新同学不知道先看哪条路径。
- 生成工作空间历史健康度不够稳定，旧项目里仍有验证失败、视觉失败或产物契约失败。
- 策略平台和评测平台已经拆了一轮，但部分编排逻辑还偏重。
- 数据能力已经有 K 线、覆盖率、ClickHouse 短线筛选，但财报质量、真实资金流、行业中性化和日频因子批处理仍需补齐。
- 投研日报已经有观察池、报告契约、本地证据采样和企业微信/飞书/钉钉/Discord webhook adapter，后续要接新闻舆情源、LLM 摘要和定时 worker。
- 后台队列和长任务目前还没有完全 worker 化，长期运行、暂停恢复和失败重试仍需要继续收敛。

## 精炼优先级快照

文档不需要简单“删短”，需要压入口、去重复、把路线集中维护。代码不需要为了行数硬拆，需要优先拆职责最混杂、回归风险最高的文件。

| 类型 | 优先对象 | 当前问题 | 精炼方式 |
| --- | --- | --- | --- |
| 文档入口 | `README.md`、`docs/README.md`、`docs/START_HERE.md` | 容易重复导航 | 根 README 保留少量入口，docs README 做完整索引，START_HERE 做角色化导读 |
| 文档路线 | 各专题文档里的“后续建议” | 后续事项散落，读者不知道优先级 | 集中到本文，专题文档只保留本主题强相关下一步 |
| 生成脚手架 | `scaffold.ts`、`scaffold-base-templates.ts`、`scaffold-dashboard-templates.ts` | 基础模板和三类专用看板模板均已迁出并加入真实 Next build 门禁，writer 主文件从 5715 行降至约 685 行 | 继续拆 workspace writer、dependency planner、repair adapter，并压缩模板内部重复 helper |
| 聊天页面 | `src/app/[project_id]/chat/page.tsx`、`src/components/chat/ChatLog.tsx` | 页面状态、消息渲染、运行时控制和附件交互耦合 | 拆 hooks、message timeline、runtime controls、files panel |
| 验证链路 | `src/lib/quant/validation.ts` | build、HTTP、数据、证据、截图和 stale report 检查混杂 | 拆 validators、report writer、repair summary |
| 策略平台 | `src/lib/quant/strategies.ts`、`src/app/strategy-platform/*` | response mappers 已迁出并有单测，API client、dashboard 编排和部分页面交互仍集中 | 继续拆 market client、dashboard service、hooks、dialogs |
| 评测平台 | `src/lib/eval/runtime.ts` | report/database mappers 已迁出并有单测，runs、queue、repairs、schedule 仍在运行时入口 | 继续拆 runs、queue、repairs、schedule |
| 市场数据后端 | `models.py`、`api.py`、`repositories/universes.py` | 模型和兼容入口偏大，universe repository 同时处理读取、写入、清洗 | 按 contract domains、legacy routes、membership hygiene 拆小 |

## P0：先让项目更容易被理解和发布

| 工作 | 为什么重要 | 验收标准 |
| --- | --- | --- |
| 文档入口收敛 | `docs/` 文档很多，缺少角色化导读会让人迷路 | `README.md` 指向 `docs/START_HERE.md`；`docs/README.md` 和 learning 路径能回答“我该读哪篇” |
| 发布前检查脚本 | 已新增确定性 `release:check` 与包含依赖审计/运行态诊断的 `release:check:full` | 后续继续把关键 API、页面 smoke 和 workspace 健康摘要纳入运行态 profile |
| 文档路径检查 | 已新增 `check:docs`，当前覆盖根 README、docs、market-data 与 SQL 文档 | 继续扩展锚点校验和已知旧路径规则 |
| 工作空间健康分层 | 历史 workspace 失败不应和主平台故障混在一起 | 已在运行治理中心增加可演示/有风险/待修复/归档候选分层，后续接归档动作和批量修复 |
| 基础组件状态准确性 | 状态面板误报会削弱系统可信度 | Foundation status 已按 TimescaleDB chunk 统计行情和因子估算行数，后续继续补精确审计入口 |
| 生成生命周期准确性 | `needs_clarification`、排队、运行、修复不能被统计成失败 | 健康度按生命周期分层，仅终态任务进入交付成功率；等待输入给出明确下一步 |
| 生成任务持久化 | 规划和预取也可能并发覆盖，长任务不能依赖请求进程 | 从请求入队开始串行执行，支持 request/run 级取消、幂等、恢复和终态 CAS |
| 评测真实性分层 | 模板契约通过不等于模型生成通过 | contract 与 DeepSeek E2E 报告明确分开，夜间 E2E 绑定 commit、prompt、Skills 和数据证据 |

对应文档：

- [文档导读](START_HERE.md)
- [文档写作风格指南](documentation-style-guide.md)
- [运行手册](operations-runbook.md)
- [运行治理中心使用与评分指南](ops-platform-guide.md)

## P1：继续强化生成结果质量

| 工作 | 为什么重要 | 验收标准 |
| --- | --- | --- |
| 生成后自动修复闭环 | 用户真正关心的是页面最终能不能用 | 验证失败后能产生 repair plan、实际修改页面/数据/证据，并重新跑验证 |
| 视觉验证稳定化 | 很多失败不是功能坏，而是页面空白、布局粗糙或移动端溢出 | Playwright 视觉 smoke 覆盖首页、生成工作空间、评测平台、策略平台关键视图 |
| 真实数据绑定强制化 | 防止“看起来生成成功但其实是 mock/占位数据” | artifact contract 能稳定识别 mock、远程资源、未绑定 final 数据和缺 evidence |
| 旧 workspace 分批修复或归档 | 历史失败项目会污染用户对平台稳定性的判断 | 历史 workspace 标记为 healthy/warning/failed/archived，失败原因可追踪 |

对应文档：

- [AI 工作空间生成链路](learning/02-ai-workspace-generation.md)
- [Skills 与可视化看板](learning/04-skills-and-visual-dashboard.md)
- [生成工作空间契约](generated-workspace-contract.md)
- [Agent 评测指南](evals-guide.md)

## P1：继续拆清楚策略平台和评测平台

| 工作 | 为什么重要 | 验收标准 |
| --- | --- | --- |
| 策略平台 hooks 和 dialogs 拆分 | 主 client 仍承载部分弹窗和扫描编排 | `StrategyPlatformClient` 只负责顶层状态和视图切换，补数、K 线详情、扫描任务各有 hook/service |
| 策略数据 service 拆分 | `strategy-mappers.ts` 已迁出并补齐纯函数单测，`strategies.ts` 仍是稳定 public surface | 继续拆出 market client、dashboard service，保留现有导出兼容 |
| eval runtime 拆分 | report/database mappers 已迁入 `runtime-mappers.ts` 并补单测，runtime 已降至约 955 行 | 继续拆出 `runs.ts`、`queue.ts`、`repairs.ts`、`schedule.ts` |
| 模块边界预算收紧 | 当前大文件预算允许过渡，但不能长期放宽 | `npm run check:module-boundaries` 保持通过，大文件目标线逐步下降 |

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
| ClickHouse 分析层扩展 | 短线筛选已接入并完成聚合下推，后续需要更完整分析宽表 | 分析表有 freshness gate、同步状态、回退说明、特征缓存和数据质量元信息 |

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
| Redis 任务状态和锁 | 跨进程任务需要短期状态、锁和进度快照 | Redis 承载进度和锁，PostgreSQL 保存事实状态和最终结果 |
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
