# QuantPilot Prisma migration adoption

The migration history starts with the application schema at Git revision
`c641c00`, followed by additive MoAgent runtime/evidence migrations, user and
project authentication, capability authorization, idempotent usage quota
metering, governed Memory/Knowledge usage, durable generation dispatch, Data
Agent composition locking, global Worker capacity and Worker process registry.
None of these migrations contains a destructive reset.

The directory contains 28 ordered migrations at this revision. The filesystem
is the authoritative list; do not copy a shortened list into deployment
automation:

```bash
find prisma/migrations -mindepth 1 -maxdepth 1 -type d -printf '%f\n' | sort
```

The latest orchestration migrations are:

- `20260719000600_add_generation_dispatch_outbox`
- `20260722000300_enforce_agent_run_workspace_identity`
- `20260723000100_persist_data_agent_profile`
- `20260723000200_lock_data_agent_composition`
- `20260723000300_worker_capacity_and_structural_quotas`
- `20260723000400_worker_registry_and_observability`

Do not use `prisma migrate reset`, `prisma db push --force-reset`, or execute the
baseline SQL manually against a database that already contains QuantPilot data.
Take a verified backup before adopting migration history on an existing
database.

Normal application startup, `db:init`, and production releases use
`prisma migrate deploy`. Raw `prisma db push` is not an equivalent deployment
path: Prisma schema introspection does not preserve every checked-in CHECK
constraint or partial unique index. The package command `npm run prisma:push`
is retained as a compatibility alias for the versioned deploy/bootstrap chain.

## New, empty database

Set `DATABASE_URL` to the target PostgreSQL database, then run:

```bash
npx prisma migrate deploy
npx prisma migrate status
```

All migrations are applied in order.

## Permissions and usage quota migration

`20260716000400_add_permissions_and_usage_quotas` is an additive migration. It:

- creates `permission_profiles`, `permission_profile_grants` and
  `user_permission_overrides` for account capability policy;
- creates `quota_profiles`, `quota_rules`, `user_quota_overrides`,
  `usage_buckets`, `quota_reservations` and `usage_events` for quota policy,
  atomic reservation/settlement and the idempotent usage ledger;
- adds `permission_profile_id`, `quota_profile_id` and the non-negative
  optimistic-lock `access_version` to `auth_users`;
- adds nullable `actor_user_id` attribution to `user_requests` and
  `agent_runs`; existing rows deliberately remain null instead of being
  guessed or retroactively charged;
- seeds the default `member-default` permission/quota profiles and the optional
  `readonly-default` permission profile, then assigns both default profiles to
  existing `member` users. Administrators are not assigned restrictive
  profiles; the application always resolves them as all-capability and
  unlimited while still recording actual usage.

The default quota rules seeded for members are:

| Metric | Limit | Enforcement / window | Reservation TTL |
| --- | ---: | --- | ---: |
| `projects.owned` | 10 | `hard` / `lifetime` | 3,600 s |
| `agent.pending` | 4 | `hard` / `lifetime` | 结构计数，不使用 TTL reservation |
| `agent.concurrent` | 2 | `hard` / `lifetime` | 结构计数，不使用 TTL reservation |
| `agent.requests.daily` | 100 | `hard` / `day` | 900 s |
| `llm.total_tokens.monthly` | 2,000,000 | `warn` / `month` | 3,600 s |
| `query_rewrite.llm.daily` | 200 | `hard` / `day` | 900 s |
| `quant.data_units.daily` | 2,000 | `warn` / `day` | 900 s |
| `research.report_runs.daily` | 20 | `hard` / `day` | 3,600 s |
| `research.report_sends.daily` | 10 | `hard` / `day` | 3,600 s |

After deploy, regenerate the Prisma client for the same application revision
and bootstrap the administrator before accepting traffic:

```bash
npx prisma generate
npm run auth:ensure-access-control
npm run auth:bootstrap
npm run auth:cleanup -- --dry-run
```

`auth:ensure-access-control` is idempotent and also reconciles the lifetime
`projects.owned` bucket from authoritative project ownership before traffic is
accepted. It shares the quota bucket advisory lock with runtime mutations and
skips actors that still have a live project-create reservation. This exact
allocation reconciliation is intentionally not part of recurring cleanup.

Run `npm run auth:cleanup` on a recurring schedule. In addition to expired
authentication records it expires abandoned active quota reservations and
returns their quantities from `usage_buckets.reserved`; it does not delete the
`usage_events` ledger.

