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

describe('generation terminal snapshot', () => {
  it('is ready only after current-run validation and a running preview URL', () => {
    const snapshot = deriveQuantGenerationTerminalSnapshot({
      generation: { requestId: 'request-1', status: 'completed', error: null },
      validation: validation('request-1'),
      preview: preview('running', 'http://localhost:4100'),
      persistedPreviewUrl: 'http://localhost:4100',
    });

    expect(snapshot).toMatchObject({
      status: 'ready',
      terminal: true,
      validationMatchesCurrentRun: true,
      previewUrl: 'http://localhost:4100',
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
