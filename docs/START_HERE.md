# QuantPilot 文档导读

这份导读不是另一篇长文档，而是帮你决定“现在该读哪一篇”。QuantPilot 的文档已经按专题沉淀得比较全，真正容易迷路的地方是：架构、教程、排障、策略、评测和数据口径都在 `docs/` 下平铺，看起来像一堆同等重要的入口。

## 先判断你是谁

| 你现在的目标 | 先读 | 然后读 | 暂时不用读 |
| --- | --- | --- | --- |
| 只想把项目跑起来 | [本地启动与健康检查](learning/01-quick-start.md) | [故障排查](troubleshooting.md) | 架构细节、skills 编写 |
| 第一次接手项目 | [项目学习地图](learning/00-project-study-map.md) | [项目结构与分层边界](project-structure.md)、[内部组件学习指南](internal-components.md) | API 全量表、数据源细节 |
| 要改前端页面 | [项目结构与分层边界](project-structure.md) | [模块边界与模块化单体治理](module-boundaries.md)、对应页面专题 | 后端 provider 细节 |
| 要改市场数据后端 | [后端能力架构与持续优化边界](backend-capability-architecture.md) | [API 总览](api-reference.md)、[数据字典](data-dictionary.md)、[行情数据源采集知识库](market-data-source-knowledge.md) | 生成页面视觉教程 |
| 要处理生成页面质量 | [AI 工作空间生成链路](learning/02-ai-workspace-generation.md) | [Skills 与可视化看板](learning/04-skills-and-visual-dashboard.md)、[生成工作空间契约](generated-workspace-contract.md) | Docker 组件细节 |
| 要看评测和发布风险 | [评测、运维与质量门](learning/05-evaluation-and-operations.md) | [Agent 评测指南](evals-guide.md)、[运行治理中心使用与评分指南](ops-platform-guide.md) | 策略因子细节 |
| 要做策略平台或股票数据 | [市场数据与策略平台](learning/03-market-data-and-strategy-platform.md) | [策略平台使用与设计指南](strategy-platform-guide.md)、[数据字典](data-dictionary.md) | Skills 发布流程 |
| 要写或改 skill | [Skills 编写与迭代教程](learning/07-skills-authoring.md) | [Skills 治理规范](skills-governance.md)、[文档写作风格指南](documentation-style-guide.md) | 数据库运维细节 |

## 推荐阅读路径

### 30 分钟理解项目

1. [项目学习地图](learning/00-project-study-map.md)
2. [本地启动与健康检查](learning/01-quick-start.md)
3. [项目结构与分层边界](project-structure.md)
4. [模块边界与模块化单体治理](module-boundaries.md)

读完以后，你应该知道：用户入口在哪里、前后端怎么协作、量化数据怎么进库、生成工作空间怎么验证，以及代码应该放在哪个模块。

### 1 小时能参与开发

1. [开发者协作手册](learning/06-developer-playbook.md)
2. [内部组件学习指南](internal-components.md)
3. [API 总览](api-reference.md)
4. [运行手册](operations-runbook.md)

读完以后，你应该能做小改动、跑质量门、判断改动是否需要同步文档。

### 排障时不要从头读

| 现象 | 直接看 |
| --- | --- |
| 前端打不开、端口冲突、服务没起 | [故障排查](troubleshooting.md)、[本地启动与健康检查](learning/01-quick-start.md) |
| 股票池数据缺失、K 线不新、补数卡住 | [运行手册](operations-runbook.md)、[市场数据与策略平台](learning/03-market-data-and-strategy-platform.md) |
| 生成页面空白、验证失败、视觉不好 | [生成工作空间契约](generated-workspace-contract.md)、[Skills 与可视化看板](learning/04-skills-and-visual-dashboard.md) |
| 评测结果异常或运行历史混乱 | [Agent 评测指南](evals-guide.md)、[评测、运维与质量门](learning/05-evaluation-and-operations.md) |
| 不知道某个表或字段是什么意思 | [数据字典](data-dictionary.md) |
| 不知道代码该放哪 | [模块边界与模块化单体治理](module-boundaries.md)、[项目结构与分层边界](project-structure.md) |

## 文档分层

| 层级 | 作用 | 典型文档 |
| --- | --- | --- |
| 导读层 | 告诉你先看哪篇 | 本文、[docs README](README.md) |
| 教程层 | 带你理解链路和概念 | `docs/learning/*` |
| 契约层 | 定义长期规则和边界 | [API 总览](api-reference.md)、[数据字典](data-dictionary.md)、[模块边界](module-boundaries.md)、[生成工作空间契约](generated-workspace-contract.md) |
| 操作层 | 给命令、检查和排障步骤 | [运行手册](operations-runbook.md)、[故障排查](troubleshooting.md) |
| 专题层 | 深入某个业务域 | [策略平台指南](strategy-platform-guide.md)、[运行治理中心指南](ops-platform-guide.md)、[Skills 治理](skills-governance.md) |

## 当前最值得继续完善的方向

下一步路线集中维护在 [持续完善路线图](ROADMAP.md)。如果你只是想理解项目，读本文即可；如果你要安排后续开发、判断优先级或确认某个想法是不是现在该做，再看路线图。

当前优先级可以记成五句话：

1. 先让项目更容易被理解和发布。
2. 再强化生成工作空间的自动修复和视觉质量。
3. 继续拆清楚策略平台、评测平台和量化领域层。
4. 补真正有投研价值的数据能力，而不是堆页面。
5. 最后把长任务和队列做成更稳定的 worker 化体系。
