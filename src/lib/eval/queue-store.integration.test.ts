import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { createEvalQueueStore } from './queue-store';
import { checkQuantEvalSchedule, updateQuantEvalSchedule } from './runtime';
import type { QuantEvalQueueItem } from './types';

const databaseUrl = process.env.PI_AGENT_TEST_DATABASE_URL?.trim();

describe.skipIf(!databaseUrl)('durable evaluation queue (isolated PostgreSQL)', () => {
  const a = new PrismaClient({ datasourceUrl: databaseUrl });
  const b = new PrismaClient({ datasourceUrl: databaseUrl });
  const storeA = createEvalQueueStore(a);
  const storeB = createEvalQueueStore(b);
  const prefix = `eval-it-${randomUUID()}-`;

  function item(suffix: string): QuantEvalQueueItem {
    return {
      id: prefix + suffix, status: 'queued', cli: 'pi', model: 'captured-model-v1',
      reasoningEffort: '', evaluatorId: 'rule-strict', concurrency: 1, repeat: 1,
      mode: 'contract', selectedCases: [], limit: null, keepProjects: false,
      reportId: null, reportPath: null, logPath: null, pid: null, exitCode: null,
      error: null, createdAt: new Date().toISOString(), startedAt: null, finishedAt: null,
    };
  }

  afterEach(async () => {
    await a.evalQueueItem.deleteMany({ where: { id: { startsWith: prefix } } });
  });
  afterAll(async () => { await Promise.all([a.$disconnect(), b.$disconnect()]); });

  it('preserves concurrent enqueues and claims oldest work beyond the dashboard window', async () => {
    const oldest = { ...item('oldest'), createdAt: '2020-01-01T00:00:00.000Z' };
    await storeA.enqueue(oldest);
    await Promise.all(Array.from({ length: 90 }, (_, i) => storeB.enqueue(item(String(i)))));
    expect(await a.evalQueueItem.count({ where: { id: { startsWith: prefix } } })).toBe(91);
    expect((await storeB.list()).some((row) => row.id === oldest.id)).toBe(false);
    expect((await storeB.claim())?.item).toMatchObject({ id: oldest.id, model: 'captured-model-v1' });
  });

  it('allows only one active claim across independent clients', async () => {
    await storeA.enqueue(item('one'));
    await storeA.enqueue(item('two'));
    const claims = await Promise.all([storeA.claim(), storeB.claim(), storeA.claim(), storeB.claim()]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(await a.evalQueueItem.count({ where: { status: 'running', id: { startsWith: prefix } } })).toBe(1);
  });

  it('rejects foreign lease writes, while allowing the owner to commit once', async () => {
    await storeA.enqueue(item('fence'));
    const claim = (await storeA.claim())!;
    const forged = { ...claim, leaseToken: randomUUID() };
    expect(await storeB.heartbeat(forged)).toBe(false);
    expect(await storeB.recordProcess(forged, 999, 'wrong.log')).toBe(false);
    expect(await storeB.finish(forged, { status: 'passed', exitCode: 0, error: null })).toBe(false);
    expect(await storeA.heartbeat(claim)).toBe(true);
    expect(await storeA.finish(claim, { status: 'passed', exitCode: 0, error: null })).toBe(true);
    expect(await storeA.finish(claim, { status: 'failed', exitCode: 1, error: 'late event' })).toBe(false);
  });

  it('keeps cancellation terminal and capacity occupied until the owner has stopped', async () => {
    const first = item('cancel');
    await storeA.enqueue(first);
    const claim = (await storeA.claim())!;
    await storeA.enqueue(item('next'));
    expect((await storeB.cancel(first.id)).status).toBe('cancelled');
    expect(await storeA.heartbeat(claim)).toBe(false);
    expect(await storeB.claim()).toBeNull();
    expect(await storeA.finish(claim, { status: 'passed', exitCode: 0, error: null })).toBe(false);
    await storeA.releaseCancelled(claim);
    expect((await storeB.claim())?.item.id).toBe(prefix + 'next');
    expect((await storeB.cancel(first.id)).status).toBe('cancelled');
  });

  it('recovers after a crashed owner without rerunning a potentially billed benchmark', async () => {
    await storeA.enqueue(item('crash'));
    const stale = (await storeA.claim())!;
    await storeA.enqueue(item('survivor'));
    await a.evalQueueItem.update({
      where: { id: stale.item.id }, data: { leaseExpiresAt: new Date(0) },
    });
    expect((await storeB.claim())?.item.id).toBe(prefix + 'survivor');
    expect(await a.evalQueueItem.findUnique({ where: { id: stale.item.id } })).toMatchObject({
      status: 'failed', attemptCount: 1, leaseToken: null,
    });
    expect(await storeA.heartbeat(stale)).toBe(false);
    expect(await storeA.finish(stale, { status: 'passed', exitCode: 0, error: null })).toBe(false);
  });

  it('atomically advances a due schedule and enqueues exactly once', async () => {
    await updateQuantEvalSchedule({ enabled: true, intervalHours: 24, nextRunAt: new Date(0).toISOString() });
    let queuedId: string | undefined;
    try {
      const results = await Promise.all(Array.from({ length: 6 }, () => checkQuantEvalSchedule()));
      const queued = results.filter((result) => result.queued);
      expect(queued).toHaveLength(1);
      queuedId = queued[0].item?.id;
      expect(await a.evalSchedule.findUnique({ where: { id: 'default' } })).toMatchObject({ lastQueuedRunId: queuedId });
      expect(await a.evalQueueItem.findUnique({ where: { id: queuedId } })).toMatchObject({ status: 'queued' });
    } finally {
      await a.evalSchedule.deleteMany({ where: { id: 'default' } });
      if (queuedId) await a.evalQueueItem.delete({ where: { id: queuedId } });
    }
  });
});
