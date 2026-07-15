# QuantPilot Prisma migration adoption

The migration history starts with the application schema at Git revision
`c641c00`, followed by the additive durable MoAgent runtime migration and the
additive Mission Graph/evidence migration, and the cross-worker generation
slot guard. None of these migrations contains a destructive reset:

- `20260715000100_baseline_pre_moagent`
- `20260715000200_add_moagent_runtime`
- `20260715000300_add_moagent_mission_graph`
- `20260715000400_add_moagent_generation_epoch_slot`

Do not use `prisma migrate reset`, `prisma db push --force-reset`, or execute the
baseline SQL manually against a database that already contains QuantPilot data.
Take a verified backup before adopting migration history on an existing
database.

## New, empty database

Set `DATABASE_URL` to the target PostgreSQL database, then run:

```bash
npx prisma migrate deploy
npx prisma migrate status
```

All four migrations are applied in order.

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
`migrate deploy` then creates the runtime and Mission tables, indexes,
uniqueness guards, evidence linkage, and foreign keys.

## Database already on the durable runtime migration

When migration history already records both the baseline and
`20260715000200_add_moagent_runtime`, and all five durable runtime tables are
present, use the normal deployment path:

```bash
npx prisma migrate deploy
npx prisma migrate status
```

This applies `20260715000300_add_moagent_mission_graph` and then
`20260715000400_add_moagent_generation_epoch_slot`. If migration
history claims the durable runtime migration is applied but any of its five
tables or required constraints is missing, stop and repair the catalog with a
reviewed roll-forward migration first.

## Database already synchronized with `prisma db push`

If all eight `agent_*` tables already exist because the current schema was
previously pushed, run the read-only MoAgent schema readiness check from
`src/lib/db/moagent-schema-readiness.ts`. Only when contract
`20260715000400_add_moagent_generation_epoch_slot` returns `ready: true`,
record all four migrations as already applied:

```bash
npx prisma migrate resolve --applied 20260715000100_baseline_pre_moagent
npx prisma migrate resolve --applied 20260715000200_add_moagent_runtime
npx prisma migrate resolve --applied 20260715000300_add_moagent_mission_graph
npx prisma migrate resolve --applied 20260715000400_add_moagent_generation_epoch_slot
npx prisma migrate status
```

If only the five durable runtime tables were created by an older `db push` and
the migration history is empty, do not mark the Mission migration as applied.
First verify the five-table `00200` contract against the deployed application
revision, record the baseline and runtime migrations, and then run
`prisma migrate deploy` to create the three Mission tables.

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
