# QuantPilot release modes

## Purpose

Use this decision table after comparing the deployed commit with the candidate
revision. The safest normal release is `feature_only`: replace application
code while retaining every production data store and persistent directory.

## Decision table

| Mode | Trigger | Allowed data action | Approval |
| --- | --- | --- | --- |
| `feature_only` | No Prisma migration and no explicit data operation | None | Normal release authorization |
| `schema_migration` | A new `prisma/migrations/*/migration.sql` is included | Verified backup, then `prisma migrate deploy` | Normal release authorization plus migration review |
| `bounded_data_review` | A named backfill, import, workspace sync, platform-state migration, restore, seed, or market refresh is explicitly requested | Only the named idempotent operation after dry-run and bounds review | Separate explicit authorization |
| `blocked` | Schema changed without migration, secrets/data are in Git, target is unknown, tests fail, or rollback evidence is missing | None | Resolve blockers first |

`prisma migrate deploy` changes the database schema through committed,
versioned migrations. It is not a full business-data synchronization step.
If a candidate contains both a migration and a requested bounded data
operation, `mode` is `bounded_data_review`, `schemaAction` remains
`schema_only`, and the migration review/backup/deploy gates still apply. The
data operation runs only after the code/schema release is healthy and receives
its own approval.

Changing or deploying a data-maintenance script does not execute or authorize
it. The classifier reports that code separately while keeping the routine
deployment code-only. Use `--request-data-operation <name>` only when planning a
separate, explicitly requested data change.

## Persistent data that code releases must preserve

- PostgreSQL/TimescaleDB application, quota, audit, Agent, and market data
- Redis runtime state according to its documented durability role
- `PROJECTS_DIR` generated workspaces
- uploaded files
- external Memory, Knowledge, and Model gateway state
- release backups and evaluation evidence

Never package these directories into the application artifact or replace them
from a developer machine.

## Bounded data-operation contract

Before authorizing a data operation, require:

1. exact source and destination;
2. tenant/project/table/time scope;
3. dry-run row or object counts;
4. a hard maximum and timeout;
5. idempotency or a durable checkpoint;
6. audit output without sensitive payloads;
7. backup or compensating action;
8. restart and rollback behavior;
9. post-run reconciliation queries;
10. separate approval naming the command and scope.

If any item is absent, keep the release code-only.

## Service impact

Classify changed paths before restarting services:

- Next.js, Prisma client, or shared TypeScript: Web and generation Worker.
- `scripts/workers/` or Agent runtime only: generation Worker, plus Web when
  shared contracts changed.
- `services/market-data/`: market-data, followed by dependent readiness checks.
- `deploy/systemd/` or production configuration: validate the unit/configuration
  before applying it and restart only the affected unit.

Always follow `docs/release-runbook.md` when it is stricter.
