import { describe, expect, it } from 'vitest';
import type { QuantValidationCheck } from "./validation/contracts";
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

const piAgentGeneration = (
  requestId: string,
  generationId = 'generation-1',
) => ({
  projectId: 'project-1',
  requestId,
  status: 'completed' as const,
  cliPreference: 'pi',
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
  it('exposes only the active step summary for recovery after a browser reload', () => {
    const snapshot = deriveQuantGenerationTerminalSnapshot({
      generation: {
        requestId: 'request-1', status: 'running', activeStep: 'data_prefetch',
        steps: [
          { id: 'planning', summary: '旧规划摘要' },
          { id: 'data_prefetch', summary: '数据预取已处理 2/4 个标的' },
        ],
      },
      validation: null, preview: preview('stopped', null),
    });
    expect(snapshot).toMatchObject({
      status: 'running', activeStep: 'data_prefetch', stepSummary: '数据预取已处理 2/4 个标的',
      previewUrl: null,
    });
  });

  it('projects a policy refusal as terminal without requiring validation or preview', () => {
    const snapshot = deriveQuantGenerationTerminalSnapshot({
      generation: {
        projectId: 'project-1',
        requestId: 'refused-request',
        status: 'refused',
        cliPreference: 'pi',
        error: null,
      },
      validation: null,
      preview: preview('stopped', null),
    });

    expect(snapshot).toMatchObject({
      status: 'refused',
      terminal: true,
      missionAcceptanceRequired: false,
      previewUrl: null,
    });
  });

  it('is ready only after current-run validation and a running preview URL', () => {
    const snapshot = deriveQuantGenerationTerminalSnapshot({
      generation: piAgentGeneration('request-1'),
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

  it('fails closed for a PI Agent generation without an accepted receipt', () => {
    const snapshot = deriveQuantGenerationTerminalSnapshot({
      generation: piAgentGeneration('request-1'),
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
        generation: piAgentGeneration('request-1'),
        validation: validation('request-1'),
        preview: preview('running', 'http://localhost:4100'),
        acceptedMission: mission,
      });

      expect(snapshot.status).toBe('preview_pending');
      expect(snapshot.missionAcceptanceSatisfied).toBe(false);
      expect(snapshot.previewUrl).toBeNull();
    },
  );

  it('fails closed when persisted generation identity is not canonical', () => {
    const snapshot = deriveQuantGenerationTerminalSnapshot({
      generation: {
        projectId: 'project-1',
        requestId: 'noncanonical-request',
        status: 'completed',
        cliPreference: 'unsupported',
        error: null,
      },
      validation: validation('noncanonical-request'),
      preview: preview('running', 'http://localhost:4100'),
    });

    expect(snapshot).toMatchObject({
      status: 'preview_pending',
      terminal: false,
      missionAcceptanceRequired: true,
      missionAcceptanceSatisfied: false,
      acceptedReceiptId: null,
      previewUrl: null,
    });
  });

  it('fails closed when a persisted PI Agent generation lacks Mission identity', () => {
    const snapshot = deriveQuantGenerationTerminalSnapshot({
      generation: {
        projectId: 'project-1',
        requestId: 'incomplete-request',
        status: 'completed',
        cliPreference: 'pi',
        steps: [],
        error: null,
      },
      validation: validation('incomplete-request'),
      preview: preview('running', 'http://localhost:4100'),
    });

    expect(snapshot).toMatchObject({
      status: 'preview_pending',
      terminal: false,
      missionAcceptanceRequired: true,
      missionAcceptanceSatisfied: false,
      previewUrl: null,
    });
  });

  it('fails closed for Mission-backed recovery state without a cliPreference', () => {
    const snapshot = deriveQuantGenerationTerminalSnapshot({
      generation: {
        ...piAgentGeneration('request-1'),
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

  it.each(['pending', 'running', 'repairing'] as const)(
    'keeps an intermediate failed validation non-terminal while generation is %s',
    (status) => {
      const snapshot = deriveQuantGenerationTerminalSnapshot({
        generation: {
          requestId: 'request-repairing',
          status,
          error: { message: 'intermediate validation failed' },
        },
        validation: validation('request-repairing', false),
        preview: preview('stopped', null),
      });

      expect(snapshot).toMatchObject({
        status: 'running',
        terminal: false,
        validationStatus: 'failed',
      });
    },
  );

  it('does not revive a failed generation from validation without acceptance', () => {
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
      status: 'failed',
      terminal: true,
      validationStatus: 'passed',
      missionAcceptanceRequired: true,
      missionAcceptanceSatisfied: false,
      errorMessage: 'preview failed',
    });
  });

  it('does not revive a failed Mission-backed generation from a passed report', () => {
    const snapshot = deriveQuantGenerationTerminalSnapshot({
      generation: {
        ...piAgentGeneration('request-mission-failed'),
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

    expect(snapshot.status).toBe('needs_revalidation');
    expect(snapshot.terminal).toBe(true);
    expect(snapshot.validationStatus).toBe('pending');
    expect(snapshot.previewUrl).toBeNull();
  });
});
