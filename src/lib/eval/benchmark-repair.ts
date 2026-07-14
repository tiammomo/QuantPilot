import {
  incrementQuantGenerationRepairAttempt,
  readQuantGenerationState,
  updateQuantGenerationStep,
} from '@/lib/quant/generation-state';
import {
  buildQuantValidationRepairInstruction,
  repairQuantPlatformOwnedArtifacts,
  type QuantValidationReport,
} from '@/lib/quant/validation';

export interface BenchmarkRepairInvocation {
  attempt: number;
  maxRepairAttempts: number;
  parentRequestId: string;
  repairRequestId: string;
  instruction: string;
}

export interface BenchmarkRepairLoopResult {
  validation: QuantValidationReport;
  repairAttempts: number;
  platformRepairCount: number;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error || 'Unknown benchmark repair error');
}

export async function runBenchmarkRepairLoop(params: {
  projectPath: string;
  projectId: string;
  parentRequestId: string;
  originalInstruction: string;
  initialValidation: QuantValidationReport;
  maxRepairAttempts?: number;
  applyRepair: (invocation: BenchmarkRepairInvocation) => Promise<void>;
  validate: (requestId: string) => Promise<QuantValidationReport>;
  preparePlatformArtifacts?: () => Promise<{ runPlanRebuilt: boolean }>;
}): Promise<BenchmarkRepairLoopResult> {
  const generationState = await readQuantGenerationState(params.projectPath);
  const maxRepairAttempts = Math.max(
    1,
    params.maxRepairAttempts ?? generationState?.maxRepairAttempts ?? 3,
  );
  let validation = params.initialValidation;
  let repairAttempts = 0;
  let platformRepairCount = 0;

  while (!validation.passed && repairAttempts < maxRepairAttempts) {
    const platformRepair = await (
      params.preparePlatformArtifacts ??
      (() => repairQuantPlatformOwnedArtifacts({
        projectPath: params.projectPath,
        requestId: params.parentRequestId,
        originalInstruction: params.originalInstruction,
        report: validation,
      }))
    )();

    if (platformRepair.runPlanRebuilt) {
      platformRepairCount += 1;
      validation = await params.validate(params.parentRequestId);
      if (validation.passed) break;
    }

    repairAttempts += 1;
    const repairRequestId = `${params.parentRequestId}-validation-repair-${repairAttempts}`;
    const failedChecks = validation.checks.filter((check) => check.status === 'failed');
    const repairInstruction = buildQuantValidationRepairInstruction(validation, {
      originalInstruction: params.originalInstruction,
    });

    await updateQuantGenerationStep({
      projectPath: params.projectPath,
      projectId: params.projectId,
      requestId: params.parentRequestId,
      stepId: 'validation',
      status: 'failed',
      summary: `真实 E2E 验证未通过：${failedChecks.length} 项失败，进入自动修复。`,
      runStatus: 'repairing',
      metadata: {
        failedChecks: failedChecks.map((check) => ({ id: check.id, summary: check.summary })),
        repairAttempt: repairAttempts,
        maxRepairAttempts,
      },
    });
    const recordedAttempt = await incrementQuantGenerationRepairAttempt({
      projectPath: params.projectPath,
      projectId: params.projectId,
      requestId: params.parentRequestId,
    });
    await updateQuantGenerationStep({
      projectPath: params.projectPath,
      projectId: params.projectId,
      requestId: params.parentRequestId,
      stepId: 'repair',
      status: 'running',
      summary: `真实 E2E 正在执行第 ${recordedAttempt}/${maxRepairAttempts} 次自动修复。`,
      runStatus: 'repairing',
      metadata: {
        parentRequestId: params.parentRequestId,
        repairRequestId,
        failedChecks: failedChecks.map((check) => check.id),
      },
    });

    try {
      await params.applyRepair({
        attempt: recordedAttempt,
        maxRepairAttempts,
        parentRequestId: params.parentRequestId,
        repairRequestId,
        instruction: repairInstruction,
      });
    } catch (error) {
      await updateQuantGenerationStep({
        projectPath: params.projectPath,
        projectId: params.projectId,
        requestId: params.parentRequestId,
        stepId: 'repair',
        status: 'failed',
        summary: `第 ${recordedAttempt}/${maxRepairAttempts} 次自动修复执行失败。`,
        runStatus: 'failed',
        errorMessage: errorMessage(error),
        metadata: { parentRequestId: params.parentRequestId, repairRequestId },
      });
      throw error;
    }

    await updateQuantGenerationStep({
      projectPath: params.projectPath,
      projectId: params.projectId,
      requestId: params.parentRequestId,
      stepId: 'repair',
      status: 'success',
      summary: `第 ${recordedAttempt}/${maxRepairAttempts} 次自动修复执行完成。`,
      metadata: { parentRequestId: params.parentRequestId, repairRequestId },
    });
    await updateQuantGenerationStep({
      projectPath: params.projectPath,
      projectId: params.projectId,
      requestId: params.parentRequestId,
      stepId: 'final_validation',
      status: 'running',
      summary: `开始第 ${recordedAttempt}/${maxRepairAttempts} 次修复后验证。`,
      metadata: { parentRequestId: params.parentRequestId, repairRequestId },
    });

    try {
      // Validation reports and all platform-owned artifacts stay correlated to
      // the parent request; the repairRequestId only identifies the Agent call.
      validation = await params.validate(params.parentRequestId);
    } catch (error) {
      await updateQuantGenerationStep({
        projectPath: params.projectPath,
        projectId: params.projectId,
        requestId: params.parentRequestId,
        stepId: 'final_validation',
        status: 'failed',
        summary: `第 ${recordedAttempt}/${maxRepairAttempts} 次修复后验证执行异常。`,
        runStatus: 'failed',
        errorMessage: errorMessage(error),
        metadata: { parentRequestId: params.parentRequestId, repairRequestId },
      });
      throw error;
    }

    await updateQuantGenerationStep({
      projectPath: params.projectPath,
      projectId: params.projectId,
      requestId: params.parentRequestId,
      stepId: 'final_validation',
      status: validation.passed ? 'success' : 'warning',
      summary: validation.passed
        ? `第 ${recordedAttempt}/${maxRepairAttempts} 次修复后验证通过。`
        : `第 ${recordedAttempt}/${maxRepairAttempts} 次修复后仍未通过。`,
      runStatus: validation.passed ? undefined : 'repairing',
      metadata: { parentRequestId: params.parentRequestId, repairRequestId },
    });
  }

  return { validation, repairAttempts, platformRepairCount };
}

export async function failBenchmarkGenerationRun(params: {
  projectPath: string;
  projectId: string;
  parentRequestId: string;
  error: unknown;
}) {
  const state = await readQuantGenerationState(params.projectPath);
  if (
    !state ||
    state.requestId !== params.parentRequestId ||
    ['completed', 'failed', 'cancelled'].includes(state.status)
  ) {
    return state;
  }

  return updateQuantGenerationStep({
    projectPath: params.projectPath,
    projectId: params.projectId,
    requestId: params.parentRequestId,
    stepId: state.activeStep,
    status: 'failed',
    summary: `benchmark 在 ${state.activeStep} 阶段异常终止。`,
    runStatus: 'failed',
    errorMessage: errorMessage(params.error),
    metadata: { parentRequestId: params.parentRequestId, terminalizedBy: 'benchmark_exception_guard' },
  });
}
