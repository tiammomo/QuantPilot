import { afterEach, describe, expect, it, vi } from 'vitest';
import type { QuantGenerationTerminalSnapshot } from '@/lib/quant/generation-terminal';
import { GenerationPreviewController } from './generation-preview-controller';

const snapshot = (patch: Partial<QuantGenerationTerminalSnapshot> = {}): QuantGenerationTerminalSnapshot => ({
  requestId: 'request-1',
  status: 'ready',
  terminal: true,
  validationStatus: 'passed',
  validationRunId: 'request-1',
  validationMatchesCurrentRun: true,
  missionAcceptanceRequired: true,
  missionAcceptanceSatisfied: true,
  acceptedReceiptId: 'receipt-1',
  previewStatus: 'running',
  previewUrl: '/preview/one',
  previewPort: 4101,
  persistedPreviewUrl: '/preview/one',
  errorMessage: null,
  ...patch,
});
const pending = () => snapshot({ status: 'preview_pending', previewUrl: null });
const json = (data: unknown) => Response.json({ data });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function controller(fetcher: typeof fetch, visual = false) {
  const onReveal = vi.fn();
  return {
    onReveal,
    engine: new GenerationPreviewController({
      projectId: 'project-a',
      isVisualCheck: visual,
      fetch: fetcher,
      onReveal,
    }),
  };
}
afterEach(() => vi.useRealTimers());

