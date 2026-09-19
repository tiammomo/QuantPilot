# 项目结构与分层边界

QuantPilot 保持一个 Next.js 主应用、独立 Node Workers 和一个 Python 市场数据服务。代码按任务职责组织，PostgreSQL、Redis、ClickHouse 与可观测性组件通过本地 Docker Compose 提供。

物理目录回答“代码放在哪里”，`config/module-boundaries.json` 回答“谁可以依赖谁”。所有主应用生产源码必须有模块归属，跨模块调用只允许使用声明的公开文件；不通过聚合导出或旧路径转发隐藏依赖。

## 顶层目录

| 路径 | 责任 |
| --- | --- |
| `src/app/` | 页面和 HTTP 入口；Worker 不依赖路由实现 |
| `src/components/` | 按功能组织的交互与视图；`ui/` 保存通用原语 |
| `src/hooks/`、`src/contexts/` | 浏览器状态、主题、身份与设置 |
| `src/lib/` | 合同、应用编排、领域规则、运行时与基础设施 |
| `src/types/` | 跨模块共享类型 |
| `services/market-data/` | Python 市场数据与数值研究服务 |
| `prisma/`、`sqls/` | 主应用 schema、版本化迁移与量化数据基础 SQL |
| `config/` | 模块依赖、服务目录与质量门配置 |
| `scripts/` | 开发、构建、Worker、评测、运维和数据维护入口 |
| `tests/e2e/` | 桌面与移动端浏览器合同测试 |
| `.pi/skills/` | 内置技能权威源码，受 registry/lock、版本与哈希校验 |
| `.agents/skills/` | 仓库维护与发布操作技能 |
| `deploy/`、`docker-compose.yml` | 部署配置与本地基础设施编排 |
| `docs/` | 使用、开发、架构与运行说明 |

`data/projects/` 保存生成工作空间，`data/skill-catalog/` 保存技能草稿、发布快照与安装记录；两者属于运行数据。`tmp/`、`coverage/`、`test-results/`、`.next/` 属于生成产物，不能当作产品源码。清理与发布边界见 [本地生成文件](local-generated-files.md) 和 [数据生命周期](data-lifecycle.md)。

## 主应用代码放在哪里

| 目录 | 内容与边界 |
| --- | --- |
| `src/lib/contracts/`、`src/lib/config/` | 稳定的跨模块合同与配置，不承载业务编排 |
| `src/lib/data-agent/` | 通用 Task、Plan、Connector、Domain Pack、Profile、交付合同和工作空间协议 |
| `src/lib/domains/finance/` | 金融能力、证券身份、Query Rewrite、研究计划、行情工具、质量与可视化规则 |
| `src/lib/agent/` | PI 执行循环、Provider、上下文、工具治理、Mission 与 Skills 编译；不依赖金融业务或管理界面 |
| `src/lib/skills/` | 技能发现、源码草稿、发布、回退、多 Agent 部署与安装核验 |
| `src/lib/quant/` | 金融产品应用编排、研究准备、生成调度、预取、验证、策略与报告 |
| `src/lib/eval/` | 评测集、运行、报告、证据复核、持久任务队列与评测器 |
| `src/lib/platform/` | 服务目录、Memory、Knowledge 和跨产品上下文集成 |
| `src/lib/ops/` | Docker、基础环境健康、日志与运维读模型 |
| `src/lib/auth/`、`src/lib/quota/` | 身份、权限、配额与使用量结算 |
| `src/lib/db/`、`src/lib/security/` | Prisma 与 schema 就绪检查；生成代码沙箱与环境隔离 |
| `src/lib/services/` | 项目、消息、预览和持久运行服务；具体模块归属由文件规则确定 |

`src/lib/services/` 是仍在逐步收敛的历史目录，不是允许任意依赖的共享层。`project.ts` 和 `preview.ts` 属于产品编排，`pi-agent-generation-*` 属于通用运行时，`settings.ts` 属于平台核心。新增能力优先放进所属功能目录，避免继续增加带长前缀的平级文件。

### 研究与生成

Worker 模式的主链路如下：

```text
src/app/api/chat/[project_id]/act/route.ts
  → quant/finance-research-request.ts       接纳并持久化请求
  → quant/generation-runtime.ts             选择 Domain handler
  → quant/finance-research-preparation.ts    Worker 租约与准备检查点
  → quant/finance-act-preparation.ts         规划、知识、预取和 Mission 编排
  → domains/finance/                        金融规则与工具
  → quant/finance-generation-executor.ts     生成、验证与交付
```

`quant/data-prefetch/` 拆分行情采集、指标派生、图片证据和输出投影；`quant/validation/` 拆分输入、数据、证据、运行检查、报告与修复。对应根文件仅作为流程入口。模板位于 `src/lib/utils/scaffold-*.ts`，写入器位于 `scaffold.ts`，四类模板必须通过真实构建检查。

