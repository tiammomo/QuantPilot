# QuantPilot 教学路径

这一组文档用于带新同学从“跑起来”到“能改、能评测、能优化生成页面”。它不是纯命令备忘录，而是偏教学材料：每篇会先解释基础概念，再说明 QuantPilot 为什么这样设计，最后给出操作步骤、检查方法和常见误区。

如果第一次使用，先看[根 README 的快速启动](../../README.md#快速启动)，再跟随[新手实操：从零完成第一项研究](first-research.md)。先完成一个标的的研究和结果检查，再选择下面需要的课程。

## 不同起点怎么学

| 你现在的情况 | 学习顺序 | 先完成什么 |
| --- | --- | --- |
| 不熟悉量化或 Agent，只想体验 | 快速启动 → 新手实操 | 能提交问题、看懂来源与日期、判断任务是否完成 |
| 会使用，想理解数据和技能 | 03 → 04 → 05 | 会检查数据缺口、技能版本和失败证据 |
| 准备参与代码开发 | 00 → 02 → 06 | 能找到模块职责、修改代码并选择对应检查 |
| 想维护 Skills | 新手实操的技能练习 → 07 → Skills 治理 | 分清草稿、平台发布版和项目安装版 |

## 课程列表

| 顺序 | 文档 | 学完以后应当能做什么 |
| --- | --- | --- |
| 入门 | [从零完成第一项研究](first-research.md) | 通过一个可复制案例，学会选模型、提问、验收和追问 |
| 0 | [项目学习地图](00-project-study-map.md) | 建立产品、数据、生成和质量四条主线的全局模型 |
| 1 | [本地启动与健康检查](01-quick-start.md) | 拉起数据库、后端、前端，并确认页面可用 |
| 2 | [AI 工作空间生成链路](02-ai-workspace-generation.md) | 理解用户问题如何变成可验证工作空间 |
| 3 | [市场数据与策略平台](03-market-data-and-strategy-platform.md) | 理解股票池、ETF/指数池、K 线、估值、板块资金和缓存 |
| 4 | [Skills 与可视化看板](04-skills-and-visual-dashboard.md) | 知道如何增强生成页面的审美、布局和自修复能力 |
| 5 | [评测、运维与质量门](05-evaluation-and-operations.md) | 会跑评测、看工作空间健康、定位验证失败 |
| 6 | [开发者协作手册](06-developer-playbook.md) | 知道代码该放哪里、怎么验证、哪些产物不要提交 |
| 7 | [Skills 编写与迭代教程](07-skills-authoring.md) | 学会阅读、修改、发布、打包和验证核心 skills |

专题深入：

- [策略平台使用与设计指南](../strategy-platform-guide.md)：股票池、ETF/指数池、补数、策略数据依赖和页面取舍。
- [运行治理中心使用与评分指南](../ops-platform-guide.md)：工作空间健康、评分口径、日志、降级模式和排障路径。

## 截图索引

截图来自本地 `http://localhost:3000`，采集时已检查无错误覆盖层、无验证失败页、无横向溢出。

| 页面 | 截图 |
| --- | --- |
| 首页工作台 | [assets/home.png](assets/home.png) |
| 策略平台 | [assets/strategy-platform.png](assets/strategy-platform.png) |
| Skills 管理 | [assets/skills.png](assets/skills.png) |
| 评测平台 | [assets/eval-platform.png](assets/eval-platform.png) |
| 量化业务知识中心 | [assets/business-knowledge.png](assets/business-knowledge.png) |
| 运行治理中心 | [assets/ops-platform.png](assets/ops-platform.png) |

## gpt-image2 教学配图

除了真实产品截图，教学文档也可以使用 gpt-image2 生成概念图。当前已加入：

| 用途 | 图片 |
| --- | --- |
| 项目学习地图 | [assets/learning-map-gpt-image2.png](assets/learning-map-gpt-image2.png) |
| AI 工作空间生成链路 | [assets/workspace-generation-gpt-image2.png](assets/workspace-generation-gpt-image2.png) |
| Skills 反馈迭代闭环 | [assets/skills-feedback-loop-gpt-image2.png](assets/skills-feedback-loop-gpt-image2.png) |

这类图片只负责帮读者建立直觉。概念名称、步骤和判断标准仍以正文为准；如果生成图里的文字不稳定，不要强行依赖图片文字。

## 学习建议

- 先把启动和新手实操跑通；没有可运行环境时，可以先认识页面，但不要把它当作真实研究已完成。
- 生成页面相关问题优先看 02 和 04。
- 数据缺失、K 线不完整、板块资金慢，优先看 03。
- “看板验证未通过”“产物契约不通过”“截图里有错误页”，优先看 05。
- 第一次参与代码开发建议先读 00，再读 [内部组件学习指南](../internal-components.md)。
- 要改 skill 时先读 07，再读 [Skills 治理规范](../skills-governance.md)。
- 每篇文档中的“基础概念”都值得读。很多问题不是代码写错，而是没有理解数据源、缓存、验证、skill 或运行时的职责边界。
- 学习时建议同时打开页面和代码：页面负责建立直觉，代码负责确认真实实现。

## 课程写作规范

后续新增或更新 learning 文档时，尽量保持这个结构：

1. 先讲目标和读完后应掌握的能力。
2. 解释基础概念，避免只堆产品名和命令。
3. 讲清楚设计取舍，例如为什么使用 TimescaleDB、为什么需要 evidence、为什么要有降级模式。
4. 给可执行步骤和验证方式。
5. 列出常见误区和排障入口。

教学文档可以比 README 更啰嗦一点。README 负责让人快速启动，learning 负责让人真正理解。

更具体的写法见 [文档写作风格指南](../documentation-style-guide.md)。简单说，learning 文档要像有人带着读者走一遍：讲清楚为什么、什么时候会踩坑、成功以后应该看到什么，而不是只留下一串命令。
