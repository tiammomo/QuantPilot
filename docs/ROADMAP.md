# QuantPilot 持续完善路线图

这份路线图用来回答一个朴素问题：项目已经能跑起来以后，下一步最值得把力气花在哪里。

它不是承诺清单，也不是把所有想法都塞进来。这里优先收录会明显提升可用性、可维护性、生成质量和投研数据能力的工作。更细的操作步骤仍放在对应专题文档或 runbook 里。

2026-09-18 Skills 专项：12 项内置技能统一强化执行合同与版本，15 个脚本纳入正反例行为门禁；运行规划移除关键词语义后备，指标修复跨区间相关性、零值估值和窗口缺失问题。可信 Market 增加搜索筛选、能力/兼容详情、版本历史、哈希下载与项目实际文件核验，移除重复编辑浮层和结构性就绪百分比。模型任务质量继续由独立 benchmark/生产回放验收。

## 当前判断

2026-09-06 价值复查的取舍：优先保留支撑“可信数据 → 可复现实验 → 持续研究 → 结果复盘”的能力，删除没有独立用户价值或已被替代的实现。检查覆盖前端/脚本导入图、69 个 Python 源码模块、依赖锁、启动与发布入口；静态可达只说明有调用方，不等同于用户在使用。

| 决策 | 本批处理与理由 |
| --- | --- |
| 删除重复交付链 | Electron 只打开现有 Web 页面，原生 IPC 无业务调用方；移除桌面壳、启动器和三平台打包配置，保留 Web 与 standalone 部署。 |
| 删除重复图标链 | 五处 UI 改为直接导入已在使用的 Lucide，删除 react-icons 依赖和三个包装文件，图标映射保持一致。 |
| 删除失联实现 | 清理仅旧测试引用的 Skills 注册表及其降级配置、未使用 Agent 聚合出口、fernet 类型声明、失效类型别名和 pnpm 占位配置；PI Agent 规范注册表、锁与包继续保留。 |
| 缩减依赖 | npm 锁内包条目从 1,038 降为 821（减少 217，约 21%）；本机安装占用减少约 180 MiB。HTTP 客户端未启用 HTTP/2，移除其三个间接包，同时消除 h2 的 CI 安全审计失败。 |
| 收敛产品入口 | 设置页删除过时的基础组件路线卡片，统一链接运行治理中心；停止在首页介绍中扩展非金融领域承诺。 |
| 保留核心约束 | 数据版本、证据、验证、评测、审批、fencing、outbox 和沙箱直接支撑结果可信与任务恢复，不因代码量大而删除。 |
| 按需运行基础组件 | TimescaleDB 保留权威数据；Redis 缓存、ClickHouse 分析投影和 Loki/Grafana/Alloy 按用途启用，均通过本地 Docker 管理。已有业务数据和卷保留。 |

本批没有新增控制台或 Provider。后续优先削减聊天状态、策略编排与模板重复逻辑，并用实际研究完成率和复用率判断低使用率入口是否合并；因子批处理、组合实验与复盘模型仍按下方路线推进。

2026-09-06 接续模块化：聊天页从 3,498 行降到2,359 行，预览终态控制器、验证读取、分栏交互、发布生命周期与发布弹窗已独立，永久关闭的旧发布浮层已删除。控制器按项目和请求隔离异步响应，显式停止后不会被旧状态重新打开，重复 ready 轮询不再抢回文件编辑视图；发布轮询串行执行并随组件退出取消，立即发布成功和失败重试都会释放 loading。策略主模块从 1,150 行降到 357 行，市场传输、业务 API、研究状态和默认数据分离，调用方直接导入类型与对应能力；请求超时覆盖响应正文。比较、选股、持仓三个模板复用资产读取和涨跌色彩 helper，生成源码逐字节不变。聊天主文件预算收紧到 2,400 行，策略主文件收紧到 400 行；聊天消息提交、模型偏好及更多布局仍待拆分。

请求活跃状态也已独立：网络异常、HTTP 错误和格式异常保留最后已知状态；旧响应不能覆盖新提交，完成事件须等待服务端确认空闲，避免补充要求队列提前发送。轮询串行执行，活跃时由 0.5 秒调整为前次完成后等待 1.5 秒，后台标签页暂停，恢复可见时立即查询。

QuantPilot 的主平台、市场数据后端、评测平台、策略平台和基础设施已经具备可用主链路。现在最大的风险不再是“有没有功能”，而是：

