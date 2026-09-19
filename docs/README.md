# QuantPilot 文档总览

[根 README](../README.md) 负责项目定位、首次启动和产品入口。本页按任务组织完整文档：需要操作时查指南与手册，需要理解设计时查架构，需要从头学习时走教学路径。

## 从当前任务开始

| 你要做什么 | 从这里开始 | 继续阅读 |
| --- | --- | --- |
| 第一次运行项目 | [快速启动](../README.md#快速启动) | [详细启动与健康检查](learning/01-quick-start.md)、[配置指南](configuration.md) |
| 零基础完成第一项研究 | [新手实操：从零完成第一项研究](learning/first-research.md) | 学会选择模型、提交问题、检查证据与验收，再追问改进 |
| 研究行情、指标或策略 | [策略平台](strategy-platform-guide.md) | [行情数据源](market-data-source-knowledge.md)、[数据字典](data-dictionary.md) |
| 持续跟踪观察池与日报 | [研究自动化](research-automation-guide.md) | [工作空间交付契约](generated-workspace-contract.md) |
| 安装、编辑、发布或回退 Skill | [Skills 治理](skills-governance.md) | [Skills 编写教程](learning/07-skills-authoring.md) |
| 评测 Agent 或排查交付失败 | [评测指南](evals-guide.md) | [生成链路](learning/02-ai-workspace-generation.md)、[故障排查](troubleshooting.md) |
| 接手代码或扩展业务域 | [项目结构](project-structure.md) | [模块边界](module-boundaries.md)、[Data Agent 架构](data-agent-architecture.md) |
| 配置登录与多人访问 | [认证、权限与配额](authentication.md) | [配置指南](configuration.md) |
| 发布、回滚或处理数据 | [生产发布手册](release-runbook.md) | [数据生命周期](data-lifecycle.md)、[运行手册](operations-runbook.md) |

## 产品与研究

| 文档 | 解决的问题 |
| --- | --- |
| [路线图](ROADMAP.md) | 当前已交付什么、哪些能力仍有缺口、下一步如何验收 |
| [策略平台](strategy-platform-guide.md) | 股票池、ETF/指数池、指标、补数与策略数据依赖 |
| [研究自动化](research-automation-guide.md) | 观察池、证据、日报、报告历史与推送回执 |
| [Skills 治理](skills-governance.md) | 内置目录、在线草稿、完整快照、项目版本、跨 Agent 安装与回退边界 |
| [工作空间交付契约](generated-workspace-contract.md) | 计划、数据、证据、预览、验证与修复产物的含义 |
| [评测指南](evals-guide.md) | 评测器、数据集、重放、人工校准、运行报告与 CI 门禁 |
| [运行治理中心](ops-platform-guide.md) | Worker、队列、工作空间健康、日志和产品结果指标 |

## 架构与开发

| 文档 | 解决的问题 |
| --- | --- |
| [架构总览](architecture.md) | Web、Agent、市场数据、存储与验证如何协作 |
| [Data Agent 与 Domain Pack](data-agent-architecture.md) | 通用合同、Agent Profile、业务域和交付能力如何组合 |
| [PI Agent 采用与治理边界](pi-agent-migration.md) | 执行内核与 QuantPilot 治理层分别承担什么 |
| [PI Agent 架构](pi-agent.md) | 运行状态、上下文、工具、审批、用量与恢复机制 |
| [项目结构](project-structure.md) | 页面、服务、领域逻辑和生成工作空间分别放在哪里 |
| [模块边界](module-boundaries.md) | 允许的依赖、文件规模预算与模块检查 |
| [内部组件](internal-components.md) | 页面、服务、数据、Skills 和运维能力之间的关系 |
| [后端能力架构](backend-capability-architecture.md) | Python 路由、用例、仓储、数据源与分析层的职责 |
| [API 总览](api-reference.md) | 页面和 Agent 调用哪些接口、从哪里排查 |
| [数据字典](data-dictionary.md) | 应用表、行情表、字段与质量口径 |
| [行情数据源知识库](market-data-source-knowledge.md) | 数据源覆盖、字段限制、复权口径与补数规则 |
| [市场数据服务 README](../services/market-data/README.md) | 单独启动和开发 FastAPI 后端、调用数据接口 |
| [SQL 初始化说明](../sqls/README.md) | 本地基础 SQL 的职责与执行顺序 |
| [本地产物边界](local-generated-files.md) | 哪些内容属于源码、业务数据、可重建产物或临时文件 |

## 配置、集成与运维

| 文档 | 解决的问题 |
| --- | --- |
| [配置指南](configuration.md) | 环境文件优先级、模型选择、组件开关与持久化目录 |
| [模型 Provider](model-providers.md) | ModelPort、官方直连、凭据、模型目录与连接排查 |
| [基础设施](infrastructure.md) | 本地 Docker 组件、端口、数据卷、日志与降级模式 |
| [认证、权限与会话](authentication.md) | 用户生命周期、项目权限、配额、会话与审计 |
| [用户记忆接入](user-memory-integration.md) | Memory 的启用、隔离、召回、反馈与效果验证 |
| [知识平台接入](knowledge-platform-integration.md) | AKEP 知识、引用、授权、使用记录与降级 |
| [联合上下文与归因](context-composition.md) | 模型、Memory、Knowledge 的项目隔离和结果反馈 |
| [运行手册](operations-runbook.md) | 日常检查、补数、任务维护、Skills 更新与质量门 |
| [生产发布手册](release-runbook.md) | 独立制品、Worker、迁移、就绪检查和回滚 |
| [数据生命周期](data-lifecycle.md) | 数据所有权、测试隔离、保留、备份与清理 |
| [故障排查](troubleshooting.md) | 按现象定位端口、数据库、生成、Skills 和验证问题 |

## 按顺序学习

第一次使用产品，先完成[第一项研究实操](learning/first-research.md)，不必预先读懂全部架构。准备接手代码时，再按以下顺序学习；已有明确问题时直接使用上方专题。课程说明与产品截图见 [教学目录](learning/README.md)。

1. [项目学习地图](learning/00-project-study-map.md)：建立产品、数据、生成与质量的整体认识。
2. [本地启动与健康检查](learning/01-quick-start.md)：启动组件并判断是否可用。
3. [AI 工作空间生成链路](learning/02-ai-workspace-generation.md)：跟随一次任务理解规划、数据、生成与验收。
4. [市场数据与策略平台](learning/03-market-data-and-strategy-platform.md)：理解数据覆盖、指标、补数和策略入口。
5. [Skills 与可视化看板](learning/04-skills-and-visual-dashboard.md)：理解技能如何约束交付内容和呈现。
6. [评测、运维与质量门](learning/05-evaluation-and-operations.md)：执行评测并阅读失败证据。
7. [开发者协作手册](learning/06-developer-playbook.md)：按模块边界修改代码并完成验证。
8. [Skills 编写与迭代](learning/07-skills-authoring.md)：维护技能源码、行为契约和版本。

## 维护文档

使用方式、接口、环境变量或能力边界改变时，同步更新对应专题；根 README 保留首次使用所需信息，本页维护完整索引，教学文档负责解释步骤与原因。写法见 [文档风格指南](documentation-style-guide.md)。

提交前运行 `npm run check:docs` 检查本地链接。页面截图放在 `docs/learning/assets/`；配置使用占位凭据，不写入真实密钥、个人路径或未脱敏日志。
