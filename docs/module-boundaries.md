# 模块边界与模块化单体治理

QuantPilot 目前不适合拆成多语言微服务，也不需要引入 Java/Dubbo 式运行时复杂度。更合适的方向是模块化单体：运行态保持 `Next.js + Python market-data` 两条主线，但代码组织按模块管理，模块之间只通过稳定 public surface 协作。

模块清单和质量门定义在 `config/module-boundaries.json`，检查脚本是 `npm run check:module-boundaries`。

## 模块清单

| 模块 | 职责 | 当前边界 |
| --- | --- | --- |
| `shared-kernel` | 稳定类型、配置和无业务状态工具 | `src/types/**`、`src/lib/config/**`、`src/lib/utils.ts` |
| `ui-kit` | 无领域知识的基础 UI | `src/components/ui/**` |
| `product-shell` | 首页、导航、布局、主题和平台入口 | `src/app/page.tsx`、`src/components/layout/**` |
| `platform-core` | 项目、设置、Token、服务目录和外部集成 | `src/lib/platform/**`、核心 `src/lib/services/**` |
| `agent-runtime` | MoAgent Provider、执行循环、上下文、类型化工具、Skills 编译和通用 Mission 机制 | `src/lib/agent/**`、通用运行服务 |
| `data-agent-core` | 通用数据任务、实体、指标、Connector、Domain Pack、Agent Profile 与执行计划合同 | `src/lib/data-agent/**` |
| `finance-domain` | 证券实体、金融能力目录、行情工具、金融 Mission、验证和可视化配置 | `src/lib/domains/finance/**` |
| `quant-core` | 金融产品编排、LLM-first Query Rewrite、Resolver、运行规划、策略、证据、验证和数据预取 | `src/lib/quant/**`、策略平台/业务知识中心 |
| `eval-core` | 评测集、用例、运行、报告和 CI 质量门 | `src/lib/eval/**`、评测页面、评测脚本 |
| `ops-core` | Docker、服务健康、日志和运维面板 | `src/lib/ops/**`、运行治理中心、观测配置 |
| `market-data-backend` | FastAPI、行情、回测、TimescaleDB、Redis、ClickHouse | `services/market-data/**` |

## 依赖原则

1. 页面层可以依赖领域模块，领域模块不能反向依赖页面层。
2. `ui-kit` 不能依赖 `quant-core`、`ops-core`、`agent-runtime` 或 `src/app/**`。
3. Python 后端不能依赖 Next.js 源码。
4. 新能力先找模块归属，再决定文件位置；不要把新业务继续塞进现有最大文件。
5. 跨模块调用优先走 public surface，避免深层私有文件互相引用。
6. `agent-runtime` 不认识任何业务 Domain；`data-agent-core` 只认识注册合同；业务能力由 `finance-domain` 等 Domain Pack 向上注入。
7. LLM 负责 Query Rewrite 的语义理解，领域 Resolver 只核验实体身份，不能退化为关键词路由。

## 当前迁移债务

| 文件 | 当前问题 | 目标 |
| --- | --- | --- |
| `src/lib/utils/scaffold.ts` | 基础/专用页面模板已迁入两个纯模板模块，writer 从 5715 行降至约 685 行 | 保持 writer 小于 900 行；模板继续走独立真实构建门禁 |
| `src/app/[project_id]/chat/page.tsx` | 页面仍同时管理消息、生成、预览恢复与大部分布局 | 拆成 generation controller、message transport、preview hook 和纯页面组件 |
| `src/app/api/chat/[project_id]/act/route.ts` | HTTP、鉴权配额、Query Rewrite、取数和 Mission 派发集中在单一路由 | route 只保留请求校验与响应；应用流程迁入 use case |
| `src/components/chat/ChatLog.tsx` | 消息协议解释、工具结果、进度状态和渲染耦合 | 拆成消息模型、工具视图、生成进度和内容 renderer |
| `src/lib/agent/core/run-engine.ts` | Agent 状态机仍直接承接上下文、工具循环、验证与封存细节 | 按 planning、tool loop、checkpoint、verification、terminalization 拆分 |
| `src/lib/quant/validation.ts` | artifact/data/visual/repair/acceptance 多条验证管线集中 | 拆成独立 validator，保留单一 facade |
| `src/lib/quant/data-prefetch.ts` | 通用取数计划与金融 endpoint、证据落盘交织 | 抽离通用执行器与 Finance Data Adapter |
| `src/app/strategy-platform/StrategyPlatformClient.tsx` | 已拆出 helpers、金融知识、股票池、K 线详情、板块资金、因子目录和基础组件视图；主 client 仍承载弹窗和部分扫描编排 | 继续拆成 dialogs、hooks、tables |
| `src/lib/quant/strategies.ts` | 已拆出 `strategy-types`、`strategy-catalog`、`strategy-scan-repository`、`strategy-readiness` 和 `strategy-mappers`，公共入口从 1787 行降至约 1140 行 | 继续拆出 `strategy-market-client.ts` 和 `strategy-dashboard-service.ts` |
| `src/lib/eval/runtime.ts` | cases/sets、paths、runtime-utils 和 report/database mappers 已拆出，runtime 当前约 1071 行 | 继续拆成 `src/lib/eval/runs.ts`、`queue.ts`、`repairs.ts`、`schedule.ts` |
| `services/market-data/.../models.py` | 所有 Pydantic contract 集中在单文件 | 按 quotes、research、ingestion、financials、analytics 分包 |
| `services/market-data/.../api.py` | app factory 仍混有少量业务装配 | 只保留应用创建、依赖注入和 router 注册；旧 `database.py` 已删除且门禁禁止恢复 |

这些债务暂时以 `largeFileBudgets` 形式进入质量门。超过硬上限会失败，超过目标线会警告。

## 后续拆分顺序

1. 先拆聊天主链：Act Use Case、Chat Page Controller 和 ChatLog renderer 是变更频率最高、回归半径最大的三个热点。
2. 再拆验证与取数：把通用 Data Agent 执行合同和 Finance Adapter 从 `quant` 产品编排中进一步显式化。
3. 拆市场数据 contracts 与 app factory，保证每个 router/service/repository 域可以独立测试。
4. 随后拆策略平台与 `eval-core`，并把 dashboard Delivery Pack 提取为独立注册能力。
5. 最后收紧 `platform-core` 与 `quant-core` 的依赖，把项目默认金融配置改成显式 product adapter。

Data Agent 的完整分层、工作空间合同和新 Domain Pack 开发流程见 [Data Agent 平台与 Domain Pack 架构](data-agent-architecture.md)。

## 发布标准

- `npm run check:module-boundaries` 必须通过。
- 新增模块必须更新 `config/module-boundaries.json` 和本文档。
- 新增大文件超过目标线时，必须写明拆分计划。
- 修改模块边界后，同步 `docs/README.md`、`docs/architecture.md` 或相关专题文档。
