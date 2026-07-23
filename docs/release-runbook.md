# 生产发布 Runbook

这份手册用于正式环境发布、回滚和灾难恢复。本地开发流程仍以[运行手册](operations-runbook.md)为准。任何一项阻断检查失败都不应通过临时关闭认证、沙箱、required 依赖或评测门禁绕过。

## 当前部署边界

- Web、market-data、PostgreSQL/TimescaleDB、Redis 和 Loki 必须在受控内网通信；只由 HTTPS 反向代理公开 Web。
- generation pipeline 使用 PostgreSQL job/outbox 在 HTTP 响应前持久化；生产 `MOAGENT_DISPATCH_MODE=worker` 时，独立 generation worker 负责 claim、heartbeat、执行、验证和终态提交。Worker 异常退出后，过期 attempt 会在 fencing 校验后进入指数退避的 `retry_wait`，新 attempt 从原始请求、当前工作空间和 run plan 重新规划，不恢复 Provider 私有 session。目标共享卷仍需完成多主机断电验收。
- `PROJECTS_DIR` 必须是持久化、可读写的文件系统，且与数据库备份保持同一恢复点。
- 生产密钥由 secret manager 或 root-only `EnvironmentFile` 注入，不写入镜像、standalone 目录、日志或 Git。

## 首次部署

1. 从 [`.env.production.example`](../.env.production.example) 生成环境文件，替换全部占位值，并设置目录权限为 `0600`。
2. 创建 `quantpilot` 系统用户以及 `/var/lib/quantpilot/projects`、`/var/backups/quantpilot`，只授予该用户所需权限。
3. 先运行生产配置预检。组件可以通过 `ENABLED=0` 明确关闭；只要启用，ModelPort、Memory 与 AKEP 就必须同时启用 required 模式、HTTPS 和各自的短期/作用域身份配置：

   ```bash
   npm run check:production -- --env-file /etc/quantpilot/quantpilot.env --require-bootstrap
   ```

4. 在维护窗口执行迁移和首次管理员初始化：

   ```bash
   npm run prisma:deploy
   npm run auth:bootstrap
   ```

5. 从长期运行环境删除 `QUANTPILOT_AUTH_ADMIN_EMAIL` 和 `QUANTPILOT_AUTH_ADMIN_PASSWORD`，再次执行不带 `--require-bootstrap` 的预检。
6. 使用同一生产环境构建并验证产物：

   ```bash
   npm run release:check:production
   ```

7. 启动 market-data 和 Web，但在负载均衡器中保持摘流。确认：

   ```bash
   curl -fsS http://market-data:8000/health
   curl -fsS http://market-data:8000/ready
   curl -fsS http://web:3000/api/health
   curl -fsS http://web:3000/api/ready
   ```

   `/health` 只表示进程存活；只有 `/ready` 返回 200 才允许接流量。

   启用了 Memory 的生产部署还必须执行 `npm run check:memory-production`；启用了四方长期链路的部署执行 `npm run check:integrations` 和 `npm run check:triad-experience`。配置预检不能替代真实身份、模型工具调用和受治理知识闭环。

8. 用普通成员完成登录、提问、query rewrite、取数、workspace 生成和看板访问，用管理员确认用户/权限/配额审计页面。

## 每次发布

发布前记录版本、操作者、变更窗口、回滚版本和数据库迁移影响。然后按以下顺序执行：

1. 确认 CI 的 frontend、backend、authenticated lifecycle 和 contract evaluation 全部通过。
2. 生成当前提交的评测证据；涉及 Agent 行为的版本还必须执行 live E2E evidence gate。
   本地命令默认使用日常 Qwen/ModelPort；GitHub Hosted runner 无法访问本机 ModelPort，因此 workflow 显式设置 `QUANTPILOT_RELEASE_EVIDENCE_MODEL=deepseek-v4-flash` 并注入官方直连 Key。无论选择哪条路，benchmark 与独立 gate 都从同一显式模型参数读取，禁止“凭据与报告模型错配”。
3. 创建并异地复制发布前备份：

   ```bash
   QUANTPILOT_BACKUP_ROOT=/var/backups/quantpilot npm run db:backup:release
   ```

   `manifest.json` 包含数据库、workspace、uploads 的 SHA-256 和 `ENCRYPTION_KEY` 指纹。备份目录自身必须由基础设施做加密、不可变保留和异地复制。
4. 执行 `npm run prisma:deploy`。禁止用 `prisma db push` 代替迁移。
5. 以新版本启动摘流实例，检查 `/api/ready`，再切流量。
6. 观察 15 分钟：登录失败率、API 5xx、Agent 失败/修复率、数据库连接、Redis、market-data 和 Loki。

## 回滚

无数据库不兼容变更时，摘流新实例、启动上一份已验证 standalone 产物并等待 `/api/ready` 后切回。不要在运行中覆盖 `.next/standalone`。

有数据库不兼容或数据损坏时进入维护模式。先保留故障现场备份，再执行显式确认恢复：

```bash
npm run db:restore:release -- \
  --backup /var/backups/quantpilot/quantpilot-<timestamp> \
  --confirm-database quantpilot \
  --replace-files
```

恢复会校验所有 SHA-256、数据库名和 `ENCRYPTION_KEY` 指纹。旧 workspace/uploads 会被改名为 `.pre-restore-<timestamp>`，不会直接删除。恢复后先跑迁移兼容检查和四个 health/readiness 请求，再由业务验收后切流。

至少每季度在隔离环境做一次真实恢复演练，记录 RPO、RTO、校验结果和改进项。没有演练过的备份不能视为可恢复。

## 定时任务

`deploy/systemd/` 提供：

- `quantpilot-web.service`：启动经过 production preflight 的 standalone Web；
- `quantpilot-market-data.service`：按锁文件启动 market-data API；
- `quantpilot-generation-worker.service`：消费 PostgreSQL generation job，执行领域 handler、自动验证和失败重试；
- `quantpilot-market-maintenance.timer`：工作日收盘后刷新交易日历、执行可恢复的 Baostock `daily/qfq` autofill，并运行新鲜度与标的覆盖门禁；
- `quantpilot-auth-cleanup.timer`：每日清理过期会话、验证记录，并执行审计保留策略；
- `quantpilot-backup.timer`：每 6 小时生成一次带校验清单的备份。

部署时应把模板中的 `/opt/quantpilot/current`、运行用户、可写目录和二进制 PATH 与目标机器对齐，再执行 `systemd-analyze verify`。安装 service/timer 后仍需由基础设施层配置 HTTPS 反向代理、备份保留、异地复制、失败告警和磁盘容量告警。systemd 任务失败必须进入值班通知，不能只留在 journal。

## GA 签字清单

- 产品负责人确认核心问题集、空状态、错误恢复和移动端流程。
- 数据负责人确认行情来源许可、延迟口径、复权/交易日/停牌字段和免责声明。
- 安全负责人确认 HTTPS、secret rotation、最小权限、备份加密、依赖审计和生成代码网络隔离。
- 法务/隐私负责人确认服务条款、隐私政策、Cookie/日志/审计保留、第三方模型与行情数据处理说明。
- 运维负责人确认 SLO、告警联系人、容量、RPO/RTO、回滚和恢复演练。
- 发布负责人保存 commit SHA、CI 链接、评测报告、备份 manifest 和上线验收记录。
