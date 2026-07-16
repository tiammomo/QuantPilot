# QuantPilot 文档总览

这个目录保存 QuantPilot 的项目知识。根目录 README 只做入口，长期规则、架构设计、教学材料、数据源口径和排障经验都应沉淀到这里。

读文档时可以把这里当成项目里的“第二位同事”：它不会替你写代码，但应该能告诉你为什么这么设计、该从哪里看、出了问题先查哪一层。如果某篇文档只剩命令和表格，没有解释背景，那它还没写完。

## 先读哪几篇

如果你第一次打开 `docs/`，先看 [QuantPilot 文档导读](START_HERE.md)。它会按“启动项目、接手开发、改后端、改策略平台、修生成页面、跑评测、排障”等目标告诉你该读哪条路径。

| 目标 | 文档 |
| --- | --- |
| 不知道从哪篇开始 | [QuantPilot 文档导读](START_HERE.md) |
| 想看后续持续完善路线 | [持续完善路线图](ROADMAP.md) |
| 想建立全局学习路线 | [教学 00：项目学习地图](learning/00-project-study-map.md) |
| 想快速跑起来 | [教学 01：本地启动与健康检查](learning/01-quick-start.md) |
| 想配置登录、用户权限或用量配额 | [用户、权限与会话管理](authentication.md) |
| 想确认当前前端启动模式 | [基础设施配置](infrastructure.md#主前端启动器) / [架构总览](architecture.md#构建与开发模式) |
| 想理解生成链路 | [教学 02：AI 工作空间生成链路](learning/02-ai-workspace-generation.md) |
| 想理解或扩展自研 Agent | [MoAgent 架构](moagent.md) |
| 想理解数据和策略平台 | [教学 03：市场数据与策略平台](learning/03-market-data-and-strategy-platform.md) |
| 想优化生成页面 | [教学 04：Skills 与可视化看板](learning/04-skills-and-visual-dashboard.md) |
| 想做评测和运维 | [教学 05：评测、运维与质量门](learning/05-evaluation-and-operations.md) |
| 想查页面和后端接口 | [API 总览](api-reference.md) |
| 想查数据库字段口径 | [数据字典](data-dictionary.md) |
| 想执行补数、验证或排障流程 | [运行手册](operations-runbook.md) |
| 想做每日投研报告和推送 | [投研情报中心与日报自动化指南](research-automation-guide.md) |
| 想参与开发 | [教学 06：开发者协作手册](learning/06-developer-playbook.md) |
| 想学习怎么写 Skills | [教学 07：Skills 编写与迭代教程](learning/07-skills-authoring.md) |
| 想深入策略平台 | [策略平台使用与设计指南](strategy-platform-guide.md) |
| 想深入运行治理中心 | [运行治理中心使用与评分指南](ops-platform-guide.md) |
| 想优化后端能力边界 | [后端能力架构与持续优化边界](backend-capability-architecture.md) |

## 知识地图

| 模块 | 文档 | 关注点 |
| --- | --- | --- |
| 总体架构 | [架构总览](architecture.md) | 主链路、运行时、数据层、控制台和质量门 |
| Agent 框架 | [MoAgent 架构](moagent.md) | Provider、Context Manager、Run Engine、durable ledger、类型化工具、Skills 与安全边界 |
| 内部组件 | [内部组件学习指南](internal-components.md) | 页面、服务、数据、Skills、验证、运维和降级如何协作 |
| 项目结构 | [项目结构与分层边界](project-structure.md) | 前端、后端、量化领域层、脚本和生成工作空间边界 |
| 模块边界 | [模块边界与模块化单体治理](module-boundaries.md) | 模块清单、允许依赖、质量门和拆分顺序 |
| 路线图 | [持续完善路线图](ROADMAP.md) | 后续优先级、验收标准和暂不建议事项 |
| 后端能力 | [后端能力架构与持续优化边界](backend-capability-architecture.md) | Python 后端、设计模式、模块落点、ClickHouse 和迁移路线 |
| API | [API 总览](api-reference.md) | Next.js API、market-data API、调用方和排查路径 |
| 数据字典 | [数据字典](data-dictionary.md) | Prisma 表、quant schema、字段来源、因子和数据质量口径 |
| 基础设施 | [基础设施配置](infrastructure.md) | PostgreSQL、TimescaleDB、Redis、Loki/Grafana/Alloy、SQL 初始化和降级模式 |
| 认证与访问治理 | [用户、权限与会话管理](authentication.md) | 用户生命周期、capability 与项目角色双层授权、用量配额、数据库会话、安全审计和页面/API/WebSocket 边界 |
| 行情数据 | [行情数据源采集知识库](market-data-source-knowledge.md) | 东方财富、Baostock、AKShare、字段口径和补数规则 |
| 策略平台 | [策略平台使用与设计指南](strategy-platform-guide.md) | 股票池、ETF/指数池、策略目录、因子目录、补数控制和策略数据依赖 |
| 投研情报中心 | [投研情报中心与日报自动化指南](research-automation-guide.md) | 观察池、证据采样、报告库、主题洞察和自动化交付 |
| 运行治理中心 | [运行治理中心使用与评分指南](ops-platform-guide.md) | 工作空间健康、治理评分、日志、降级模式和排查路径 |
| Runbook | [运行手册](operations-runbook.md) | 长任务、补数、缓存、验证、skills 和提交前质量门 |
| 工作空间契约 | [生成工作空间契约](generated-workspace-contract.md) | run plan、数据文件、证据、验证、视觉检查和修复计划 |
| Skills | [Skills 治理规范](skills-governance.md) / [Skills 教程](learning/07-skills-authoring.md) | skill 元数据、版本、发布、回滚、锁文件和编写方法 |
| 评测 | [Agent 评测指南](evals-guide.md) | 用例、评测集、评测器、队列、运行记录和 CI 门禁 |
| 本地产物 | [本地产物与生成文件边界](local-generated-files.md) | 哪些文件可提交、哪些文件只保留本地 |
| 排障 | [故障排查](troubleshooting.md) | 端口、数据库、生成工作空间、验证和常见失败 |
| 市场数据服务 | [市场数据服务 README](../services/market-data/README.md) | FastAPI 接口、provider、补数端点和后端开发 |
| 文档写作 | [文档写作风格指南](documentation-style-guide.md) | 如何写得准确、可读、少一点机器味 |

## 当前能力分层

```mermaid
flowchart TB
  U[用户问题 / 截图] --> W[Next.js AI 工作台]
  W --> R[MoAgent Runtime]
  R --> SK[QuantPilot Skills]
  W --> MD[FastAPI 市场数据服务]
  MD --> PG[(PostgreSQL)]
  MD --> TS[(TimescaleDB)]
  MD --> RD[(Redis)]
  OP --> LK[(Loki / Grafana / Alloy)]
  R --> WS[data/projects 工作空间]
  WS --> V[预览与自动验证]
  W --> SP[策略平台]
  W --> DP[量化业务知识中心]
  W --> OP[运行治理中心]
  W --> EP[评测平台]
```

AI 工作台的最终回复会附带完整业务回合耗时与累计 Token 用量；统计覆盖主 MoAgent run 和自动修复 run，并保存在消息 metadata 中，因此刷新或实时通道重连后仍可恢复，同时不会进入下一轮模型上下文。详细口径见 [MoAgent 架构](moagent.md#回合耗时与-token-口径)。

## 文档维护规则

- README 只保留定位、启动和导航；复杂知识放到 `docs/`。
- 业务规则先写到对应专题文档，再在教学文档里用步骤串起来。
- 写文档时先讲人能理解的背景，再放命令、表格和路径。不要只堆能力名。
- 修改代码后如果改变了使用方式、排障方式或模块边界，必须同步文档。
- 改启动脚本、端口池、缓存策略或 bundler 相关依赖时，至少同步 README、`learning/01-quick-start.md`、`infrastructure.md`、`operations-runbook.md` 和 `troubleshooting.md`。
- 页面截图放在 `docs/learning/assets/`，命名使用页面或流程含义，例如 `strategy-platform.png`。
- 截图前需要确认页面没有 Next 错误覆盖层、验证失败页、明显横向溢出或加载空白。
- 真实密钥、个人路径、未脱敏日志不要写入文档。
- `data/`、`tmp/`、`.next/`、虚拟环境和生成项目大产物不进入 Git。
