---
name: quantpilot-production-release
description: Plan, validate, execute, verify, or roll back a QuantPilot production release. Use for feature releases, hotfixes, production deployments, release checks, database migration decisions, service restarts, post-release smoke tests, or rollback preparation. Keep routine releases code-only by default; never copy or fully synchronize production business data unless the user explicitly authorizes a separately reviewed data operation.
---

# QuantPilot Production Release

Release an immutable Git revision through the repository's existing production
contract. Treat code, schema, bounded backfills, and disaster recovery as
different change classes.

## Required reading

Before changing production, read:

- `docs/release-runbook.md`
- `docs/data-lifecycle.md`
- `docs/configuration.md` only for configuration changes
- `references/release-modes.md`
- `references/production-target.md`

Use repository-relative paths from the QuantPilot root. Do not copy secrets into
logs, commits, release notes, artifacts, or chat.

## Classify the release

Run the bundled classifier before choosing any database action:

```bash
node .agents/skills/quantpilot-production-release/scripts/classify-release.mjs \
  --base-ref <deployed-commit> \
  --head-ref HEAD
```

Before committing, add `--include-working-tree`. The deployed commit must come
from production evidence, not from a guess or the current remote branch.

Apply the classifier result:

- `feature_only`: deploy code and restart affected services. Do not synchronize
  PostgreSQL rows, market history, workspaces, uploads, Memory, or Knowledge.
- `schema_migration`: create the required release backup, then run only
  `npm run prisma:deploy`. Never use `prisma db push`.
- `bounded_data_review`: inspect `schemaAction` independently so a committed
  migration is never skipped, then finish the code/schema release and stop
  before the requested data operation. Require an idempotent,
  restartable, scoped backfill with dry-run counts, upper bounds, audit output,
  and explicit user approval.
- `blocked`: do not release until every blocker is resolved.

Changing a data script does not authorize running it.

After changing this Skill, run its deterministic self-test and the Skill
validator before using it:

```bash
node .agents/skills/quantpilot-production-release/scripts/self-test.mjs
uv run --with pyyaml -- python \
  "${CODEX_HOME:?}/skills/.system/skill-creator/scripts/quick_validate.py" \
  .agents/skills/quantpilot-production-release
```

## Prepare the revision

1. Inspect `git status`, the complete diff, branch, and upstream.
2. Preserve unrelated user changes. Do not use destructive Git commands.
3. Run tests proportional to the changed surfaces.
4. Run `npm run release:check` before committing. Use the stronger production
   or evidence gate when its required production configuration and credentials
   are available.
5. Organize coherent commits, fetch the upstream, verify ancestry, and push the
   intended revision.
6. Record the exact commit SHA as the release identity.

Do not release a dirty tree, an unpushed commit, or an artifact built from a
different revision.

## Resolve the production target

Run the target validator. It reads non-secret release coordinates from the
operator environment and does not connect to production:

```bash
node .agents/skills/quantpilot-production-release/scripts/check-target.mjs
```

Use only a deployment target and transport registered in approved repository
documentation, CI environment configuration, or operator-managed
configuration. Confirm:

- target environment and public URL;
- deployed commit before the change;
- release directory and immutable artifact location;
- service manager and affected service names;
- production environment-file path;
- backup root and rollback artifact.

If the target or transport cannot be discovered safely, finish the code push
and report the missing production contract. Do not invent an SSH host, deploy
to a guessed machine, or call a Git push "production deployment."

## Deploy

1. Confirm the maintenance window and rollback revision.
2. For `feature_only`, verify the latest scheduled backup is recent and
   recoverable, then preserve existing production data and storage mounts
   without another full data copy. For `schema_migration`, create and verify
   the release backup described in the runbook. A backup is recovery evidence;
   it does not authorize copying local data into production.
3. Build the immutable artifact from the pushed SHA using the production
   environment contract.
4. Start the new version out of traffic.
5. If required, run `npm run prisma:deploy`; it applies versioned schema
   migrations only and must not be replaced with bootstrap, restore, workspace
   sync, platform-state import, or full market-data refresh.
6. Restart only affected services. Keep PostgreSQL, uploads, workspaces, and
   other persistent volumes in place.
7. Require `/api/ready` and dependent service readiness before switching
   traffic.

For `bounded_data_review`, finish and verify the code release first. Execute the
separately approved data operation in its own change window and evidence
record. Never hide a data import or restore inside the application deployment.

Never run these as a routine release step:

- `npm run db:init`
- `npm run db:sync-workspaces`
- `npm run db:migrate-platform-state`
- `npm run db:restore:release`
- an unbounded market-data refresh or full data copy

## Verify and observe

After traffic switches:

1. Verify the public URL and authenticated critical path.
2. Check `/api/health`, `/api/ready`, market-data readiness, the generation
   Worker registry, queue health, database and Redis.
3. Exercise the changed user path and one safe existing path.
4. Observe the runbook metrics for at least 15 minutes.
5. Confirm the running revision matches the release SHA.
6. Record checks, migration result, data mode, and rollback revision without
   recording credentials or user data.

Do not declare success from process status alone.

## Roll back

For code-only compatibility, start the previous immutable artifact out of
traffic, require readiness, then switch back. Do not rebuild an old revision in
place.

If a schema or bounded data change is incompatible, enter maintenance mode and
follow `docs/release-runbook.md`. Database restore is a destructive recovery
action and always requires explicit user confirmation of the backup and target
database.
