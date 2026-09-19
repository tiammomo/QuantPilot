# 01. 本地启动与健康检查

目标：启动本地工作台，分清“页面能打开”“服务已就绪”和“研究可完成”三个层次。完整安装命令以[根 README](../../README.md#快速启动)为入口；本文解释每一步的作用和排查方法。环境已就绪时，直接进入[第一项研究实操](first-research.md)。

![首页工作台示例，具体布局以当前页面为准](assets/home.png)

## 本地究竟运行了什么

| 组件 | 运行位置 | 负责什么 | 首次练习是否需要 |
| --- | --- | --- | --- |
| Web | 宿主 Linux 环境 | 页面、API、项目与技能管理 | 需要 |
| 市场数据服务 | 宿主 Linux 环境 | 行情、历史数据、指标和数据质量 | 真实行情研究需要 |
| Generation Worker | 宿主 Linux 环境 | 后台领取和执行研究任务 | 选择 Worker 模式时需要 |
| Evaluation Worker | 宿主 Linux 环境 | 后台执行评测任务和计划 | 开发启动器默认托管，初次使用无需配置评测计划 |
| TimescaleDB / PostgreSQL | 本地 Docker | 项目、任务状态、业务与时序数据 | 需要 |
| Redis | 本地 Docker | 短期缓存 | 本教程启动 |
| ClickHouse | 本地 Docker | 分析查询加速 | 可后续接入 |
| Loki / Grafana / Alloy | 本地 Docker | 集中日志、查询与展示 | 可后续接入 |
| 模型服务 | 官方 API 或独立 ModelPort 服务 | 理解问题、执行分析和生成 | AI 研究需要，仓库 Compose 不安装它 |

TimescaleDB 是带时序扩展的 PostgreSQL，应用仍使用 PostgreSQL 连接协议。Redis 的缓存可重建，项目和业务事实不能只存在缓存里。

Memory 与 Knowledge 是独立集成，不影响你理解基础流程；尚未部署时，按 README 在 `.env.local` 中关闭对应开关即可。`offline` 会同时关闭多项能力，不是完成真实研究的快捷方式。

## 1. 检查工具和依赖

本教程使用 Linux shell。Windows 可在支持相应 namespace 的 WSL2 环境中运行，并开启 Docker 集成；macOS 原生环境不能直接满足生成代码的 Linux 沙箱要求。

需要 Node.js `>=22.19.0`、npm `>=10`、Git、uv、Python `>=3.14` 和 Docker Compose v2。先在仓库根目录运行：

```bash
node --version
npm --version
uv --version
docker compose version
docker info
```

缺少 Python 3.14 时可运行 `uv python install 3.14`。`docker info` 应能连接 Docker daemon；否则先启动 Docker，再继续安装项目依赖：

```bash
npm ci
npm run ensure:env
npm run prisma:generate
uv sync --frozen --project services/market-data --extra baostock --extra akshare
npx playwright install chromium
```

| 步骤 | 成功后得到什么 |
| --- | --- |
| `npm ci` | 按锁文件安装的 JavaScript 依赖 |
| `ensure:env` | 缺失的 `.env`、`.env.local` 与本地目录；不会覆盖已有密钥 |
| `prisma:generate` | 应用访问数据库所需的生成客户端，不写业务行 |
| `uv sync` | 行情服务的 Python 环境和可选 Provider 依赖 |
| Playwright 安装 | 视觉验收与浏览器测试所需 Chromium |

不要重新运行安装命令来解决所有运行错误。依赖安装成功后，数据库连接、模型授权和数据覆盖需要分别检查。

## 2. 配置模型，启动基础组件

按照[README 的模型选择](../../README.md#2-选择模型)，用编辑器修改 `.env.local` 中实际需要的几项。不要覆盖整个文件，也不要把整份 `.env.example` 复制进去。

- `.env`：Docker 和应用共用的本地基础设施配置。
- `.env.local`：模型凭据、个人开关和应用覆盖；Compose 不自动读取它。
- 进程环境变量：优先级更高，排查配置未生效时也要检查。

选择官方直连时，页面模型必须选 `Official Direct`。选择 ModelPort 时，需要已有网关、模型服务和允许访问目标模型的客户端 Key。仅配置 Key 不证明模型调用成功。

在仓库根目录启动必需组件并初始化本地数据库：

```bash
docker compose up -d --wait timescaledb redis
npm run db:init
npm run db:doctor
```

`--wait` 等待容器就绪，再执行初始化，避免把“数据库还在启动”误判为迁移失败。`db:init` 执行量化基础 SQL、版本化迁移及内置权限初始化；它不会下载全市场历史数据。已有数据库日常重启不需要重新初始化。

需要整套本地组件时，先创建日志挂载目录，再启动：

```bash
mkdir -p .next tmp/runtime
docker compose up -d --wait
```

这会增加 ClickHouse、Loki、Grafana 和 Alloy。ClickHouse 查询启用与数据同步是另外的步骤，见[基础设施指南](../infrastructure.md)。容器运行并不等于已经有研究数据。

## 3. 用一个入口启动应用

```bash
npm run dev
```

保持这个终端打开。启动器 `scripts/dev/run-full.js` 会：

1. 启动市场数据服务，或复用已有健康实例。
2. 启动 Web，准备本地配置、样式，应用所需版本化迁移。
3. 在 `PI_AGENT_DISPATCH_MODE=worker` 时启动 Generation Worker。
4. 默认启动 Evaluation Worker。

只要使用上述开发入口，通常不必再开一个终端重复启动市场数据服务或 Worker。独立管理进程的方式见[运行手册](../operations-runbook.md)。

**成功标志**：终端打印 Web 地址，通常为 `http://localhost:3000`。如果端口被占用，启动器会在 `3000–3099` 中选择可用端口，以实际输出为准。生成工作空间的预览使用另一组端口，不要把预览地址当作主工作台。

如果启动器提示 market-data 超时，先检查是否完成了 Python 依赖安装，再单独运行 `npm run dev:market` 查看错误。若已有其他服务占用 `8000`，先确认进程归属，不要直接结束不认识的进程。

## 4. 在第二个终端检查

下面示例假设 Web 使用 `3000`；如有变化，请替换端口：

```bash
curl -fsS http://127.0.0.1:3000/api/health
curl -fsS http://127.0.0.1:3000/api/ready
curl -fsS http://127.0.0.1:8000/ready
docker compose ps
```

| 结果 | 能说明什么 | 还不能说明什么 |
| --- | --- | --- |
| Web `/api/health` 返回 HTTP 200 和 `ok: true` | Web 进程存活 | 数据库、模型和研究数据都可用 |
| Web 与市场数据 `/ready` 返回 HTTP 200 | 当前配置要求的依赖已就绪 | 可选组件全部开启、模型真实调用成功 |
| Docker 数据库和 Redis 为 healthy | 容器通过自己的健康检查 | 应用迁移完整、目标行情覆盖完整 |
| `npm run db:doctor` 通过 | 本地数据库对象检查通过 | 已下载所有证券的历史数据 |

随后检查首页、`/skills`、`/strategy-platform` 和 `/ops-platform`。空列表可能只是没有业务记录；错误覆盖层、反复加载和连接失败则需要排查。

### 沙箱与浏览器检查

生成代码在 Linux namespace 沙箱中构建和预览。可以先做一个无业务数据操作的基本能力探测：

```bash
unshare --user --map-root-user --mount --net --pid --fork true
```

返回成功只说明这些 namespace 可以创建，完整生成验收还会执行实际沙箱流程。`unshare: Operation not permitted` 常见于宿主策略限制或受限容器；需检查所用 Linux/WSL 环境的 namespace 支持与安全策略，不要把关闭沙箱作为新手启动步骤。

若视觉检查提示找不到浏览器，重新确认 `npx playwright install chromium` 已成功执行。Linux 缺少系统库时，可按提示安装，或使用：

```bash
npx playwright install --with-deps chromium
```

安装系统依赖可能要求管理员权限。已有受管理浏览器时，可配置 `QUANTPILOT_CHROMIUM_EXECUTABLE_PATH` 指向真实可执行文件；详见[配置指南](../configuration.md)。

## 5. 用一项真实任务完成验收

运行 `npm run doctor` 可辅助定位环境、Skills、组件与部分合同问题。它的成功不等于真实模型和数据链路都已完成验收；未使用的可选服务也可能产生 warning，需要结合自己的配置判断。

接着按[第一项研究实操](first-research.md)提交一个明确标的、固定范围的问题，检查数据来源、实际日期、缺失项与当前任务验收结果。

修改代码时再运行对应检查，不必在第一次打开页面前执行整套发布门禁：

| 修改内容 | 对应检查 |
| --- | --- |
| 文档 | `npm run check:docs`，核对示例命令和页面文案 |
| 前端 / TypeScript | `npm run lint`、`npm run type-check` 和相关单元测试 |
| Python 市场数据 | `npm run test:backend` 与 `uv run --project services/market-data ruff check services/market-data/src services/market-data/tests` |
| Skills | `npm run check:skills`，再验证实际版本与项目行为 |
| 准备发布 | `npm run release:check`；其余验收按[发布手册](../release-runbook.md)执行 |

## 停止与恢复

在启动应用的终端按 `Ctrl+C`，启动器会结束由它管理的进程；此前单独启动的服务要在对应终端停止。按需执行 `docker compose stop` 停止基础组件，数据卷会保留。

下次运行 `docker compose up -d --wait timescaledb redis` 和 `npm run dev` 即可；启用了整套组件时用不带服务名的 `docker compose up -d --wait`。不要通过删除数据卷、重置数据库或删除工作空间来做普通重启。

遇到其他问题，带着已脱敏的错误、命令和任务阶段查[故障排查手册](../troubleshooting.md)。后续课程从[教学目录](README.md)选择即可。
