import { describe, expect, it, vi } from 'vitest';
import { startPersistentValidatedPreview } from './generation-preview';

describe('persistent validated generation preview', () => {
  it('returns only after the persistent preview is running with a URL', async () => {
    const startPreview = vi.fn(async () => ({
      port: 4100,
      url: 'http://localhost:4100',
      status: 'running' as const,
      logs: [],
    }));

    await expect(
      startPersistentValidatedPreview({ projectId: 'project-ready', startPreview }),
    ).resolves.toEqual({
      port: 4100,
      url: 'http://localhost:4100',
      status: 'running',
    });
    expect(startPreview).toHaveBeenCalledOnce();
    expect(startPreview).toHaveBeenCalledWith('project-ready');
  });

  it.each([
    { status: 'starting' as const, url: 'http://localhost:4100' },
    { status: 'error' as const, url: null },
    { status: 'running' as const, url: null },
  ])('rejects a non-ready terminal preview: $status / $url', async ({ status, url }) => {
    await expect(
      startPersistentValidatedPreview({
        projectId: 'project-not-ready',
        startPreview: async () => ({ port: null, url, status, logs: [] }),
      }),
    ).rejects.toThrow('Persistent preview is not ready');
  });
});
