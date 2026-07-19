# 数据生命周期与安全清理

本文是 QuantPilot 本地数据保留、测试隔离、备份和清理的权威入口。删除前先判断数据所有权；
“时间较早”不等于“无价值”。生产环境禁止照搬本地清理 SQL。

## 数据分类

| 数据 | 权威位置 | 默认策略 |
| --- | --- | --- |
| 用户、权限、项目和任务 | PostgreSQL `public` | 保留；只通过应用 API 删除真实项目 |
| 行情、证券、财务和时序数据 | PostgreSQL `quant` / TimescaleDB | 保留；按数据源补数/修复，不作为测试垃圾清理 |
| 生成 Workspace | `data/projects/<Project.id>` | 与 Project 同生命周期；数据库删除成功后再清文件 |
| 配额与用量账本 | PostgreSQL quota/usage 表 | 保留审计；项目删除后允许引用被置空，不能伪造回收额度 |
| Memory/AKEP 使用回执 | PostgreSQL integration ledger | 按真实消费者审计保留；测试 Scope 随测试批次清理 |
| 构建缓存和临时报告 | `.next`、`tmp`、coverage 等 | 可重建；使用 `npm run clean:local` |

## 测试隔离

真实任务 E2E 的 Project ID 固定为 `project-e2e-<campaign>-<case>`，标题固定带
`[E2E <CAMPAIGN>/<CASE>]`。`npm run check:task-e2e` 会先验证任务抽屉和报告；完整 30 题全部
通过后自动调用 Project DELETE API 清理该批数据库记录、预览和 Workspace。部分运行或失败会保留，
便于同 campaign 重试。

```bash
# 人工复核通过后仍保留看板
npm run check:task-e2e -- --campaign=review01 --retain-projects

# 明确清理失败或部分批次
npm run check:task-e2e -- --campaign=review01 --only=C01,C02 --cleanup
```

不要把普通用户 Project 仅凭标题内容判断为测试数据；自动清理只接受严格的 campaign ID 前缀。

## 备份与清理顺序

1. 运行 `npm run db:doctor`，确认数据库和 migration 正常。
2. 用 `npm run db:backup:release` 生成可恢复备份，并在独立目录保存校验值。
3. 停止目标 Project 的生成和预览，再通过 Project API 删除。
4. 对认证过期数据运行 `npm run auth:cleanup -- --dry-run`，复核后再去掉 `--dry-run`。
5. Memory 用 `(tenant_id, subject_id)` Scope erasure；AKEP 用 revoke/erase 生命周期；ModelPort 的
   append-only 预算事件不得从 QuantPilot 侧删除。
6. 复查项目数、任务抽屉、孤立 Workspace、数据库 readiness 和四平台健康检查。

`npm run clean:local` 会删除 `tmp`，所以需要长期保留的数据库备份不能放在 `tmp` 中。

## 禁止事项

- 不执行无筛选的 `TRUNCATE`，不删除 `quant` 行情表或 Timescale chunk。
- 不在数据库事务成功前删除 Workspace；否则会产生不可恢复的“有记录、无文件”状态。
- 不绕过配额结算删除 active reservation，不修改已结算 usage event。
- 不把 Memory、AKEP 或 ModelPort 的测试清理扩大到其他 tenant/project/environment。
- 不把本机 `.env.local`、API Key、原始用户证据写进清理报告。

跨平台作用域和回执所有权见[联合上下文与项目隔离](context-composition.md)，生产备份/恢复见
[发布运行手册](release-runbook.md)。
