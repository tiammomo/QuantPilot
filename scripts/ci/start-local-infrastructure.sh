#!/usr/bin/env bash

set -euo pipefail

log_file="${QUANTPILOT_CI_INFRA_LOG:-tmp/local-infrastructure.log}"
compose_file="${QUANTPILOT_CI_COMPOSE_FILE:-docker-compose.ci.yml}"
max_attempts="${QUANTPILOT_CI_INFRA_MAX_ATTEMPTS:-90}"
required_stable_checks="${QUANTPILOT_CI_INFRA_STABLE_CHECKS:-3}"
compose=(docker compose -f "$compose_file")

mkdir -p "$(dirname "$log_file")"
: > "$log_file"

log() {
  printf '[local-infrastructure] %s\n' "$1" | tee -a "$log_file"
}

diagnostics() {
  log 'Docker Compose status:'
  "${compose[@]}" ps -a 2>&1 | tee -a "$log_file" || true
  log 'Recent TimescaleDB and Redis logs:'
  "${compose[@]}" logs --no-color --tail=200 timescaledb redis 2>&1 | tee -a "$log_file" || true
}

log 'Starting TimescaleDB and Redis without relying on a single Compose health transition.'
if ! "${compose[@]}" up -d timescaledb redis >> "$log_file" 2>&1; then
  diagnostics
  printf '::error title=Local infrastructure failed::docker compose up could not start TimescaleDB and Redis.\n'
  exit 1
fi

stable_checks=0
for attempt in $(seq 1 "$max_attempts"); do
  postgres_ready=0
  redis_ready=0
  prisma_ready=0

  if "${compose[@]}" exec -T timescaledb sh -ec \
    'pg_isready -h 127.0.0.1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"' \
    >> "$log_file" 2>&1; then
    postgres_ready=1
  fi

  if "${compose[@]}" exec -T redis redis-cli ping >> "$log_file" 2>&1; then
    redis_ready=1
  fi

  if printf 'SELECT 1;\n' | ./node_modules/.bin/prisma db execute \
    --stdin \
    --schema prisma/schema.prisma \
    >> "$log_file" 2>&1; then
    prisma_ready=1
  fi

  # The host-side Prisma connection is the authoritative PostgreSQL probe: it
  # uses the same URL and network path as migrations and the application. Keep
  # the container-local pg_isready result as diagnostics, not a duplicate gate.
  if [ "$redis_ready" -eq 1 ] && [ "$prisma_ready" -eq 1 ]; then
    stable_checks=$((stable_checks + 1))
    log "Readiness check ${attempt}/${max_attempts} passed (${stable_checks}/${required_stable_checks} consecutive)."
    if [ "$stable_checks" -ge "$required_stable_checks" ]; then
      log 'TimescaleDB and Redis are stably reachable from both containers and the host runtime.'
      exit 0
    fi
  else
    stable_checks=0
    log "Readiness check ${attempt}/${max_attempts} pending (postgres=${postgres_ready}, redis=${redis_ready}, prisma=${prisma_ready})."
    if [ $((attempt % 10)) -eq 0 ]; then
      printf '::notice title=Local infrastructure pending::attempt=%s postgres=%s redis=%s prisma=%s\n' \
        "$attempt" "$postgres_ready" "$redis_ready" "$prisma_ready"
    fi
  fi

  sleep 2
done

diagnostics
printf '::error title=Local infrastructure timeout::postgres=%s redis=%s prisma=%s; required %s consecutive host-ready checks.\n' \
  "$postgres_ready" "$redis_ready" "$prisma_ready" "$required_stable_checks"
exit 1