- 功能多，入口多，新同学不知道先看哪条路径。
- 生成链路已具备自动验证与修复，但仍需用持续新建的回归工作空间控制模型、模板和数据变化带来的漂移。
- 策略平台和评测平台已经拆了一轮，但部分编排逻辑还偏重。
- 数据能力已经有 K 线、覆盖率、ClickHouse 短线筛选，但财报质量、真实资金流、行业中性化和日频因子批处理仍需补齐。
- 投研日报已经有观察池、报告契约、本地证据采样和企业微信/飞书/钉钉/Discord webhook adapter，后续要接新闻舆情源、LLM 摘要和定时 worker。
- generation 已由 PostgreSQL job/outbox 和独立 Worker 执行；评测、策略扫描和补数仍需统一暂停、恢复、失败重试与事件语义。
- 本地 Qwen 与 DeepSeek Anthropic 上游已通过 ModelPort 的限定模型发现、鉴权、流式工具调用和续写验收；ModelPort 已为 OpenAI Chat Completions 应用本地 Qwen 默认思考策略，避免工具任务耗尽隐藏推理预算。Query Rewrite 已升级为 schema v4 LLM-first 合同，保持“大位科技”等原文实体，并在模型不可用时停止规划/预取，不再走关键词语义降级。Evolvable User Memory 已通过隔离 subject 的写入、召回、项目隔离、提示注入和 Outcome 闭环；AKEP 已通过自然语言检索、Citation、Usage 与 Feedback 幂等闭环。服务级固定 30 题体验集连续两轮 60/60 通过；任务级 campaign 进一步以 24 个 Qwen、6 个 ModelPort DeepSeek 的真实 Project 验证 `/act`、Workspace、Validation、Mission receipt、持久预览和任务抽屉，最终 30/30 READY。当前本地长期使用链路已打通；Memory 的持久治理、耐久审计、可信 JWT 和 production profile 仍是生产阻塞项。

## 北极星与产品结果

下一阶段围绕“可信数据 → 可复现实验 → 持续研究 → 结果复盘”推进，优先补齐量化研究闭环与数据能力。新增控制台、Provider 和微服务拆分不作为当前主线。

后续优化不只看服务存活和测试通过，也看用户是否稳定获得可验收的研究交付。第一批口径已进入运行治理中心，默认观测最近 7 天；当前窗口指标与最终北极星指标必须明确区分。

| 层级 | 核心指标 | 当前动作 | 下一阶段目标 |
| --- | --- | --- | --- |
| 产品 | 首个有效研究完成率 | 已有请求终态完成率和 Mission 验收率；验收要求匹配的 accepted receipt | 建立首次研究 cohort、观察窗口与失败分类，不能用全部请求完成率替代 |
| 效率 | 首次有效交付耗时 | 已有全部已验收 Mission 的中位耗时、P90/P95；排除异常时间 | 增加首个研究时长、排队/阶段耗时，连续两周建立基线后再设 SLO |
| 留存 | 7 日复用率 | 已有窗口内重复研究率与活跃项目；页面说明不等同第 7 日留存 | 增加成熟的 7/30 天 cohort、跨日复用和项目漏斗，明确时区和未成熟样本 |
| 信任 | 证据通过率、数据新鲜度 | 已展示验收证据完整率，核对回执归属/版本/结论 | 加入验证尝试的首次通过率；对报告来源、时间、点时一致性建立证据链 |
| 成本 | 单任务成本 | AgentRun 记录 token 用量；尚无覆盖规划、重试和修复的任务金额账单 | 以 request/run 绑定计费回执、币种、价格版本和缺失标记；未知金额不能计为零 |

90 天优先级按“产品闭环 → 数据可信 → 策略可复现 → 工程效率”排序：先让产品结果可观测，再完成 point-in-time 数据和回测偏差治理，然后增加策略版本/种子/费用的可复现性，最后持续拆解高风险大文件并收紧测试门禁。

### 90 天实施节奏

