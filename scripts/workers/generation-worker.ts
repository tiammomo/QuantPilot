#!/usr/bin/env node

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

function positiveInteger(name: string, fallback: number, max: number): number {
  const value = Number.parseInt(process.env[name] ?? '', 10) || fallback;
  if (!Number.isSafeInteger(value) || value < 1 || value > max) {
    throw new Error(`${name} must be an integer between 1 and ${max}.`);
  }
  return value;
}

const pollIntervalMs = positiveInteger('MOAGENT_WORKER_POLL_INTERVAL_MS', 1_000, 60_000);
const concurrency = positiveInteger('MOAGENT_WORKER_CONCURRENCY', 1, 16);
const claimBatchSize = positiveInteger('MOAGENT_WORKER_CLAIM_BATCH_SIZE', 20, 200);
const once = process.argv.includes('--once');
const runtime = createApplicationGenerationRuntime();
let stopping = false;

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function executeJob(job: Awaited<ReturnType<typeof listClaimableMoAgentGenerationJobs>>[number]) {
  let session: MoAgentGenerationDispatchSession | null = null;
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
  } catch (error) {
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
      return;
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
  } finally {
    session?.dispose();
  }
}

async function tick(): Promise<number> {
  await reconcileExpiredMoAgentGenerationJobs({ limit: claimBatchSize });
  const jobs = await listClaimableMoAgentGenerationJobs(claimBatchSize);
  let completed = 0;
  for (let index = 0; index < jobs.length && !stopping; index += concurrency) {
    const batch = jobs.slice(index, index + concurrency);
    await Promise.all(batch.map(executeJob));
    completed += batch.length;
  }
  return completed;
}

async function main() {
  if (process.env.MOAGENT_DISPATCH_MODE !== 'worker') {
    throw new Error('Generation worker requires MOAGENT_DISPATCH_MODE=worker.');
  }
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      stopping = true;
    });
  }
  console.log(JSON.stringify({
    event: 'generation_worker_ready',
    concurrency,
    pollIntervalMs,
  }));
  do {
    const processed = await tick();
    if (once || stopping) break;
    if (processed === 0) await delay(pollIntervalMs);
  } while (!stopping);
}

main()
  .catch((error) => {
    console.error(`[GenerationWorker] fatal: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect().catch(() => undefined);
  });