### Skills

| 路径 | 责任 |
| --- | --- |
| `src/lib/agent/skills/` | 底层 Catalog、快照、完整性、兼容性与运行编译 |
| `src/lib/skills/administration.ts` | 管理用例入口，协调草稿和发布 |
| `src/lib/skills/source-editor.ts`、`publication.ts`、`archives.ts` | 源码维护、发布验证与归档，属于管理模块内部实现 |
| `src/lib/skills/deployment.ts`、`installation-status.ts` | 按项目和 Agent 安装、回退及实际文件核验 |
| `src/lib/skills/market.ts`、`dashboard.ts` | 内置市场与管理读模型；当前市场使用金融 Profile 核验兼容性 |
| `src/lib/skills/client.ts`、`contracts.ts` | 浏览器调用与类型合同 |
| `src/components/skills/`、`src/app/skills/` | 市场、源码树、版本对话框与管理页面 |
| `src/app/api/skills/` | 鉴权、请求解析和 HTTP 响应；调用管理模块公开接口 |

Skills 不再放入 `quant/skills-*`，也不保留兼容转发。日期展示、状态颜色和控制台卡片等无领域知识的 UI 归入 `src/components/ui/console.tsx`，评测、运维与技能页面共同使用。

## Python 后端

`services/market-data/src/quantpilot_market_data/api.py` 只创建应用、配置中间件和生命周期、注入依赖并注册 router。外部入口仍为 `api:app`，接口路径和 Pydantic schema 保持稳定。

```text
api.py                          应用装配与生命周期
routers/                        HTTP 参数、鉴权、状态码与响应模型
services/                       缓存、降级、Provider 选择与用例编排
services/ingestion/              历史补数、分批、自动补齐、快照与任务控制
repositories/                   quant schema、读模型、事务与批量写入
providers/                      远端数据源适配
analytics/                      ClickHouse 分析加速适配
contracts/                      分领域 Pydantic 请求和响应
database_core.py / cache.py     连接、转换与缓存基础设施
backtest*.py / indicators.py     数值计算与可复现实验
```

补数写接口集中在 `routers/ingestion_writes.py`，管理员验证在 router 层统一执行。历史、批次、快照和自动补齐分别进入 `services/ingestion/` 对应模块；列表与控制位于 `jobs.py`，覆盖率、字段和请求范围处理位于 `support.py`。`tasks.py` 持有当前应用的自动补齐任务，服务正常退出时取消并等待任务结束，记录已运行任务的中断状态。该机制仍是进程内任务管理，不提供进程崩溃后的自动恢复。

后端 AST 门禁禁止 Service 引入 HTTP 框架或 router，禁止 Repository/Provider 反向依赖用例，禁止向 app factory 放回端点。旧 `database.py`、`services/ingestion_jobs.py` 与 `services/ingestion_support.py` 不再保留。详细规则见 [后端能力架构](backend-capability-architecture.md)。

## 脚本与数据

| 路径 | 用途 |
| --- | --- |
| `scripts/dev/` | 开发启动、环境初始化、端口和本地恢复 |
| `scripts/build/` | 主应用、运行包、稳定 CSS 和模板构建 |
| `scripts/workers/` | Generation 与 Evaluation 独立 Worker |
| `scripts/checks/` | 架构、合同、覆盖率、运行健康与发布门禁 |
| `scripts/evals/`、`scripts/skills/` | Benchmark 执行与技能打包发布辅助 |
| `scripts/db/` | 迁移、诊断、备份恢复和受控数据维护 |
| `scripts/auth/`、`scripts/ops/` | 身份运维与运行维护 |

主业务索引、配置、配额、任务和状态进入 PostgreSQL；行情与因子进入 TimescaleDB，分析加速使用 ClickHouse；Redis 保存可丢失的缓存。工作空间、技能快照与大型证据保留文件原件。新增数据不能靠增加一份 JSON 状态副本规避现有持久化合同。

## 如何扩展和验证

1. 先找模块归属和公开入口；新增模块时声明 `paths`、`dependsOn` 与 `publicSurface`。
2. 领域规则放入 Domain，用例编排放入应用模块，HTTP 和 React 仅处理协议与展示。
3. 拆分时迁移全部调用方和测试，删除旧入口；同步修改文件预算与结构文档。
4. 运行 `npm run check:module-boundaries`、`npm run check:backend-architecture` 和对应行为测试；跨接口调整核对 OpenAPI，涉及界面运行浏览器回归。
5. 提交前运行 `npm run release:check`；发布与业务数据操作遵循 [发布手册](release-runbook.md)。

现存大文件仍包括聊天页面、Skills Studio、PI 执行循环和看板模板。预算与后续拆分顺序见 [模块治理](module-boundaries.md) 和 [路线图](ROADMAP.md)，不以目录迁移代替这些文件的后续职责拆分。