describe('generation preview lifecycle', () => {
  it('withholds provisional previews until the current Mission is accepted', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json(snapshot({ missionAcceptanceSatisfied: false })));
    const { engine, onReveal } = controller(fetcher);
    await engine.reconcile();
    expect(engine.getSnapshot()).toMatchObject({ previewUrl: null, isRunning: true, quantValidationState: 'running' });
    expect(await engine.start()).toBe(false);
    expect(fetcher.mock.calls.every(([url]) => String(url).endsWith('/generation/status'))).toBe(true);
    expect(onReveal).not.toHaveBeenCalled();
  });

  it('coalesces overlapping polls and starts recovery once while the POST is pending', async () => {
    const started = deferred<Response>();
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(async (url) => (String(url).endsWith('preview/start') ? started.promise : json(pending())));
    const { engine } = controller(fetcher);
    await Promise.all([engine.reconcile(), engine.reconcile()]);
    await engine.reconcile();
    expect(fetcher.mock.calls.filter(([url]) => String(url).endsWith('preview/start'))).toHaveLength(1);
    started.resolve(json({ url: '/preview/recovered' }));
    await vi.waitFor(() => expect(engine.getSnapshot().previewUrl).toBe('/preview/recovered'));
    engine.dispose();
  });

  it('keeps an explicit stop authoritative when an old start and progress timers finish late', async () => {
    vi.useFakeTimers();
    const started = deferred<Response>();
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url) => {
      if (String(url).endsWith('preview/start')) return started.promise;
      return json({});
    });
    const { engine, onReveal } = controller(fetcher);
    const start = engine.start({ acceptedSnapshot: pending() });
    await engine.stop();
    await vi.advanceTimersByTimeAsync(3000);
    started.resolve(json({ url: '/preview/obsolete' }));
    await start;
    expect(engine.getSnapshot()).toMatchObject({
      previewUrl: null,
      isStartingPreview: false,
      previewInitializationMessage: '预览已停止。',
    });
    expect(onReveal).not.toHaveBeenCalled();
  });

  it('ignores both an old response and an old server snapshot after a new request starts', async () => {
    const old = deferred<Response>();
    const fetcher = vi
      .fn<typeof fetch>()
      .mockReturnValueOnce(old.promise)
      .mockResolvedValueOnce(json(snapshot()))
      .mockResolvedValueOnce(json(snapshot({ requestId: 'request-2' })));
    const { engine } = controller(fetcher);
    const first = engine.reconcile();
    engine.beginGeneration('request-2');
    old.resolve(json(snapshot()));
    await first;
    await engine.reconcile();
    expect(engine.getSnapshot()).toMatchObject({ previewUrl: null, isRunning: true });
    await engine.reconcile();
    expect(engine.getSnapshot()).toMatchObject({ previewUrl: '/preview/one', isRunning: false });
  });

  it.each(['cancelled', 'needs_clarification', 'refused'] as const)(
    'discards an outstanding preview start after %s',
    async (status) => {
      const started = deferred<Response>();
      const fetcher = vi
        .fn<typeof fetch>()
        .mockImplementation(async (url) =>
          String(url).endsWith('preview/start') ? started.promise : json(snapshot({ status, previewUrl: null }))
        );
      const { engine, onReveal } = controller(fetcher);
      const start = engine.start({ acceptedSnapshot: pending() });
      await engine.reconcile();
      started.resolve(json({ url: '/preview/obsolete' }));
      expect(await start).toBe(false);
      expect(engine.getSnapshot()).toMatchObject({ isRunning: false, isStartingPreview: false, previewUrl: null });
      expect(onReveal).not.toHaveBeenCalled();
    }
  );

  it('does not let an old acknowledgement or rejection change the current request', async () => {
    const { engine } = controller(vi.fn<typeof fetch>().mockResolvedValue(json(snapshot({ requestId: 'request-2' }))));
    engine.beginGeneration('request-1');
    engine.beginGeneration('request-2');
    engine.trackRequest('old-server-id', 'request-1');
    engine.rejectRequest('request-1');
    expect(engine.getSnapshot().isRunning).toBe(true);
    await engine.reconcile();
    expect(engine.getSnapshot().previewUrl).toBe('/preview/one');
  });

  it.each([
    { missionAcceptanceSatisfied: false },
    { status: 'running' as const, validationStatus: 'pending' as const },
  ])('aborts an old preview start when a new snapshot withholds delivery: %j', async patch => {
    const started = deferred<Response>();
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async url =>
      String(url).endsWith('preview/start') ? started.promise : json(snapshot(patch)));
    const { engine, onReveal } = controller(fetcher);
    engine.hasActiveRequests = true;
    const start = engine.start({ acceptedSnapshot: pending() });
    await engine.reconcile();
    started.resolve(json({ url: '/preview/obsolete' }));
    expect(await start).toBe(false);
    expect(engine.getSnapshot()).toMatchObject({ isRunning: true, isStartingPreview: false, previewUrl: null });
    expect(onReveal).not.toHaveBeenCalled();
  });

  it('does not steal file-editor focus when an unchanged ready snapshot is polled', async () => {
    const { engine, onReveal } = controller(vi.fn<typeof fetch>().mockImplementation(async () => json(snapshot())));
    await engine.reconcile();
    await engine.reconcile();
    expect(onReveal).toHaveBeenCalledTimes(1);
  });

  it('keeps a stopped preview hidden across ready polls, and allows an explicit restart', async () => {
    const { engine } = controller(vi.fn<typeof fetch>().mockImplementation(async () => json(snapshot())));
    await engine.reconcile();
    await engine.stop();
    await engine.reconcile();
    expect(engine.getSnapshot().previewUrl).toBeNull();
    expect(await engine.start()).toBe(true);
    expect(engine.getSnapshot().previewUrl).toBe('/preview/one');
  });

  it('does not let a disposed project publish a late parsed response', async () => {
    const body = deferred<unknown>();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue({ ok: true, json: () => body.promise } as Response);
    const { engine, onReveal } = controller(fetcher);
    const read = engine.reconcile();
    await Promise.resolve();
    engine.dispose();
    body.resolve({ data: snapshot() });
    await read;
    expect(engine.getSnapshot().previewUrl).toBeNull();
    expect(onReveal).not.toHaveBeenCalled();
    expect(fetcher.mock.calls[0][1]?.signal?.aborted).toBe(true);
  });

  it('blocks a stale validation rerun when another generation supersedes its GET', async () => {
    const validation = deferred<unknown>();
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json(snapshot({ status: 'running', validationStatus: 'pending', previewUrl: null })))
      .mockResolvedValueOnce({ ok: true, json: () => validation.promise } as Response);
    const { engine } = controller(fetcher);
    const read = engine.reconcile();
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    engine.beginGeneration('request-2');
    validation.resolve({
      data: { checks: [{ id: 'validation_report_stale' }] },
      generationState: { status: 'completed' },
    });
    await read;
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(engine.getSnapshot()).toMatchObject({ quantValidationState: 'running', previewUrl: null });
  });

  it('allows retry after a failed poll and preserves the accepted URL on transport failure', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(json(snapshot()))
      .mockRejectedValueOnce(new Error('offline'));
    const { engine } = controller(fetcher);
    await engine.reconcile();
    await engine.reconcile();
    await engine.reconcile();
    expect(engine.getSnapshot().previewUrl).toBe('/preview/one');
  });

  it('does not auto-recover a failed preview until the user retries', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => json(pending()));
    const { engine } = controller(fetcher);
    engine.handleStatus('preview_failed');
    await engine.reconcile();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(engine.getSnapshot().isStartingPreview).toBe(false);
  });

  it('keeps visual checks read-only and realtime success provisional', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => json(pending()));
    const { engine } = controller(fetcher, true);
    expect(engine.handleStatus('validation_passed', undefined, { previewUrl: '/unsafe/provisional' })).toBe(true);
    await engine.reconcile();
    expect(await engine.start()).toBe(false);
    expect(engine.getSnapshot().previewUrl).toBeNull();
    expect(fetcher.mock.calls.every(([, init]) => init?.method !== 'POST')).toBe(true);
  });
});
