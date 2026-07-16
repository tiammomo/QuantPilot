import path from 'node:path';

import { Prisma, PrismaClient } from '@prisma/client';
import { config as loadEnv } from 'dotenv';

import { getProjectAuthConfig } from '../../src/lib/config/auth';
import {
  cleanupExpiredQuotaReservations,
  createQuotaService,
} from '../../src/lib/quota/service';
import { cleanupExpiredApiOperations } from '../../src/lib/server/api-idempotency';
import { reconcileApiOperationQuotaSettlements } from '../../src/lib/server/api-idempotency-reconciliation';

const root = process.cwd();
loadEnv({ path: path.join(root, '.env'), quiet: true });
loadEnv({ path: path.join(root, '.env.local'), override: true, quiet: true });

const prisma = new PrismaClient();
const quota = createQuotaService(prisma);
const dryRun = process.argv.includes('--dry-run');

interface UnmeteredAgentRun {
  id: string;
  actorUserId: string;
  projectId: string;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  finishedAt: Date;
}

async function unmeteredAgentRuns(limit: number): Promise<UnmeteredAgentRun[]> {
  return prisma.$queryRaw<UnmeteredAgentRun[]>`
    SELECT
      runs."id",
      runs."actor_user_id" AS "actorUserId",
      runs."project_id" AS "projectId",
      runs."provider",
      runs."model",
      runs."input_tokens" AS "inputTokens",
      runs."output_tokens" AS "outputTokens",
      runs."total_tokens" AS "totalTokens",
      runs."finished_at" AS "finishedAt"
    FROM "agent_runs" runs
    WHERE runs."actor_user_id" IS NOT NULL
      AND runs."finished_at" IS NOT NULL
      AND runs."total_tokens" > 0
      AND NOT EXISTS (
        SELECT 1
        FROM "usage_events" events
        WHERE events."idempotency_key" = 'agent-run:' || runs."id" || ':total-tokens'
          AND events."actor_user_id" = runs."actor_user_id"
          AND events."project_id" = runs."project_id"
          AND events."metric" = 'llm.total_tokens.monthly'
          AND events."quantity" = runs."total_tokens"::bigint
          AND events."source_type" = 'agent_run'
          AND events."source_id" = runs."id"
      )
    ORDER BY runs."finished_at" ASC
    LIMIT ${limit}
  `;
}

async function main() {
  const config = getProjectAuthConfig();
  const now = Date.now();
  const expiredBefore = new Date(now - config.retention.expiredRecordGraceSeconds * 1_000);
  const auditBefore = new Date(now - config.retention.auditDays * 86_400_000);
  const longestRateLimitWindow = Math.max(
    config.rateLimit.windowSeconds,
    config.rateLimit.signInWindowSeconds,
  );
  const rateLimitBefore = BigInt(
    now - (longestRateLimitWindow + config.retention.expiredRecordGraceSeconds) * 1_000,
  );
  const sessionWhere = { expiresAt: { lt: expiredBefore } };
  const verificationWhere = { expiresAt: { lt: expiredBefore } };
  const rateLimitWhere = { lastRequest: { lt: rateLimitBefore } };
  const auditWhere = { createdAt: { lt: auditBefore } };
  const quotaReservationWhere = { status: 'active', expiresAt: { lte: new Date(now) } };
  const apiOperationWhere = {
    retentionExpiresAt: { lte: new Date(now) },
    OR: [
      { status: 'failed' },
      {
        status: 'completed',
        OR: [
          { quotaAccountedAt: { not: null } },
          { quotaSettlement: { equals: Prisma.DbNull } },
        ],
      },
      { status: 'running', leaseExpiresAt: { lte: new Date(now) } },
    ],
  };

  if (dryRun) {
    const [sessions, verifications, rateLimits, auditEvents, quotaReservations, apiOperations, pendingApiOperationQuotaSettlements, agentRuns] = await Promise.all([
      prisma.authSession.count({ where: sessionWhere }),
      prisma.authVerification.count({ where: verificationWhere }),
      prisma.authRateLimit.count({ where: rateLimitWhere }),
      prisma.authAuditEvent.count({ where: auditWhere }),
      prisma.quotaReservation.count({ where: quotaReservationWhere }),
      prisma.apiIdempotencyOperation.count({ where: apiOperationWhere }),
      prisma.apiIdempotencyOperation.count({
        where: {
          status: 'completed',
          quotaAccountedAt: null,
          quotaSettlement: { not: Prisma.DbNull },
        },
      }),
      unmeteredAgentRuns(10_000),
    ]);
    console.log(JSON.stringify({
      dryRun: true,
      sessions,
      verifications,
      rateLimits,
      auditEvents,
      quotaReservations,
      apiOperations,
      pendingApiOperationQuotaSettlements,
      agentRunUsageEvents: agentRuns.length,
    }));
    return;
  }

  let expiredQuotaReservations = 0;
  while (true) {
    const result = await cleanupExpiredQuotaReservations({
      now: new Date(now),
      batchSize: 1_000,
      client: prisma,
    });
    expiredQuotaReservations += result.expired;
    if (result.scanned < 1_000 || result.expired === 0) break;
  }
  const apiOperationQuotaSettlementResult = await reconcileApiOperationQuotaSettlements({
    client: prisma,
    now: new Date(now),
    onError: (operationId, error) => {
      console.error(`[Auth cleanup] Failed to reconcile API operation ${operationId}:`, error);
    },
  });
  const apiOperations = await cleanupExpiredApiOperations({ now: new Date(now), client: prisma });

  let agentRunUsageEvents = 0;
  while (true) {
    const runs = await unmeteredAgentRuns(500);
    for (const run of runs) {
      await quota.recordUsage({
        actorUserId: run.actorUserId,
        projectId: run.projectId,
        metric: 'llm.total_tokens.monthly',
        quantity: run.totalTokens,
        idempotencyKey: `agent-run:${run.id}:total-tokens`,
        sourceType: 'agent_run',
        sourceId: run.id,
        occurredAt: run.finishedAt,
        metadata: {
          reconciled: true,
          provider: run.provider,
          model: run.model,
          inputTokens: run.inputTokens,
          outputTokens: run.outputTokens,
        },
      });
      agentRunUsageEvents += 1;
    }
    if (runs.length < 500) break;
  }

  const [sessions, verifications, rateLimits, auditEvents] = await prisma.$transaction([
    prisma.authSession.deleteMany({ where: sessionWhere }),
    prisma.authVerification.deleteMany({ where: verificationWhere }),
    prisma.authRateLimit.deleteMany({ where: rateLimitWhere }),
    prisma.authAuditEvent.deleteMany({ where: auditWhere }),
  ]);
  console.log(JSON.stringify({
    dryRun: false,
    sessions: sessions.count,
    verifications: verifications.count,
    rateLimits: rateLimits.count,
    auditEvents: auditEvents.count,
    quotaReservations: expiredQuotaReservations,
    apiOperations,
    apiOperationQuotaSettlements: apiOperationQuotaSettlementResult.reconciled,
    apiOperationQuotaSettlementFailures: apiOperationQuotaSettlementResult.failed,
    agentRunUsageEvents,
  }));
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