| 阶段 | 前端与产品 | 后端与数据 | AI 与策略 | 质量、安全与运维 |
| --- | --- | --- | --- | --- |
| 0-30 天 | 打通服务集成反馈、错误态和无障碍；建立任务漏斗 | 拆分生命周期路由；补指标查询索引与数据降级 | 固定 Mission 验收口径；补失败分类 | 关键 API 合同测试、覆盖率基线、依赖显式化 |
| 31-60 天 | 拆分 chat 页面 hooks/timeline/runtime controls；补关键页面 E2E | point-in-time 财报/行业映射；数据新鲜度 SLO | 回测统一费用、滑点、复权、停牌与未来函数检查 | API 耗时/错误率、分布式 trace、覆盖率增量门禁 |
| 61-90 天 | 7/30 天 cohort、项目漏斗和个性化默认值 | 评测/扫描/补数统一 job 模型；容量与成本预算 | 策略版本、数据快照、随机种子和结果签名可复现 | SBOM/锁文件来源治理、恢复演练、SLO 告警与错误预算 |

### 当前迭代与接续批次

2026-09-18 Agent evaluation 与 Data Agent 批次增强了取数、证据和验收主链路：共用行情一致性检查，区分传输不完整与展示窗口采样，记录请求/响应摘要和时间来源；检查来源文件与关键质量错误；语义评分绑定可解析引用与证据摘要，拒绝未完成的模型输出；评测器 2.2.0 复核底层失败并重算报告分数。确定性反例集从 10 扩为 25，输出窗口逻辑拆出独立模块。没有新增服务、依赖或数据库表。后续仍需真实模型对抗评测、生产回放与人工盲评校准，以及参数扫描共用冻结输入；本批检查不代表 point-in-time 完整性或全部 Agent 能力已验真。

持续设计复查按以下边界收敛到现有主链路，不增加平行运行栈：

| 方向 | 已有基础与接续动作 | 验收要求 |
| --- | --- | --- |
| 异步任务恢复 | 已隔离预览、发布和活跃请求状态；继续收敛消息提交及模型偏好 | 网络故障不算完成；旧响应不覆盖新请求；页面退出不继续更新 |
| 上下文与成本 | 已保留用量来源、补齐流中断统计与缺失用量预算兜底，展示末次准备请求的上下文预估；金额账单待接真实计费回执 | 快照绑定 run/model、轮次和采样时点；窗口来自配置；最新 run 缺失时显示未记录，不使用旧 run 或累计量推算 |
| 过程检查与结果复盘 | 回测响应已携带冻结输入、引擎身份与结果校验，可离线复跑；继续关联研究假设、Mission receipt 与后续表现 | 中间成功不能代替最终验收；输入、实现或结果变化须被发现，历史记录不可用最新数据补齐 |
| 版本与存储成本 | 复用本地清理脚本和版本契约，先建立可重建产物的保留范围与引用检查 | 清理先 dry-run；被实验或验收引用的证据必须保留；不自动删除业务数据与工作空间 |

2026-09-06 用量可信批次将 PI 用量转换与累计逻辑移出运行引擎，修复估算来源丢失、首轮估算被误判为混合来源，以及流异常丢弃已知消耗的问题。成功响应缺少用量时保守估算并参与预算限制，非法用量能正常结束为失败任务。历史来源缺失按不完整处理；新增上下文快照只保存数值与身份信息，随最终回复持久化，刷新后仍区分累计消耗与末次输入预估。沿用现有运行记录与结果摘要，无新增服务、依赖或数据库表。下一批继续围绕实验的数据版本、策略版本和验收证据建立可复现与复盘关联。

接续的回测实验批次已将实际行情输入、数据口径、未舍入费用与初始资金、参数、实现及运行环境绑定到现有回测 JSON。11 种策略共用离线复跑与完整性校验；缓存按引擎隔离，研究上下文仅保留原始产物引用，不重复携带输入快照。修复币种、时区和数据质量丢失，拒绝非法费用；新实验按 ID 命名，重复取数保留先前的不同实验。没有增加数据库表、服务或依赖。当前仍是单标的简化执行模型，参数扫描冻结全组数据、有效参数统一解析、组合回测与 point-in-time 数据可得性仍待完成。

2026-09-05 这轮先收敛 P0 的产品观测基础：匹配验收回执后才统计有效交付，展示证据缺失、耗时分位数和最近 10,000 条请求的截断范围；将产品指标展示迁出主页面。补上治理 API 权限/缓存/降级合同，以及采样边界、错误回执和异常耗时回归。产品指标已建立标准 Playwright spec，覆盖桌面/移动端的刷新、降级和接口失败，并接入 CI；生成任务全链路的浏览器 spec 仍待补齐。已有 CI 覆盖率门槛为 lines 51%、functions 52%、branches 42%、statements 50%，门槛是最低基线，不能代替关键路径验收。

