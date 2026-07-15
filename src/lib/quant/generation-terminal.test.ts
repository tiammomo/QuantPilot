import { describe, expect, it } from 'vitest';
import type { QuantValidationCheck } from './validation';
import { deriveQuantGenerationTerminalSnapshot } from './generation-terminal';

const validation = (runId: string | undefined, passed = true) => ({
  runId,
  status: passed ? ('passed' as const) : ('failed' as const),
  passed,
  checks: [] as QuantValidationCheck[],
});

const preview = (
  status: 'starting' | 'running' | 'stopped' | 'error',
  url: string | null,
) => ({ status, url, port: url ? 4100 : null, logs: [] });

const moAgentGeneration = (
  requestId: string,
  generationId = 'generation-1',
) => ({
  projectId: 'project-1',
  requestId,
  status: 'completed' as const,
  cliPreference: 'moagent',
  error: null,
  steps: [{ metadata: { generationId } }],
});

const acceptedMission = (requestId: string, generationId = 'generation-1') => ({
  generationId,
  projectId: 'project-1',
  requestId,
  missionStatus: 'completed' as const,
  acceptedReceiptId: 'receipt-1',
  acceptedReceiptHash: `sha256:${'a'.repeat(64)}`,
  acceptedAt: '2026-07-15T00:00:00.000Z',
});