## Existing pre-MoAgent database

This path is only for a database already managed by the pre-MoAgent schema at
revision `c641c00`, with the regular QuantPilot tables present and none of the
eight `agent_*` runtime or Mission tables present.

First perform a read-only classification:

```sql
SELECT
  to_regclass('public.projects') AS projects,
  to_regclass('public.user_requests') AS user_requests,
  to_regclass('public.agent_runs') AS agent_runs,
  to_regclass('public.agent_workspace_leases') AS agent_workspace_leases,
  to_regclass('public.agent_events') AS agent_events,
  to_regclass('public.agent_checkpoints') AS agent_checkpoints,
  to_regclass('public.agent_tool_executions') AS agent_tool_executions,
  to_regclass('public.agent_missions') AS agent_missions,
  to_regclass('public.agent_mission_nodes') AS agent_mission_nodes,
  to_regclass('public.agent_evidence_receipts') AS agent_evidence_receipts;
```

`projects` and `user_requests` must exist; every `agent_*` result must be null.
After confirming the deployed application revision and backup, adopt the
baseline and apply the additive migration:

```bash
npx prisma migrate resolve --applied 20260715000100_baseline_pre_moagent
npx prisma migrate deploy
npx prisma migrate status
```

`migrate resolve` records history only; it does not execute the baseline SQL.
`migrate deploy` then applies every later migration in this list, including the
runtime/Mission tables, authentication and project membership records,
capability profiles, quota policy, actor attribution, indexes and foreign keys.

## Database already on the durable runtime migration

When migration history already records both the baseline and
`20260715000200_add_moagent_runtime`, and all five durable runtime tables are
present, use the normal deployment path:

```bash
npx prisma migrate deploy
npx prisma migrate status
```

This applies `20260715000300_add_moagent_mission_graph` and every subsequent
migration in order, through
`20260716000400_add_permissions_and_usage_quotas`. If migration history claims
the durable runtime migration is applied but any of its five tables or required
constraints is missing, stop and repair the catalog with a reviewed
roll-forward migration first.

## Database already synchronized with `prisma db push`

If all eight `agent_*` tables already exist because the current schema was
previously pushed, run the read-only MoAgent schema readiness check from
`src/lib/db/moagent-schema-readiness.ts`. Only when contract
`20260715000500_add_moagent_build_revision` returns `ready: true`, record all
five migrations as already applied:

```bash
npx prisma migrate resolve --applied 20260715000100_baseline_pre_moagent
npx prisma migrate resolve --applied 20260715000200_add_moagent_runtime
npx prisma migrate resolve --applied 20260715000300_add_moagent_mission_graph
npx prisma migrate resolve --applied 20260715000400_add_moagent_generation_epoch_slot
npx prisma migrate resolve --applied 20260715000500_add_moagent_build_revision
npx prisma migrate status
```

If only the five durable runtime tables were created by an older `db push` and
the migration history is empty, do not mark the Mission migration as applied.
First verify the five-table `00200` contract against the deployed application
revision, record the baseline and runtime migrations, and then run
`prisma migrate deploy` to create the three Mission tables.

If a raw `db push` already created the later authentication, permission, quota,
or API-idempotency tables as well, do not use the five-migration recipe above:
the tables may exist while migration-only CHECK constraints, partial unique
indexes, seed/backfill rows, or migration history are absent. Back up the
database, compare it with a fresh database produced by all nine migrations,
apply a reviewed additive roll-forward for every catalog difference, run
`auth:ensure-access-control`, and only then record the matching migrations as
applied. Never let `migrate deploy` discover those pre-existing tables by
trial and error.

## Partial or unknown schema

If only some runtime or Mission tables exist, the readiness check reports
drift, a migration is failed, or the database cannot be classified
unambiguously, stop. Do not mark any additive migration as applied and do
not reset the database. Restore from backup or produce a reviewed roll-forward
migration from the actual catalog state.

## Application readiness gate

`assertMoAgentSchemaReady(prisma)` performs only PostgreSQL catalog `SELECT`
queries. It verifies every runtime and Mission column's type/nullability plus
the semantic indexes, uniqueness guarantees, foreign-key actions, and
constraint validity. This includes the Mission-to-request binding, materialized
node ownership, immutable evidence ownership, accepted-receipt link, and the
unique active Mission slot per project. The
application should refuse new MoAgent runs when it throws
`MOAGENT_SCHEMA_NOT_READY`; schema repair remains an explicit deployment step.