同日工程减险批次已把 Python 数据契约拆为 8 个领域模块，迁移全部调用方并删除旧 `models.py` 门面；85 个模型 JSON Schema 与 43 个接口的 OpenAPI 合同保持一致。清理 5 个无调用方的旧组件/占位文件，统一脚本环境优先级、Compose 默认端口和 npm 锁文件来源，增加对应回归门禁。PostgreSQL 集成测试改为真实迁移建库，覆盖运行时数据库约束、并发接管、审批及产品指标持久化查询。

2026-09-06 联调继续修复了行情新鲜度查询：未来日历不能覆盖历史休市日的判断，未来日期的行情不能成为当前覆盖率样本；新增 PostgreSQL 回归验证两个场景。认证烟测改为独立用户与项目，不再借用业务项目、恢复管理员密码或清空共享审计/限流记录。Prisma 间接依赖和桌面构建工具链的已知漏洞已修复，全量 npm 审计通过；验证与取数职责拆分、聊天编辑器解耦在接续批次推进。

生成评测进一步发现并修复了沙箱启动问题：沙箱 PATH 只使用实际挂载的 Node 目录和系统工具，修复版本管理器软链接不可见导致的 npm 启动失败；先建立私有 `/tmp`，再挂载工作空间，支持临时目录中的工作空间。真实 namespace 回归验证 npm 可运行、宿主文件和凭据仍不可见。Linux 本机可运行 `QUANTPILOT_TEST_GENERATED_SANDBOX=1 npx vitest run src/lib/security/generated-project-sandbox.test.ts`。运行诊断的 HTTP 探测也增加了总时限，防止不可达端口或持续发送数据的响应阻塞整个 doctor。

本轮验收：完整发布质量门通过，前端 1,250 项、隔离 PostgreSQL 集成 26 项、Python 114 项、桌面/移动端浏览器 4 项及认证生命周期烟测通过；16 个合约评测全部通过，平均分 92。CI 的 PostgreSQL 集成数据库已与合约评测数据库分离，真实 TimescaleDB 容器复测通过。六个基础组件通过本地 Docker 安装；默认股票池 300 个标的补数成功，最新交易日 2026-09-04 覆盖 298 个标的，达到原有 250 个门槛，并同步到 ClickHouse 分析投影。ClickHouse 空表的最新日期改为 `null`，不再显示 1970 年。此次是合约与真实基础设施验收；当前环境缺少模型凭据，未重新执行真实 LLM Mission E2E，也尚未覆盖完整历史数据与 point-in-time 研究。

2026-09-06 接续批次已将 validation 拆为 12 个模块、入口收敛到 175 行；prefetch 拆为 9 个模块、入口收敛到 262 行，调用方直接导入所属能力，删除旧聚合调用。迁移核对保留 137 个函数体，相关 89 项回归通过，新增模块统一限制在 500 行以内。聊天文件树、编辑状态与 hook 已迁出，主页面减少约 570 行；修复迟到读写响应覆盖其他文件、后台刷新覆盖草稿、保存期间继续输入丢失，以及错误文本可被当成源码保存的问题。目录按展开加载，避免状态更新函数中的网络副作用与重复路径拼接；手机改为目录在上、编辑区在下，避免固定侧栏挤占编辑宽度。

数据可信批次新增 `quant.financial_report_versions` 与管理员采集接口，财报/财务指标支持带时区的 `as_of`。只返回截止时点前已观测且已公告的不可变版本，保留修订与内容回退，返回内容哈希和数据版本；缺公告、未来时点、数据库故障与内容损坏均不能以最新数据补齐。真实本地 PostgreSQL 的并发、防篡改、历史隔离与修订回退回归通过；600519 的 8 期真实财报已归档，重复采集新增 0 期，固定时点财报与指标版本一致。当前只从首次观测积累，尚未覆盖历史回填、自动调度、所有研究计划参数传递、复权事件与历史行业成分。

接续批次验收：完整发布质量门、前端 1,256 项测试、隔离 PostgreSQL 26 项、Python 123 项（含财报归档 PostgreSQL 回归）及桌面/移动端浏览器 8 项通过。覆盖率为语句 50.95%、分支 43.99%、函数 53.81%、行 52.61%，满足既有门槛。生产构建通过，本地 Web 与 market-data 恢复运行；金融合约评测需与最终工作树指纹一致，真实模型 Mission E2E 仍需模型凭据。

