# 本地产物与生成文件边界

本项目把源码、配置样例和可复现脚本提交到仓库；把运行态数据、缓存、生成工作空间和大报告留在本地。需要清理仓库或排查“为什么文件很多”时，优先按本页判断。

## 不需要提交

这些目录或文件由本地开发、构建、评测或生成流程产生，默认应保持在 `.gitignore` 内：

| 路径 | 来源 | 处理建议 |
| --- | --- | --- |
| `.next/`、`out/` | Next.js 开发和构建产物 | 可随时删除，重新运行 `npm run dev` 或 `npm run build` 会再生成 |
| `node_modules/` | npm 依赖安装结果 | 不提交，依赖以 `package-lock.json` 为准 |
| `data/projects/` | 用户生成的工作空间源码和产物 | 不提交；需要迁移索引时运行 `npm run db:sync-workspaces` |
| `data/strategy-scans/` | 本地策略扫描历史文件 | 新数据应优先迁入 PostgreSQL，历史文件可按需归档 |
| `tmp/` | 评测报告、队列、修复单、视觉截图和临时文件 | 可按需清理；重要报告应导出或入库后再删 |
| `test-results/`、`playwright-report/`、`coverage/` | Playwright、测试和覆盖率产物 | 可随时删除，重新运行测试会再生成 |
| `prisma/data/` | 旧本地数据库或临时数据目录 | SQLite 路径已废弃，确认无历史依赖后可删除 |
| `public/generated/` | 稳定 CSS 等前端生成资源 | 运行 `npm run styles:build` 会重新生成 |
| `public/uploads/` | 本地上传和图片附件 | 不提交，必要时迁移到对象存储 |
| `.ruff_cache/`、`.pytest_cache/`、`__pycache__/` | Python 工具缓存 | 可随时删除 |
| `.venv/`、`services/market-data/.venv/` | Python 虚拟环境 | 不提交，以 `services/market-data/pyproject.toml` 和 `uv.lock` 为准 |
| `*.tsbuildinfo`、`.eslintcache` | TypeScript / ESLint 缓存 | 可随时删除 |
| `.env`、`.env.local` | 本地密钥、端口和数据库连接 | 不提交，只提交 `.env.example` |

建议先预览清理范围：

```bash
npm run clean:local:dry-run
```

执行轻量清理：

```bash
npm run clean:local
```

如果要同步清理 `data/projects/*` 内部生成工作空间的 `.next/`、`node_modules/`、`dist/`、`build/`、`out/`，使用：

```bash
npm run clean:workspaces
```

这不会删除 `data/projects/*` 本身，也不会删除 `data_file/`、`.data-agent/`、`evidence/` 等可追溯产物。

等价的手工轻量清理命令：

```bash
rm -rf .next out tmp public/generated test-results playwright-report coverage .ruff_cache .pytest_cache __pycache__ *.tsbuildinfo .eslintcache
```

如果只是在排查前端启动缓存，不需要清掉整个 `.next/`，可以先删开发锁和缓存：

```bash
rm -rf .next/dev/lock .next/dev/cache/webpack
```

后台运行日志建议放在 `tmp/runtime/*.log`。Alloy 会采集这些日志写入 Loki，文件本身仍属于本地产物，不提交。

如要清理 `data/`、`public/uploads/` 或 `prisma/data/`，先确认里面没有需要保留的工作空间、上传附件或历史报告。

## 需要提交

这些文件虽然会影响运行环境，但属于可复现项目配置或契约，应该保留在仓库：

| 路径 | 原因 |
| --- | --- |
| `.env.example` | 本地环境变量模板 |
| `docker-compose.yml`、`sqls/*.sql` | PostgreSQL / TimescaleDB 本地基础设施定义 |
| `prisma/schema.prisma` | 主业务数据库 schema |
| `package-lock.json` | 前端依赖锁定 |
| `services/market-data/pyproject.toml`、`services/market-data/uv.lock` | Python 后端依赖和服务入口 |
| `.moagent/skills/`、`.moagent/skills.registry.json`、`.moagent/skills.lock.json`、`.moagent/skills.changelog.json` | 仓库 Skill 权威源，受版本与 SHA-256 完整性校验；不作为 workspace 运行时发现目录 |
| `.moagent/skill-packages/` | 规范发布包，用于校验、回滚、source 缺失时的执行 fallback，以及创建 workspace 参考镜像 |
| `benchmarks/quantpilot/cases.json` | 固定评测用例集 |
| `docs/` | 架构、契约、治理和排障文档 |

## 后续建议

- `tmp/quantpilot-benchmark-reports/` 里的长期评测历史建议迁入数据库索引，并把大 JSON / 截图转对象存储。
- `data/projects/` 可以继续作为本地 workspace 根目录，但列表、健康快照和生成状态应以 PostgreSQL 为主。
- 生成工作空间内部的 `node_modules/`、`.next/`、`dist/`、`build/` 也不应被平台采集到可提交产物里。
