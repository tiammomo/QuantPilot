import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getProjectById: vi.fn(),
  readGeneration: vi.fn(),
  readValidation: vi.fn(),
  readAcceptedMission: vi.fn(),
  getPreviewStatus: vi.fn(),
}));

vi.mock('@/lib/services/project', () => ({
  getProjectById: mocks.getProjectById,
}));

vi.mock('@/lib/quant/generation-state', () => ({
  readQuantGenerationState: mocks.readGeneration,
}));

vi.mock('@/lib/quant/validation', () => ({
  readQuantValidationReport: mocks.readValidation,
}));

vi.mock('@/lib/services/moagent-mission-store', () => ({
  readMoAgentAcceptedMissionSnapshot: mocks.readAcceptedMission,
}));

vi.mock('@/lib/services/preview', () => ({
  previewManager: { getStatus: mocks.getPreviewStatus },
}));

import { GET } from './route';

const context = { params: Promise.resolve({ project_id: 'project-1' }) };

function generation(cliPreference: string | null = 'moagent') {
  return {
    schemaVersion: 1 as const,
    projectId: 'project-1',
    requestId: 'request-1',
    status: 'completed' as const,
    activeStep: 'completed' as const,
    createdAt: '2026-07-15T00:00:00.000Z',
    updatedAt: '2026-07-15T00:01:00.000Z',
    completedAt: '2026-07-15T00:01:00.000Z',
    originalInstruction: 'build dashboard',
    cliPreference,
    selectedModel: 'deepseek-v4-flash',
    repairAttemptCount: 0,
    maxRepairAttempts: 3,
    steps: [
      {
        id: 'completed' as const,
        label: '完成',
        status: 'success' as const,
        startedAt: '2026-07-15T00:00:50.000Z',
        completedAt: '2026-07-15T00:01:00.000Z',
        summary: 'done',
        metadata: { generationId: 'generation-1' },
      },
    ],
    error: null,
  };
}

const passedValidation = {
  runId: 'request-1',
  status: 'passed' as const,
  passed: true,
  checks: [],
};

const acceptedMission = {
  missionId: 'mission-1',
  generationId: 'generation-1',
  projectId: 'project-1',
  requestId: 'request-1',
  missionStatus: 'completed' as const,
  candidateVersion: 1,
  acceptedReceiptId: 'receipt-1',
  acceptedReceiptHash: `sha256:${'a'.repeat(64)}`,
  acceptedAt: '2026-07-15T00:00:59.000Z',
  previewUrl: 'http://localhost:4100',
  previewPort: 4100,
};

describe('generation status acceptance gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getProjectById.mockResolvedValue({
      id: 'project-1',
      repoPath: '/tmp/project-1',
      previewUrl: 'http://localhost:4100',
    });
    mocks.readGeneration.mockResolvedValue(generation());
    mocks.readValidation.mockResolvedValue(passedValidation);
    mocks.getPreviewStatus.mockReturnValue({
      status: 'running',
      url: 'http://localhost:4100',
      port: 4100,
      logs: [],
    });
  });

  it('fails closed when the current MoAgent request has no accepted receipt', async () => {
    mocks.readAcceptedMission.mockResolvedValue(null);

    const response = await GET(
      new Request('http://localhost') as never,
      context,
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mocks.readAcceptedMission).toHaveBeenCalledWith(
      'project-1',
      'request-1',
    );
    expect(body.data).toMatchObject({
      status: 'preview_pending',
      terminal: false,
      missionAcceptanceRequired: true,
      missionAcceptanceSatisfied: false,
      acceptedReceiptId: null,
      previewUrl: null,
    });
  });

  it('returns ready only for the accepted Mission bound to the current generation', async () => {
    mocks.readAcceptedMission.mockResolvedValue(acceptedMission);

    const response = await GET(
      new Request('http://localhost') as never,
      context,
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data).toMatchObject({
      status: 'ready',
      terminal: true,
      missionAcceptanceRequired: true,
      missionAcceptanceSatisfied: true,
      acceptedReceiptId: 'receipt-1',
      previewUrl: 'http://localhost:4100',
    });
  });

  it('does not require Mission storage for a legacy non-MoAgent generation', async () => {
    mocks.readGeneration.mockResolvedValue(generation('legacy'));

    const response = await GET(
      new Request('http://localhost') as never,
      context,
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mocks.readAcceptedMission).not.toHaveBeenCalled();
    expect(body.data).toMatchObject({
      status: 'ready',
      missionAcceptanceRequired: false,
      missionAcceptanceSatisfied: true,
    });
  });

  it('queries Mission storage for recovery state that has identity metadata but no cliPreference', async () => {
    mocks.readGeneration.mockResolvedValue(generation(null));
    mocks.readAcceptedMission.mockResolvedValue(null);

    const response = await GET(
      new Request('http://localhost') as never,
      context,
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mocks.readAcceptedMission).toHaveBeenCalledWith(
      'project-1',
      'request-1',
    );
    expect(body.data).toMatchObject({
      status: 'preview_pending',
      missionAcceptanceRequired: true,
      missionAcceptanceSatisfied: false,
      previewUrl: null,
    });
  });
});
