#!/usr/bin/env node

import './worker-environment';

import { createApplicationGenerationRuntime } from '../../src/lib/quant/generation-runtime';
import { prisma } from '../../src/lib/db/client';
import { MoAgentGenerationDispatchSession } from '../../src/lib/services/moagent-generation-dispatch-session';
import {
  finishMoAgentGenerationJob,
  getMoAgentGenerationJob,
  listClaimableMoAgentGenerationJobs,
  MoAgentGenerationDispatchError,
  reconcileExpiredMoAgentGenerationJobs,
} from '../../src/lib/services/moagent-generation-dispatch-store';
import { MoAgentWorkerCapacitySession } from '../../src/lib/services/moagent-worker-capacity';
import { MoAgentWorkerRegistrySession } from '../../src/lib/services/moagent-worker-registry';
import { QuotaExceededError } from '../../src/lib/quota';

function positiveInteger(name: string, fallback: number, max: number): number {
  const value = Number.parseInt(process.env[name] ?? '', 10) || fallback;
  if (!Number.isSafeInteger(value) || value < 1 || value > max) {
    throw new Error(`${name} must be an integer between 1 and ${max}.`);
  }
  return value;
}

const pollIntervalMs = positiveInteger('MOAGENT_WORKER_POLL_INTERVAL_MS', 1_000, 60_000);
const concurrency = positiveInteger('MOAGENT_WORKER_CONCURRENCY', 1, 16);
const globalConcurrency = positiveInteger(
  'MOAGENT_WORKER_GLOBAL_CONCURRENCY',
  concurrency,
  256,
);
const slotLeaseTtlMs = positiveInteger(
  'MOAGENT_WORKER_SLOT_LEASE_TTL_MS',
  120_000,
  24 * 60 * 60 * 1_000,
);
const slotHeartbeatIntervalMs = positiveInteger(
  'MOAGENT_WORKER_SLOT_HEARTBEAT_INTERVAL_MS',
  30_000,
  24 * 60 * 60 * 1_000,
);
const claimBatchSize = positiveInteger('MOAGENT_WORKER_CLAIM_BATCH_SIZE', 20, 200);
const once = process.argv.includes('--once');
const runtime = createApplicationGenerationRuntime();
let stopping = false;

if (concurrency > globalConcurrency) {
  throw new Error(
    'MOAGENT_WORKER_CONCURRENCY cannot exceed MOAGENT_WORKER_GLOBAL_CONCURRENCY.',
  );
}
if (slotHeartbeatIntervalMs >= slotLeaseTtlMs) {
  throw new Error(
    'MOAGENT_WORKER_SLOT_HEARTBEAT_INTERVAL_MS must be smaller than its lease TTL.',
  );
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function executeJob(
  job: Awaited<ReturnType<typeof listClaimableMoAgentGenerationJobs>>[number],
  workerLeaseOwner: string,
): Promise<boolean> {
  let session: MoAgentGenerationDispatchSession | null = null;
  const capacity = await MoAgentWorkerCapacitySession.tryClaim({
    capacity: globalConcurrency,
    activeJobId: job.id,
    leaseOwner: workerLeaseOwner,
    leaseTtlMs: slotLeaseTtlMs,
    heartbeatIntervalMs: slotHeartbeatIntervalMs,
  });
  if (!capacity) return false;
  try {
    session = await MoAgentGenerationDispatchSession.claimExisting({
      projectId: job.projectId,
      requestId: job.requestId,
    });
    console.log(JSON.stringify({
      event: 'generation_worker_claimed',
      jobId: job.id,
      projectId: job.projectId,
      requestId: job.requestId,
      attemptCount: session.claim.attemptCount,
    }));
    await session.run(() => runtime.execute({
      jobId: job.id,
      projectId: job.projectId,
      requestId: job.requestId,
      selectedModel: job.selectedModel,
      cliPreference: job.cliPreference,
      executionEnvelope: job.executionEnvelope,
    }));
    const current = await getMoAgentGenerationJob(job.projectId, job.requestId);
    if (current?.status === 'running') {
      throw new Error('Generation handler returned without committing a terminal job state.');
    }
    console.log(JSON.stringify({
      event: 'generation_worker_finished',
      jobId: job.id,
      projectId: job.projectId,
      requestId: job.requestId,
      status: current?.status ?? 'missing',
    }));
    capacity.assertHealthy();
    return true;
  } catch (error) {
    if (error instanceof QuotaExceededError) {
      return false;
    }
    if (
      error instanceof MoAgentGenerationDispatchError
      && [
        'GENERATION_DISPATCH_BUSY',
        'GENERATION_PROJECT_BUSY',
        'GENERATION_DISPATCH_CONFLICT',
        'GENERATION_DISPATCH_NOT_AVAILABLE',
        'GENERATION_DISPATCH_TERMINAL',
        'GENERATION_DISPATCH_CANCELLED',
        'GENERATION_DISPATCH_ATTEMPTS_EXHAUSTED',
      ]
        .includes(error.code)
    ) {
      return false;
    }
    const message = error instanceof Error ? error.message : String(error);
    console.error(JSON.stringify({
      event: 'generation_worker_failed',
      jobId: job.id,
      projectId: job.projectId,
      requestId: job.requestId,
      error: message,
    }));
    if (session) {
      await session.run(() => finishMoAgentGenerationJob({
        projectId: job.projectId,
        requestId: job.requestId,
        status: 'failed',
        errorCode: 'GENERATION_WORKER_FAILED',
        errorMessage: message,
        fence: session!.fence,
      })).catch((finishError) => {
        console.error('[GenerationWorker] Failed to persist worker failure:', finishError);
      });
      session.markTerminal();
    }
    return Boolean(session);
  } finally {
    session?.dispose();
    await capacity.release().catch((error) => {
      console.error(
        `[GenerationWorker] Failed to release global Worker slot: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  }
}

async function tick(workerLeaseOwner: string): Promise<number> {
  await reconcileExpiredMoAgentGenerationJobs({ limit: claimBatchSize });
  const jobs = await listClaimableMoAgentGenerationJobs(claimBatchSize);
  let completed = 0;
  for (let index = 0; index < jobs.length && !stopping; index += concurrency) {
    const batch = jobs.slice(index, index + concurrency);
    const results = await Promise.all(
      batch.map((job) => executeJob(job, workerLeaseOwner)),
    );
    completed += results.filter(Boolean).length;
  }
  return completed;
}

async function main() {
  if (process.env.MOAGENT_DISPATCH_MODE !== 'worker') {
    throw new Error('Generation worker requires MOAGENT_DISPATCH_MODE=worker.');
  }
  const registration = await MoAgentWorkerRegistrySession.start({
    processConcurrency: concurrency,
    globalConcurrency,
    leaseTtlMs: slotLeaseTtlMs,
    heartbeatIntervalMs: slotHeartbeatIntervalMs,
  });
  try {
    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
      process.on(signal, () => {
        stopping = true;
      });
    }
    console.log(JSON.stringify({
      event: 'generation_worker_ready',
      workerId: registration.claim.id,
      concurrency,
      globalConcurrency,
      pollIntervalMs,
    }));
    do {
      registration.assertHealthy();
      const processed = await tick(registration.leaseOwner);
      registration.assertHealthy();
      if (once || stopping) break;
      if (processed === 0) await delay(pollIntervalMs);
    } while (!stopping);
  } finally {
    await registration.stop().catch((error) => {
      console.error(
        `[GenerationWorker] Failed to stop Worker registration: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  }
}

main()
  .catch((error) => {
    console.error(`[GenerationWorker] fatal: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect().catch(() => undefined);
  });
