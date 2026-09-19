import type { PiAgentAcceptedMissionSnapshot } from '@/lib/agent/mission';
import type { QuantGenerationRunStatus, QuantGenerationStepId } from '@/lib/quant/generation-state';
import type { QuantValidationReport } from "@/lib/quant/validation/contracts";
import type { PreviewInfo } from '@/lib/services/preview';

export type QuantGenerationTerminalStatus =
  | 'idle'
  | 'running'
  | 'preview_pending'
  | 'needs_revalidation'
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
  activeStep?: QuantGenerationStepId;
  steps?: Array<{
    id?: QuantGenerationStepId;
    summary?: string;
    metadata?: Record<string, unknown>;
  }>;
  error?: { message?: string | null } | null;
} | null;

type GenerationStateInput = QuantGenerationTerminalGenerationInput;

/** Durable dispatch remains authoritative before a workspace projection exists. */
export function reconcileGenerationDispatchState(
  generation: (NonNullable<GenerationStateInput> & { createdAt?: string }) | null,
  job: {
    projectId: string; requestId: string; status: string; stage: string;
    queuedAt: Date; cliPreference: string | null; errorMessage: string | null;
  } | null,
): GenerationStateInput {
  if (!job) return generation;
  const sameRequest = generation?.requestId === job.requestId;
  // Inline preparation can precede its own job; an older job cannot replace it.
  if (!sameRequest && generation?.createdAt && Date.parse(generation.createdAt) > job.queuedAt.getTime()) return generation;
  const base = {
    projectId: job.projectId, requestId: job.requestId, cliPreference: job.cliPreference,
    ...(sameRequest ? generation : null),
  };
  if (['failed', 'interrupted', 'cancelled'].includes(job.status)) return {
    ...base, status: job.status === 'cancelled' ? 'cancelled' : 'failed',
    error: { message: job.errorMessage ?? '研究任务已中断，请重新发起。' },
  };
  if (job.status === 'completed') return sameRequest ? generation : {
    ...base, status: 'failed', error: { message: '研究已结束，但结果状态缺失，请检查任务记录。' },
  };
  if (sameRequest && generation?.status === 'running' && job.status === 'running') return generation;
  const activeStep = job.stage === 'planning_data_prefetch' ? 'planning' : 'agent_execution';
  return {
    ...base, status: 'running', activeStep,
    steps: [{ id: activeStep, summary: job.status === 'running'
      ? '正在准备研究上下文与执行输入。' : '研究请求已保存，等待 Worker 执行。' }],
  };
}

type ValidationReportInput = Pick<
  QuantValidationReport,
  'runId' | 'status' | 'passed' | 'checks'
> | null;

type PreviewInput = Pick<PreviewInfo, 'status' | 'url' | 'port'>;

type AcceptedMissionInput = Pick<
  PiAgentAcceptedMissionSnapshot,
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
  activeStep?: QuantGenerationStepId | null;
  stepSummary?: string | null;
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

export function requiresPiAgentMissionAcceptance(
  generation: QuantGenerationTerminalGenerationInput,
): boolean {
  if (!generation) return false;
  // Refusals and other non-delivery terminal states never produce a candidate.
  // Every state that can expose or recover a preview must prove that the
  // current PI Agent Mission accepted it. Unknown or incomplete persisted
  // identity therefore fails closed instead of bypassing the receipt gate.
  return !['cancelled', 'needs_clarification', 'refused'].includes(
    generation.status,
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
  const missionAcceptanceRequired = requiresPiAgentMissionAcceptance(
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
    params.generation?.status === 'completed' &&
    validationStale
  ) {
    // A completed run with subsequently edited artifacts is not still
    // generating. Surface an explicit maintenance state so the client does
    // not leave the user on an endless generation animation.
    status = 'needs_revalidation';
  } else if (
    params.generation &&
    params.validation &&
    (validationStale || !validationMatchesCurrentRun)
  ) {
    status = 'running';
  } else if (
    params.generation &&
    ['pending', 'running', 'repairing'].includes(params.generation.status)
  ) {
    // A failed validation report is an intermediate result while the bounded
    // auto-repair loop is still active. Do not publish a terminal failure and
    // race the repair that can still produce an accepted candidate.
    status = 'running';
  } else if (params.generation?.status === 'failed' || validationFailed) {
    status = 'failed';
  }

  return {
    requestId,
    status,
    activeStep: status === 'running' ? params.generation?.activeStep ?? null : null,
    stepSummary: status === 'running'
      ? params.generation?.steps?.find(step => step.id === params.generation?.activeStep)?.summary?.trim() || null
      : null,
    terminal: ['ready', 'needs_revalidation', 'failed', 'cancelled', 'needs_clarification', 'refused'].includes(status),
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
