import type { MoAgentAcceptedMissionSnapshot } from '@/lib/agent/mission';
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
  | 'needs_clarification'
  | 'refused';

export type QuantGenerationTerminalGenerationInput = {
  projectId?: string;
  requestId: string;
  status: QuantGenerationRunStatus;
  cliPreference?: string | null;
  steps?: Array<{
    metadata?: Record<string, unknown>;
  }>;
  error?: { message?: string | null } | null;
} | null;

type GenerationStateInput = QuantGenerationTerminalGenerationInput;

type ValidationReportInput = Pick<
  QuantValidationReport,
  'runId' | 'status' | 'passed' | 'checks'
> | null;

type PreviewInput = Pick<PreviewInfo, 'status' | 'url' | 'port'>;

type AcceptedMissionInput = Pick<
  MoAgentAcceptedMissionSnapshot,
  | 'generationId'
  | 'projectId'
  | 'requestId'
  | 'missionStatus'
  | 'acceptedReceiptId'
  | 'acceptedReceiptHash'
  | 'acceptedAt'
> | null;

export interface QuantGenerationTerminalSnapshot {
  requestId: string | null;
  status: QuantGenerationTerminalStatus;
  terminal: boolean;
  validationStatus: 'passed' | 'failed' | 'pending';
  validationRunId: string | null;
  validationMatchesCurrentRun: boolean;
  missionAcceptanceRequired: boolean;
  missionAcceptanceSatisfied: boolean;
  acceptedReceiptId: string | null;
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

function generationIdFromState(
  generation: GenerationStateInput,
): string | null {
  if (!generation?.steps) return null;
  for (let index = generation.steps.length - 1; index >= 0; index -= 1) {
    const generationId = generation.steps[index].metadata?.generationId;
    if (typeof generationId === 'string' && generationId.trim()) {
      return generationId;
    }
  }
  return null;
}

export function requiresMoAgentMissionAcceptance(
  generation: QuantGenerationTerminalGenerationInput,
): boolean {
  if (!generation) return false;
  const cliPreference = generation.cliPreference?.trim().toLowerCase();
  if (cliPreference && cliPreference !== 'moagent') return false;
  // New MoAgent generations always persist Mission identity before Agent
  // execution and repeat it on candidate/acceptance steps. Historical
  // pre-Mission generations have cliPreference=moagent but no such identity;
  // they remain readable without fabricating an unverifiable receipt.
  return Boolean(
    generation.steps?.some((step) =>
      ['missionId', 'generationId', 'acceptedReceiptId'].some((key) => {
        const value = step.metadata?.[key];
        return typeof value === 'string' && value.trim().length > 0;
      }),
    ),
  );
}

function hasCurrentAcceptedMission(
  generation: GenerationStateInput,
  acceptedMission: AcceptedMissionInput,
): boolean {
  if (!generation || !acceptedMission) return false;
  const expectedGenerationId = generationIdFromState(generation);
  return (
    acceptedMission.requestId === generation.requestId &&
    (!generation.projectId ||
      acceptedMission.projectId === generation.projectId) &&
    (!expectedGenerationId ||
      acceptedMission.generationId === expectedGenerationId) &&
    acceptedMission.missionStatus === 'completed' &&
    Boolean(
      acceptedMission.acceptedReceiptId &&
      acceptedMission.acceptedReceiptHash &&
      acceptedMission.acceptedAt,
    )
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
  acceptedMission?: AcceptedMissionInput;
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
  const missionAcceptanceRequired = requiresMoAgentMissionAcceptance(
    params.generation,
  );
  const missionAccepted = hasCurrentAcceptedMission(
    params.generation,
    params.acceptedMission ?? null,
  );
  const missionAcceptanceSatisfied =
    !missionAcceptanceRequired || missionAccepted;
  const acceptedReceiptId = missionAccepted
    ? (params.acceptedMission?.acceptedReceiptId ?? null)
    : null;
  const previewUrl =
    validationPassed && previewReady && missionAcceptanceSatisfied
      ? params.preview.url
      : null;

  let status: QuantGenerationTerminalStatus = 'idle';
  if (params.generation?.status === 'cancelled') {
    status = 'cancelled';
  } else if (params.generation?.status === 'refused') {
    status = 'refused';
  } else if (params.generation?.status === 'needs_clarification') {
    status = 'needs_clarification';
  } else if (
    params.generation?.status === 'failed' &&
    missionAcceptanceRequired &&
    !missionAccepted
  ) {
    // A Mission-backed generation cannot be revived from a merely passed
    // report after its durable Mission failed without an acceptance receipt.
    status = 'failed';
  } else if (validationPassed && previewReady && missionAcceptanceSatisfied) {
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
    terminal: ['ready', 'failed', 'cancelled', 'needs_clarification', 'refused'].includes(status),
    validationStatus: validationPassed
      ? 'passed'
      : validationFailed
        ? 'failed'
        : 'pending',
    validationRunId,
    validationMatchesCurrentRun,
    missionAcceptanceRequired,
    missionAcceptanceSatisfied,
    acceptedReceiptId,
    previewStatus: params.preview.status,
    previewUrl,
    previewPort:
      validationPassed && previewReady && missionAcceptanceSatisfied
        ? params.preview.port
        : null,
    persistedPreviewUrl: params.persistedPreviewUrl ?? null,
    errorMessage: params.generation?.error?.message ?? null,
  };
}
