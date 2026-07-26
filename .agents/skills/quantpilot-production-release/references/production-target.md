# Production target contract

## Purpose

Keep deployment coordinates in operator-managed configuration. Do not commit
credentials, private keys, environment files, database URLs, or production
payloads to the repository.

The release workflow requires these non-secret variables:

| Variable | Meaning | Default |
| --- | --- | --- |
| `QUANTPILOT_RELEASE_HOST` | Approved SSH host or configured SSH alias | Required |
| `QUANTPILOT_PUBLIC_URL` | HTTPS URL used for public smoke tests | Required |
| `QUANTPILOT_RELEASE_ROOT` | Root containing immutable releases and `current` | `/opt/quantpilot` |
| `QUANTPILOT_RELEASE_ENV_FILE` | Root-only production environment file | `/etc/quantpilot/quantpilot.env` |
| `QUANTPILOT_BACKUP_ROOT` | Production backup root | `/var/backups/quantpilot` |

Load them through the operator shell, CI environment, or secret-management
wrapper. Although the coordinates are not application secrets, keep
environment-specific values out of reusable Skill source.

## Required remote layout

Use this invariant:

```text
<release-root>/
├── current -> releases/<commit-sha>
└── releases/
    ├── <previous-commit-sha>/
    └── <candidate-commit-sha>/
```

Each immutable release records its full Git commit in `REVISION`. Persistent
state stays outside every release directory:

- PostgreSQL/TimescaleDB and Redis;
- `PROJECTS_DIR`;
- uploads;
- backups;
- external Memory, Knowledge, model gateway, and market-data storage.

Do not use `rsync --delete` against a directory that contains persistent state.
Do not place a database dump or developer workspace inside the application
artifact.

## Target discovery

Before connecting, run:

```bash
node .agents/skills/quantpilot-production-release/scripts/check-target.mjs
```

Then obtain the deployed revision from the remote `current/REVISION` file and
verify that it matches the running service. Do not substitute `origin/main`,
the latest local tag, a shell-history host, or an example domain.

If `current/REVISION` does not exist on an established deployment, stop and
create an operator-reviewed baseline before the next release. Do not guess the
rollback revision.

## Artifact and activation contract

Build or extract the candidate only under `releases/<candidate-sha>`. Run
production preflight, build, migration, and readiness checks using the
root-only environment file. Never bake that file into the artifact.

Switch `current` atomically only after the out-of-traffic candidate is ready.
Restart only the affected systemd units from `deploy/systemd/`. Verify the
public URL, authenticated critical path, Worker registry, queues, database,
Redis, market-data, and the running `REVISION`.

Record:

- previous and candidate commit;
- release mode and changed services;
- gate and backup results;
- migration name or `none`;
- data operation `none` unless separately approved;
- readiness and smoke results;
- observation window and rollback revision.

## Missing target

When either required variable is absent, finish safe local validation and Git
push if requested, then report deployment as blocked by the missing target
contract. A repository push is not a production deployment.
