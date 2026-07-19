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
| `agent-runtime` | ModelPort Qwen 默认运行时、ModelPort DeepSeek 日常运行时、DeepSeek 可选官方直连、流式消息、预览和技能注入 | `src/lib/services/cli/**`、`src/app/api/chat/**` |
| `quant-core` | LLM-first Query Rewrite、Resolver 身份核验、运行规划、量化能力、策略、证据、验证、数据预取和技能治理 | `src/lib/quant/**`、策略平台/业务知识中心 |
| `eval-core` | 评测集、用例、运行、报告和 CI 质量门 | `src/lib/eval/**`、评测页面、评测脚本 |
| `ops-core` | Docker、服务健康、日志和运维面板 | `src/lib/ops/**`、运行治理中心、观测配置 |
| `market-data-backend` | FastAPI、行情、回测、TimescaleDB、Redis、ClickHouse | `services/market-data/**` |

## 依赖原则

1. 页面层可以依赖领域模块，领域模块不能反向依赖页面层。
2. `ui-kit` 不能依赖 `quant-core`、`ops-core`、`agent-runtime` 或 `src/app/**`。
3. Python 后端不能依赖 Next.js 源码。
4. 新能力先找模块归属，再决定文件位置；不要把新业务继续塞进现有最大文件。
5. 跨模块调用优先走 public surface，避免深层私有文件互相引用。

## 当前迁移债务

| 文件 | 当前问题 | 目标 |
| --- | --- | --- |
| `src/lib/utils/scaffold.ts` | 基础/专用页面模板已迁入两个纯模板模块，writer 从 5715 行降至约 685 行 | 保持 writer 小于 900 行；模板继续走独立真实构建门禁 |
| `services/market-data/src/quantpilot_market_data/database.py` | 已收敛为兼容门面，只导出旧 public surface | 新增 SQL 禁止写入该文件，继续由 repositories 承接 |
| `src/app/strategy-platform/StrategyPlatformClient.tsx` | 已拆出 helpers、金融知识、股票池、K 线详情、板块资金、因子目录和基础组件视图；主 client 仍承载弹窗和部分扫描编排 | 继续拆成 dialogs、hooks、tables |
| `src/lib/quant/strategies.ts` | 已拆出 `strategy-types`、`strategy-catalog`、`strategy-scan-repository`、`strategy-readiness` 和 `strategy-mappers`，公共入口从 1787 行降至约 1140 行 | 继续拆出 `strategy-market-client.ts` 和 `strategy-dashboard-service.ts` |
| `src/lib/eval/runtime.ts` | cases/sets、paths、runtime-utils 和 report/database mappers 已拆出，runtime 当前约 1071 行 | 继续拆成 `src/lib/eval/runs.ts`、`queue.ts`、`repairs.ts`、`schedule.ts` |

这些债务暂时以 `largeFileBudgets` 形式进入质量门。超过硬上限会失败，超过目标线会警告。

## 后续拆分顺序

1. 拆策略平台前端：先提取无副作用组件，再提取 hooks，最后收敛 API client。
2. 继续收紧 `quant-core`：response mappers 已迁出并补单测；下一步把 `strategies.ts` 中剩余的 market API client 和 dashboard service 拆出。
3. 然后拆小 `eval-core`：已拆出 cases/sets 和 runtime mappers，继续从 `src/lib/eval/runtime.ts` 拆出 runs、queue、repairs、schedule 等子领域。
4. 最后收紧 `platform-core` 与 `quant-core` 的双向依赖，把项目默认量化配置改成 quant public adapter。

## 发布标准

- `npm run check:module-boundaries` 必须通过。
- 新增模块必须更新 `config/module-boundaries.json` 和本文档。
- 新增大文件超过目标线时，必须写明拆分计划。
- 修改模块边界后，同步 `docs/README.md`、`docs/architecture.md` 或相关专题文档。
