import { describe, expect, it, vi } from 'vitest';
import { RequestActivityMonitor } from './request-activity-monitor';

const activity = (activeCount: number) => Response.json({ activeCount, hasActiveRequests: activeCount > 0 });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('request activity reconciliation', () => {
  it('calls the transport without binding the monitor as its browser receiver', async () => {
    const monitor = new RequestActivityMonitor('/activity', function (this: unknown) {
      expect(this).toBeUndefined();
      return Promise.resolve(activity(1));
    });
    await monitor.refresh();
    expect(monitor.getSnapshot().activeCount).toBe(1);
  });

  it('preserves running work across network errors and confirms completion after recovery', async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(activity(2))
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(activity(0));
    const monitor = new RequestActivityMonitor('/activity', request);
    await monitor.refresh();
    await monitor.refresh();
    expect(monitor.getSnapshot()).toEqual({ hasActiveRequests: true, activeCount: 2 });
    await monitor.refresh();
    expect(monitor.getSnapshot().hasActiveRequests).toBe(false);
  });

  it.each([401, 404, 503])('does not treat HTTP %s as task completion', async (status) => {
    const monitor = new RequestActivityMonitor(
      '/activity',
      vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status }))
    );
    monitor.register('submitted');
    await monitor.refresh();
    expect(monitor.getSnapshot().hasActiveRequests).toBe(true);
  });

  it('coalesces overlapping reads and retries after they settle', async () => {
    const response = deferred<Response>();
    const request = vi.fn<typeof fetch>().mockReturnValueOnce(response.promise).mockResolvedValueOnce(activity(0));
    const monitor = new RequestActivityMonitor('/activity', request);
    const first = monitor.refresh();
    expect(monitor.refresh()).toBe(first);
    expect(request).toHaveBeenCalledTimes(1);
    response.resolve(activity(1));
    await first;
    await monitor.refresh();
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('ignores an old idle body after a new request has been registered', async () => {
    const body = deferred<unknown>();
    const request = vi.fn<typeof fetch>().mockResolvedValue({ ok: true, json: () => body.promise } as Response);
    const monitor = new RequestActivityMonitor('/activity', request);
    const read = monitor.refresh();
    await Promise.resolve();
    monitor.register('new-task');
    body.resolve({ hasActiveRequests: false, activeCount: 0 });
    await read;
    expect(monitor.getSnapshot().activeCount).toBe(1);
    expect(request.mock.calls[0][1]?.signal?.aborted).toBe(true);
  });

  it('waits for the authoritative count when one request completes', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValueOnce(activity(2)).mockResolvedValueOnce(activity(1));
    const monitor = new RequestActivityMonitor('/activity', request);
    await monitor.refresh();
    monitor.complete('one-task');
    expect(monitor.getSnapshot().activeCount).toBe(2);
    await monitor.refresh();
    expect(monitor.getSnapshot().activeCount).toBe(1);
  });

  it.each([
    null,
    { activeCount: -1, hasActiveRequests: false },
    { activeCount: 0, hasActiveRequests: true },
    { activeCount: '0', hasActiveRequests: false },
  ])('preserves activity on malformed responses: %j', async (data) => {
    const monitor = new RequestActivityMonitor(
      '/activity',
      vi.fn<typeof fetch>().mockResolvedValue(Response.json(data))
    );
    monitor.register('submitted');
    await monitor.refresh();
    expect(monitor.getSnapshot().hasActiveRequests).toBe(true);
  });

  it('aborts workspace cleanup and rejects late responses after reactivation', async () => {
    const response = deferred<Response>();
    const request = vi.fn<typeof fetch>().mockReturnValueOnce(response.promise).mockResolvedValueOnce(activity(0));
    const monitor = new RequestActivityMonitor('/activity', request);
    const read = monitor.refresh();
    monitor.dispose();
    monitor.activate();
    response.resolve(activity(3));
    await read;
    expect(monitor.getSnapshot().activeCount).toBe(0);
    await monitor.refresh();
    expect(request).toHaveBeenCalledTimes(2);
  });
});
