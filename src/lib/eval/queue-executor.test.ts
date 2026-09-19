import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { executeEvalClaim, reportBelongsToClaim } from './queue-executor';
import type { EvalQueueClaim } from './queue-store';

const store = vi.hoisted(() => ({
  heartbeat: vi.fn(), recordProcess: vi.fn(), finish: vi.fn(), releaseCancelled: vi.fn(),
}));
vi.mock('./queue-store', () => ({ EVAL_LEASE_MS: 60_000, evalQueueStore: store }));
vi.mock('node:child_process', () => ({ spawn: vi.fn() }));
vi.mock('./runtime', () => ({
  buildBenchmarkArgs: () => [], getQuantEvalRun: vi.fn(), createRepairTicketsForRun: vi.fn(),
}));

const claim = {
  item: { id: 'queued-1', mode: 'contract', model: 'captured-model' },
  leaseToken: 'attempt-1', attemptCount: 1,
} as EvalQueueClaim;
const metadata = {
  queue: { id: 'queued-1', leaseToken: 'attempt-1' },
  suite: { mode: 'contract' }, runtime: { configuredModel: 'captured-model' },
};

describe('evaluation report ownership', () => {
  it('requires the exact job, lease, mode and captured model', () => {
    expect(reportBelongsToClaim({ metadata }, claim)).toBe(true);
    for (const changed of [
      { queue: { ...metadata.queue, id: 'other-job' } },
      { queue: { ...metadata.queue, leaseToken: 'old-attempt' } },
      { suite: { mode: 'e2e' } },
      { runtime: { configuredModel: 'new-default-model' } },
      { queue: null },
    ]) {
      expect(reportBelongsToClaim({ metadata: { ...metadata, ...changed } }, claim)).toBe(false);
    }
  });
  it('rejects unbound reports even if they were produced at the same time', () => {
    expect(reportBelongsToClaim({ metadata: { ...metadata, queue: undefined } }, claim)).toBe(false);
    expect(reportBelongsToClaim(null, claim)).toBe(false);
  });
});

describe('evaluation child lifecycle', () => {
  let child: EventEmitter & { pid: number; kill: ReturnType<typeof vi.fn> };
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'performance'] });
    child = Object.assign(new EventEmitter(), { pid: 34567, kill: vi.fn() });
    vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>);
    store.heartbeat.mockReset().mockResolvedValue(true);
    store.recordProcess.mockReset().mockResolvedValue(true);
    store.finish.mockReset().mockResolvedValue(true);
    store.releaseCancelled.mockReset().mockResolvedValue(undefined);
    vi.spyOn(fs, 'mkdir').mockResolvedValue(undefined);
    vi.spyOn(fs, 'open').mockResolvedValue({ fd: 123, close: vi.fn() } as unknown as Awaited<ReturnType<typeof fs.open>>);
    vi.spyOn(fs, 'readFile').mockRejectedValue(new Error('No report'));
    vi.spyOn(process, 'kill').mockImplementation((_pid, signal) => {
      if (signal === 'SIGTERM') queueMicrotask(() => child.emit('close', null, 'SIGTERM'));
      return true;
    });
  });
  afterEach(() => { vi.useRealTimers(); });

  it('fails a clean process exit without an owned report', async () => {
    const execution = executeEvalClaim(claim, new AbortController().signal);
    await vi.advanceTimersByTimeAsync(0);
    child.emit('close', 0, null);
    await execution;
    expect(store.finish).toHaveBeenCalledWith(claim, expect.objectContaining({ status: 'failed', reportId: undefined }));
  });

  it('does not launch work after cancellation won the claim race', async () => {
    store.heartbeat.mockResolvedValue(false);
    await executeEvalClaim(claim, new AbortController().signal);
    expect(spawn).not.toHaveBeenCalled();
    expect(store.releaseCancelled).toHaveBeenCalledWith(claim);
  });

  it('stops its process group on lost ownership without overwriting cancellation', async () => {
    store.heartbeat.mockResolvedValueOnce(true).mockResolvedValue(false);
    const execution = executeEvalClaim(claim, new AbortController().signal);
    await vi.advanceTimersByTimeAsync(13_000);
    await execution;
    expect(process.kill).toHaveBeenCalledWith(-child.pid, 'SIGTERM');
    expect(process.kill).toHaveBeenCalledWith(-child.pid, 'SIGKILL');
    expect(store.finish).not.toHaveBeenCalled();
  });

  it('expires locally even when a database heartbeat never settles', async () => {
    store.heartbeat.mockResolvedValueOnce(true).mockImplementation(() => new Promise(() => {}));
    const execution = executeEvalClaim(claim, new AbortController().signal);
    await vi.advanceTimersByTimeAsync(55_000);
    expect(process.kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(8_000);
    await execution;
    expect(process.kill).toHaveBeenCalledWith(-child.pid, 'SIGTERM');
    expect(store.finish).not.toHaveBeenCalled();
  });

  it('stops on Worker shutdown and records an interrupted evaluation', async () => {
    const controller = new AbortController();
    const execution = executeEvalClaim(claim, controller.signal);
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    await vi.advanceTimersByTimeAsync(3_000);
    await execution;
    expect(store.finish).toHaveBeenCalledWith(claim, expect.objectContaining({ status: 'failed' }));
  });
});