describe('generation terminal snapshot', () => {
  it('is ready only after current-run validation and a running preview URL', () => {
    const snapshot = deriveQuantGenerationTerminalSnapshot({
      generation: moAgentGeneration('request-1'),
      validation: validation('request-1'),
      preview: preview('running', 'http://localhost:4100'),
      acceptedMission: acceptedMission('request-1'),
      persistedPreviewUrl: 'http://localhost:4100',
    });

    expect(snapshot).toMatchObject({
      status: 'ready',
      terminal: true,
      validationMatchesCurrentRun: true,
      missionAcceptanceRequired: true,
      missionAcceptanceSatisfied: true,
      acceptedReceiptId: 'receipt-1',
      previewUrl: 'http://localhost:4100',
    });
  });

  it('fails closed for a MoAgent generation without an accepted receipt', () => {
    const snapshot = deriveQuantGenerationTerminalSnapshot({
      generation: moAgentGeneration('request-1'),
      validation: validation('request-1'),
      preview: preview('running', 'http://localhost:4100'),
      acceptedMission: null,
    });

    expect(snapshot).toMatchObject({
      status: 'preview_pending',
      terminal: false,
      missionAcceptanceRequired: true,
      missionAcceptanceSatisfied: false,
      acceptedReceiptId: null,
      previewUrl: null,
      previewPort: null,
    });
  });

  it.each([
    {
      name: 'request',
      mission: acceptedMission('request-other'),
    },
    {
      name: 'generation',
      mission: acceptedMission('request-1', 'generation-other'),
    },
    {
      name: 'project',
      mission: { ...acceptedMission('request-1'), projectId: 'project-other' },
    },
    {
      name: 'mission status',
      mission: {
        ...acceptedMission('request-1'),
        missionStatus: 'verifying' as const,
      },
    },
    {
      name: 'receipt material',
      mission: { ...acceptedMission('request-1'), acceptedReceiptHash: null },
    },
  ])(
    'rejects accepted evidence bound to a different or incomplete $name',
    ({ mission }) => {
      const snapshot = deriveQuantGenerationTerminalSnapshot({
        generation: moAgentGeneration('request-1'),
        validation: validation('request-1'),
        preview: preview('running', 'http://localhost:4100'),
        acceptedMission: mission,
      });

      expect(snapshot.status).toBe('preview_pending');
      expect(snapshot.missionAcceptanceSatisfied).toBe(false);
      expect(snapshot.previewUrl).toBeNull();
    },
  );

  it('keeps legacy non-MoAgent generations backward compatible without a receipt', () => {
    const snapshot = deriveQuantGenerationTerminalSnapshot({
      generation: {
        projectId: 'project-1',
        requestId: 'legacy-request',
        status: 'completed',
        cliPreference: 'legacy',
        error: null,
      },
      validation: validation('legacy-request'),
      preview: preview('running', 'http://localhost:4100'),
    });

    expect(snapshot).toMatchObject({
      status: 'ready',
      terminal: true,
      missionAcceptanceRequired: false,
      missionAcceptanceSatisfied: true,
      acceptedReceiptId: null,
      previewUrl: 'http://localhost:4100',
    });
  });

  it('keeps pre-Mission MoAgent generations readable without inventing a receipt', () => {
    const snapshot = deriveQuantGenerationTerminalSnapshot({
      generation: {
        projectId: 'project-1',
        requestId: 'legacy-moagent-request',
        status: 'completed',
        cliPreference: 'moagent',
        steps: [],
        error: null,
      },
      validation: validation('legacy-moagent-request'),
      preview: preview('running', 'http://localhost:4100'),
    });

    expect(snapshot).toMatchObject({
      status: 'ready',
      terminal: true,
      missionAcceptanceRequired: false,
      missionAcceptanceSatisfied: true,
    });
  });

  it('fails closed for Mission-backed recovery state without a cliPreference', () => {
    const snapshot = deriveQuantGenerationTerminalSnapshot({
      generation: {
        ...moAgentGeneration('request-1'),
        cliPreference: null,
      },
      validation: validation('request-1'),
      preview: preview('running', 'http://localhost:4100'),
    });

    expect(snapshot).toMatchObject({
      status: 'preview_pending',
      missionAcceptanceRequired: true,
      missionAcceptanceSatisfied: false,
      previewUrl: null,
    });
  });

  it('does not reuse a passed report from an older generation', () => {
    const snapshot = deriveQuantGenerationTerminalSnapshot({
      generation: { requestId: 'request-new', status: 'running', error: null },
      validation: validation('request-old'),
      preview: preview('running', 'http://localhost:4100'),
    });

    expect(snapshot).toMatchObject({
      status: 'running',
      terminal: false,
      validationStatus: 'pending',
      validationMatchesCurrentRun: false,
      previewUrl: null,
    });
  });

  it('keeps a validated run recoverable when its persistent preview is absent', () => {
    const snapshot = deriveQuantGenerationTerminalSnapshot({
      generation: {
        requestId: 'request-preview-failed',
        status: 'failed',
        error: { message: 'preview failed' },
      },
      validation: validation('request-preview-failed'),
      preview: preview('stopped', null),
    });

    expect(snapshot).toMatchObject({
      status: 'preview_pending',
      terminal: false,
      validationStatus: 'passed',
      errorMessage: 'preview failed',
    });
  });

  it('does not revive a failed Mission-backed generation from a passed report', () => {
    const snapshot = deriveQuantGenerationTerminalSnapshot({
      generation: {
        ...moAgentGeneration('request-mission-failed'),
        status: 'failed',
        error: { message: 'Mission verification failed' },
      },
      validation: validation('request-mission-failed'),
      preview: preview('running', 'http://localhost:4100'),
      acceptedMission: null,
    });

    expect(snapshot).toMatchObject({
      status: 'failed',
      terminal: true,
      missionAcceptanceRequired: true,
      missionAcceptanceSatisfied: false,
      previewUrl: null,
    });
  });

  it('rejects a stale passed validation report', () => {
    const report = validation('request-1');
    report.checks.push({
      id: 'validation_report_stale',
      name: 'stale',
      status: 'warning',
      summary: 'stale',
    });

    const snapshot = deriveQuantGenerationTerminalSnapshot({
      generation: { requestId: 'request-1', status: 'completed', error: null },
      validation: report,
      preview: preview('running', 'http://localhost:4100'),
    });

    expect(snapshot.status).toBe('running');
    expect(snapshot.validationStatus).toBe('pending');
    expect(snapshot.previewUrl).toBeNull();
  });
});
