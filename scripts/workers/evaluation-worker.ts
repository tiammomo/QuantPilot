#!/usr/bin/env node
import './worker-environment';
import { prisma } from '../../src/lib/db/client';
import { evalQueueStore } from '../../src/lib/eval/queue-store';
import { executeEvalClaim } from '../../src/lib/eval/queue-executor';
import { checkQuantEvalSchedule } from '../../src/lib/eval/runtime';
import { setTimeout as delay } from 'node:timers/promises';

const controller = new AbortController();
const once = process.argv.includes('--once');
process.once('SIGINT', () => controller.abort());
process.once('SIGTERM', () => controller.abort());

async function main() {
  console.log('[EvalWorker] PostgreSQL queue consumer started.');
  do {
    try {
      await checkQuantEvalSchedule();
      const claim = await evalQueueStore.claim();
      if (claim) {
        console.log(JSON.stringify({ event: 'eval_worker_claimed', id: claim.item.id, attempt: claim.attemptCount }));
        await executeEvalClaim(claim, controller.signal);
      }
    } catch (error) {
      console.error('[EvalWorker] Queue cycle failed:', error);
      if (once) throw error;
    }
    if (!once && !controller.signal.aborted) {
      await delay(2_000, undefined, { signal: controller.signal }).catch(() => undefined);
    }
  } while (!once && !controller.signal.aborted);
}

void main().catch(() => { process.exitCode = 1; }).finally(() => prisma.$disconnect());
