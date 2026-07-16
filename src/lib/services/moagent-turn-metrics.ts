import { prisma } from '@/lib/db/client';
import {
  MOAGENT_TURN_METRICS_SCHEMA_VERSION,
  type MoAgentTokenAccounting,
  type MoAgentTurnMetrics,
} from '@/lib/chat/turn-metrics';

const MAX_RELATED_REQUEST_IDS = 64;
const ACTIVE_RUN_STATUSES = new Set(['pending', 'running', 'reconciling', 'waiting']);

type UsageSource = 'estimated' | 'cache_estimated' | 'mixed' | undefined;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function usageSourceFromEvent(event: {
  eventType: string;
  payload: unknown;
} | undefined): UsageSource {
  const payload = asRecord(event?.payload);
  if (!payload) return undefined;
  const usage = asRecord(
    event?.eventType === 'usage' ? payload.totalUsage : payload.usage,
  );
  const source = usage?.usageSource;
  return source === 'estimated' || source === 'cache_estimated' || source === 'mixed'
    ? source
    : undefined;
}

function safeSum(values: readonly number[], label: string): number {
  const result = values.reduce((total, value) => total + value, 0);
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new Error(`MoAgent ${label} aggregation exceeded the safe integer range.`);
  }
  return result;
}

function tokenAccountingForRuns(runs: Array<{
  status: string;
  totalTokens: number;
  events: Array<{ eventType: string; payload: unknown }>;
}>): MoAgentTokenAccounting {
  if (
    runs.some((run) =>
      ACTIVE_RUN_STATUSES.has(run.status) || run.status === 'interrupted'
    )
  ) {
    return 'partial';
  }

  const sources = runs
    .filter((run) => run.totalTokens > 0)
    .map((run) => usageSourceFromEvent(run.events[0]));
  if (sources.length === 0) return 'provider';
  if (sources.some((source) => source === 'mixed')) return 'mixed';

  const estimatedCount = sources.filter((source) => source === 'estimated').length;
  const unknownPositiveCount = sources.filter((source) => source === undefined).length;
  if (estimatedCount === sources.length) return 'estimated';
  if (estimatedCount > 0) return 'mixed';

  // Missing usage provenance on a positive legacy/interrupted run means the
  // durable numeric total is useful but cannot be claimed as provider-complete.
  if (
    unknownPositiveCount > 0 &&
    runs.some((run) => run.totalTokens > 0 && run.events.length === 0)
  ) {
    return 'partial';
  }
  return 'provider';
}

export async function collectMoAgentTurnMetrics(params: {
  projectId: string;
  requestId: string;
  relatedRequestIds?: Iterable<string>;
  now?: Date;
}): Promise<MoAgentTurnMetrics> {
  const requestIds = Array.from(new Set([
    params.requestId,
    ...(params.relatedRequestIds ? Array.from(params.relatedRequestIds) : []),
  ]));
  if (requestIds.length > MAX_RELATED_REQUEST_IDS) {
    throw new Error('MoAgent turn metrics request lineage is unexpectedly large.');
  }

  const [request, runs] = await Promise.all([
    prisma.userRequest.findFirst({
      where: { id: params.requestId, projectId: params.projectId },
      select: { createdAt: true, completedAt: true },
    }),
    prisma.agentRun.findMany({
      where: {
        projectId: params.projectId,
        requestId: { in: requestIds },
      },
      select: {
        status: true,
        turnCount: true,
        inputTokens: true,
        outputTokens: true,
        totalTokens: true,
        cachedInputTokens: true,
        cacheMissInputTokens: true,
        reasoningTokens: true,
        events: {
          where: { eventType: { in: ['run_finished', 'usage'] } },
          orderBy: { sequence: 'desc' },
          take: 1,
          select: { eventType: true, payload: true },
        },
      },
    }),
  ]);
  if (!request) {
    throw new Error('MoAgent turn metrics cannot find the root user request.');
  }

  const finishedAt = request.completedAt ?? params.now ?? new Date();
  const elapsedMs = Math.max(0, finishedAt.getTime() - request.createdAt.getTime());
  if (!Number.isSafeInteger(elapsedMs)) {
    throw new Error('MoAgent turn elapsed time exceeded the safe integer range.');
  }

  return {
    schemaVersion: MOAGENT_TURN_METRICS_SCHEMA_VERSION,
    elapsedMs,
    agentRunCount: runs.length,
    modelTurnCount: safeSum(runs.map((run) => run.turnCount), 'model turn count'),
    inputTokens: safeSum(runs.map((run) => run.inputTokens), 'input token'),
    outputTokens: safeSum(runs.map((run) => run.outputTokens), 'output token'),
    totalTokens: safeSum(runs.map((run) => run.totalTokens), 'total token'),
    cachedInputTokens: safeSum(
      runs.map((run) => run.cachedInputTokens),
      'cached input token',
    ),
    cacheMissInputTokens: safeSum(
      runs.map((run) => run.cacheMissInputTokens),
      'cache-miss input token',
    ),
    reasoningTokens: safeSum(runs.map((run) => run.reasoningTokens), 'reasoning token'),
    tokenAccounting: tokenAccountingForRuns(runs),
  };
}
