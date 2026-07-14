import type { QuantGenerationRunStatus } from '@/lib/quant/generation-state';
import type { QuantValidationReport } from '@/lib/quant/validation';
import type { PreviewInfo } from '@/lib/services/preview';

export type QuantGenerationTerminalStatus =
  | 'idle'
  | 'running'
  | 'preview_pending'
  | 'ready'
  | 'failed'
  | 'cancelled'
  | 'needs_clarification';

type GenerationStateInput = {
  requestId: string;
  status: QuantGenerationRunStatus;
  error?: { message?: string | null } | null;
} | null;

type ValidationReportInput = Pick<
  QuantValidationReport,
  'runId' | 'status' | 'passed' | 'checks'
> | null;

type PreviewInput = Pick<PreviewInfo, 'status' | 'url' | 'port'>;

export interface QuantGenerationTerminalSnapshot {
  requestId: string | null;
  status: QuantGenerationTerminalStatus;
  terminal: boolean;
  validationStatus: 'passed' | 'failed' | 'pending';
  validationRunId: string | null;
  validationMatchesCurrentRun: boolean;
  previewStatus: PreviewInfo['status'];
  previewUrl: string | null;
  previewPort: number | null;
  persistedPreviewUrl: string | null;
  errorMessage: string | null;
}

function isValidationReportStale(report: ValidationReportInput): boolean {
  return Boolean(
    report?.checks.some((check) => check.id === 'validation_report_stale'),
  );
}

/**
 * Derive the one authoritative user-facing generation state.
 * A healthy preview is never accepted for a different generation run, and an
 * Agent/validation success is not terminal until the preview is HTTP-ready.
 */
export function deriveQuantGenerationTerminalSnapshot(params: {
  generation: GenerationStateInput;
  validation: ValidationReportInput;
  preview: PreviewInput;
  persistedPreviewUrl?: string | null;
}): QuantGenerationTerminalSnapshot {
  const requestId = params.generation?.requestId ?? null;
  const validationRunId = params.validation?.runId ?? null;
  const validationMatchesCurrentRun = !params.generation
    ? true
    : validationRunId
      ? validationRunId === params.generation.requestId
      : params.generation.status === 'completed' || params.generation.status === 'failed';
  const validationStale = isValidationReportStale(params.validation);
  const validationPassed = Boolean(
    params.validation &&
      (params.validation.passed || params.validation.status === 'passed') &&
      validationMatchesCurrentRun &&
      !validationStale,
  );
  const validationFailed = Boolean(
    params.validation &&
      (!params.validation.passed || params.validation.status === 'failed') &&
      validationMatchesCurrentRun &&
      !validationStale,
  );
  const previewReady =
    params.preview.status === 'running' && Boolean(params.preview.url);
  const previewUrl = validationPassed && previewReady ? params.preview.url : null;

  let status: QuantGenerationTerminalStatus = 'idle';
  if (params.generation?.status === 'cancelled') {
    status = 'cancelled';
  } else if (params.generation?.status === 'needs_clarification') {
    status = 'needs_clarification';
  } else if (validationPassed && previewReady) {
    status = 'ready';
  } else if (validationPassed) {
    // This also intentionally covers a prior preview-start failure. Reopening
    // the project can safely retry/adopt the validated preview.
    status = 'preview_pending';
  } else if (
    params.generation &&
    params.validation &&
    (validationStale || !validationMatchesCurrentRun)
  ) {
    status = 'running';
  } else if (params.generation?.status === 'failed' || validationFailed) {
    status = 'failed';
  } else if (
    params.generation &&
    ['pending', 'running', 'repairing'].includes(params.generation.status)
  ) {
    status = 'running';
  }

  return {
    requestId,
    status,
    terminal: ['ready', 'failed', 'cancelled', 'needs_clarification'].includes(status),
    validationStatus: validationPassed
      ? 'passed'
      : validationFailed
        ? 'failed'
        : 'pending',
    validationRunId,
    validationMatchesCurrentRun,
    previewStatus: params.preview.status,
    previewUrl,
    previewPort: validationPassed && previewReady ? params.preview.port : null,
    persistedPreviewUrl: params.persistedPreviewUrl ?? null,
    errorMessage: params.generation?.error?.message ?? null,
  };
}
