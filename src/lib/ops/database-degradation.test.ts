import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ projects: vi.fn(), traceProjects: vi.fn(), queryRaw: vi.fn(), workers: vi.fn(), slots: vi.fn() }));
vi.mock('@/lib/services/project', () => ({ getAllProjects: mocks.projects }));
vi.mock('@/lib/db/client', () => ({
  prisma: {
    project: { findMany: mocks.traceProjects },
    $queryRaw: mocks.queryRaw,
    agentWorkerInstance: { findMany: mocks.workers },
    agentWorkerSlot: { findMany: mocks.slots },
  },
}));

import { getWorkspaceHealthDashboard } from '@/lib/quant/workspace-health';
import { getGenerationObservabilityDashboard } from '@/lib/quant/generation-observability';
import { getAgentWorkerRuntimeDashboard } from './agent-worker-observability';

afterEach(() => vi.unstubAllEnvs());

describe('ops page database degradation', () => {
  it('skips all database-backed workspace, trace and Worker reads when explicitly disabled', async () => {
    vi.stubEnv('QUANTPILOT_DATABASE_ENABLED', '0');
    const [health, trace, workers] = await Promise.all([
      getWorkspaceHealthDashboard(),
      getGenerationObservabilityDashboard(),
      getAgentWorkerRuntimeDashboard(),
    ]);

    for (const query of Object.values(mocks)) expect(query).not.toHaveBeenCalled();
    expect(health.projects).toEqual([]);
    expect(trace.projects).toEqual([]);
    expect(workers.available).toBe(false);
    expect(workers.error).toContain('停用');
  });

  it('preserves required database failures instead of treating them as an empty workspace', async () => {
    vi.stubEnv('QUANTPILOT_DATABASE_ENABLED', '1');
    mocks.projects.mockRejectedValue(new Error('database unavailable'));
    mocks.traceProjects.mockRejectedValue(new Error('database unavailable'));

    await expect(getWorkspaceHealthDashboard()).rejects.toThrow('database unavailable');
    await expect(getGenerationObservabilityDashboard()).rejects.toThrow('database unavailable');
  });
});