接续工作按下面顺序交付，每批都以代码、合同测试和可审查证据收尾：

| 批次 | 交付 | 验收 |
| --- | --- | --- |
| P0 产品指标闭环 | 首次研究 cohort、首次有效交付时间、成熟 7 日复用、任务账单归因 | 跨窗口历史请求、匿名用户、失败重试、币种和账单缺失都有明确口径与回归 |
| P0 工程减险 | Python contracts、validation、prefetch 与文件编辑状态拆分已落地；继续拆聊天生成/预览状态机，关键任务入口补标准 Playwright spec | 保持现有生成/修复合同，降低模块预算；关键页面覆盖成功、失败、等待输入、移动端 |
| P1 数据可信 | 财报观测/修订归档已落地；继续自动采集、研究计划点时参数、复权事件、退市证券、历史行业成分、lineage 与许可信息 | 任意研究时点只读取当时已知版本；freshness、coverage、跨源差异可解释 |
| P1 实验可复现 | 版本化因子批处理、截面排名、行业中性化、IC/IR；组合回测固化数据/策略/参数版本 | 费用、滑点、停牌、涨跌停、容量、再平衡与样本外检查固定；同一快照可复跑 |
| P1 持续研究与复盘 | 观察池、定时报告、研究假设、证据、决策日志、后续结果和归因关联 | 每条研究结论可追溯证据，并能按原始假设回看后续表现 |
| P2 模拟组合与质量运营 | 研究用 Portfolio/Holding/Snapshot、风险暴露与归因；金融对抗回放、质量/成本/延迟 canary | 仅模拟研究；覆盖未来函数、复权错误、过期行情、幻觉引用与标的歧义 |

## 精炼优先级快照

文档不需要简单“删短”，需要压入口、去重复、把路线集中维护。代码不需要为了行数硬拆，需要优先拆职责最混杂、回归风险最高的文件。

| 类型 | 优先对象 | 当前问题 | 精炼方式 |
| --- | --- | --- | --- |
| 文档入口 | `README.md`、`docs/README.md` | 容易重复导航 | 根 README 保留启动入口，docs README 同时承担角色导读和完整索引 |
| 文档路线 | 各专题文档里的“后续建议” | 后续事项散落，读者不知道优先级 | 集中到本文，专题文档只保留本主题强相关下一步 |
| 生成脚手架 | `scaffold.ts`、`scaffold-base-templates.ts`、`scaffold-dashboard-templates.ts` | 基础模板和三类专用看板模板均已迁出并加入真实 Next build 门禁，writer 主文件从 5715 行降至约 685 行 | 继续拆 workspace writer、dependency planner、repair adapter，并压缩模板内部重复 helper |
| 聊天页面 | `src/app/[project_id]/chat/page.tsx`、`src/components/chat/ChatLog.tsx` | 页面状态、消息渲染、运行时控制和附件交互耦合 | 拆 hooks、message timeline、runtime controls、files panel |
| 验证链路 | `src/lib/quant/validation.ts` | 检查、报告、修复和恢复已独立，入口 175 行 | 保持直接能力导入和各模块 500 行预算 |
| 策略平台 | `src/lib/quant/strategies.ts`、`src/app/strategy-platform/*` | response mappers 已迁出并有单测，API client、dashboard 编排和部分页面交互仍集中 | 继续拆 market client、dashboard service、hooks、dialogs |
| 评测平台 | `src/lib/eval/runtime.ts` | report/database mappers 已迁出并有单测，当前约 1071 行，runs、queue、repairs、schedule 仍在运行时入口 | 继续拆 runs、queue、repairs、schedule |
| 市场数据后端 | `contracts/`、`api.py`、`repositories/universes.py` | contracts 已拆为 8 个领域，最大 346 行；生命周期路由已迁出，universe repository 仍混合读取、写入、清洗 | 新契约模块预算 400 行；继续拆应用装配和 membership hygiene；旧 `models.py`、`database.py` 门面已删除 |

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
| PI Agent 收敛 checkpoint | ProgressOracle 不能只存在于请求进程内 | 已完成 `progress_evaluated`、canonical-hash checkpoint v2、恢复前完整性校验和停滞状态投影；后续由 worker dispatcher 消费 replan 信号，而不是恢复旧 Provider session |
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
