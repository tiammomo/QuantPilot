import type { MoAgentCandidateSubmission } from '@/lib/agent/mission';
import { refreshMoAgentCandidateWorkspace } from '@/lib/services/moagent-candidate';
import {
  capturePlatformMissionCandidate,
  claimQuantMoAgentMissionVerification,
  markQuantMoAgentMissionNode,
  refreshMoAgentMissionContext,
  sealQuantMoAgentMissionCandidate,
  verifyAndRecordQuantMoAgentMission,
  type MoAgentMissionContext,
} from '@/lib/services/moagent-mission-control';
import {
  cancelMoAgentMission,
  failMoAgentMission,
  markMoAgentMissionRepairing,
  MoAgentMissionStateError,
  readMoAgentAcceptedMissionSnapshot,
} from '@/lib/services/moagent-mission-store';
import {
  startPersistentValidatedPreview,
  type ValidatedGenerationPreview,
} from '@/lib/quant/generation-preview';
import {
  persistAcceptedGovernedKnowledgeUse,
  recordGovernedKnowledgeUsage,
  writeGovernedKnowledgeEvidence,
  type GovernedKnowledgeCapsule,
  type GovernedKnowledgePreparation,
} from '@/lib/platform/knowledge';
import { recordContextAcceptance } from '@/lib/platform/context/use-manifest';
import {
  incrementQuantGenerationRepairAttempt,
  readQuantGenerationState,
  updateQuantGenerationStep,
} from '@/lib/quant/generation-state';
import { finishQuantGenerationQueueItem } from '@/lib/quant/generation-queue';
import type { WorkspaceProgressPublisher } from '@/lib/quant/workspace-progress';
import { shouldEscalateStalledRepair } from '@/lib/quant/repair-convergence';
import {
  isUserRequestCancelled,
  markUserRequestAsCompleted,
  markUserRequestAsFailed,
  markUserRequestAsProcessing,
  upsertUserRequest,
} from '@/lib/services/user-requests';
import { classifyMoAgentExecutionError } from '@/lib/services/moagent-execution-error';
import { collectMoAgentTurnMetrics } from '@/lib/services/moagent-turn-metrics';
import { createMessage } from '@/lib/services/message';
import { streamManager } from '@/lib/services/stream';
import { serializeMessage } from '@/lib/serializers/chat';

async function loadQuantValidation() {
  return import('@/lib/quant/validation');
}

async function ensureQuantDashboardTemplateForAct(projectPath: string) {
  const { ensureQuantDashboardTemplate } = await import('@/lib/utils/scaffold');
  return ensureQuantDashboardTemplate(projectPath);
}

class ValidatedPreviewStartError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ValidatedPreviewStartError";
  }
}

export function runValidationAfterExecution(params: {
  execution: Promise<MoAgentCandidateSubmission>;
  repairExecutor: (
    projectId: string,
    projectPath: string,
    instruction: string,
    model: string,
    requestId?: string,
    parentRequestId?: string,
  ) => Promise<MoAgentCandidateSubmission>;
  mission: MoAgentMissionContext;
  projectId: string;
  projectPath: string;
  instruction: string;
  selectedModel: string;
  requestId: string;
  actorUserId: string | null;
  conversationId?: string | null;
  cliSource?: string | null;
  agentExecutionSuccessSummary?: string;
  governedKnowledge?: GovernedKnowledgeCapsule | null;
  governedKnowledgePreparation?: GovernedKnowledgePreparation | null;
  governedKnowledgeTaskCategory?: string;
  publishWorkspaceProgress: WorkspaceProgressPublisher;
  relatedAgentRequestIds: Set<string>;
}): Promise<void> {
  let activeRepairRequestId: string | null = null;
  let activeMission = params.mission;
  let activeVerificationSession: NonNullable<
    MoAgentMissionContext["verificationSession"]
  > | null = null;

  const disposeVerificationSession = async (): Promise<void> => {
    const session = activeVerificationSession;
    activeVerificationSession = null;
    if (!session) return;
    const releasedMission = await session.dispose();
    if (releasedMission) {
      activeMission = {
        ...releasedMission,
        projectPath: activeMission.projectPath,
      };
    }
  };

  const cancelMission = async (message: string) => {
    await disposeVerificationSession();
    activeMission = {
      ...(await cancelMoAgentMission({
        missionId: activeMission.id,
        projectId: activeMission.projectId,
        requestId: activeMission.requestId,
        message,
        expectedVersion: activeMission.version,
        expectedStatus: activeMission.status,
      })),
      projectPath: activeMission.projectPath,
    };
  };
  const failMission = async (code: string, message: string) => {
    await disposeVerificationSession();
    activeMission = {
      ...(await failMoAgentMission({
        missionId: activeMission.id,
        projectId: activeMission.projectId,
        requestId: activeMission.requestId,
        code,
        message,
        expectedVersion: activeMission.version,
        expectedStatus: activeMission.status,
      })),
      projectPath: activeMission.projectPath,
    };
  };
  const beginRepair = async () => {
    activeMission = {
      ...(await markMoAgentMissionRepairing({
        missionId: activeMission.id,
        projectId: activeMission.projectId,
        requestId: activeMission.requestId,
      })),
      projectPath: activeMission.projectPath,
    };
  };
  const recoverCommittedAcceptanceProjection = async (): Promise<boolean> => {
    activeMission = await refreshMoAgentMissionContext(activeMission);
    if (activeMission.status !== "completed") return false;
    const accepted = await readMoAgentAcceptedMissionSnapshot(
      activeMission.projectId,
      activeMission.requestId,
    );
    if (
      !accepted?.acceptedReceiptId ||
      !accepted.acceptedReceiptHash ||
      !accepted.previewUrl ||
      !accepted.previewPort
    ) {
      throw new Error(
        "Completed Mission is missing its accepted receipt or preview projection.",
      );
    }
    const metadata = {
      missionId: accepted.missionId,
      generationId: accepted.generationId,
      candidateVersion: accepted.candidateVersion,
      acceptedReceiptId: accepted.acceptedReceiptId,
      acceptedReceiptSha256: accepted.acceptedReceiptHash,
      previewUrl: accepted.previewUrl,
      previewPort: accepted.previewPort,
      recoveredProjection: true,
    };
    const projectionResults = await Promise.allSettled([
      updateQuantGenerationStep({
        projectPath: params.projectPath,
        projectId: params.projectId,
        requestId: params.requestId,
        stepId: "completed",
        status: "success",
        summary: "已从 accepted Mission receipt 恢复完成投影。",
        runStatus: "completed",
        metadata,
      }),
      finishQuantGenerationQueueItem({
        projectPath: params.projectPath,
        projectId: params.projectId,
        requestId: params.requestId,
        status: "completed",
      }),
      markUserRequestAsCompleted(params.projectId, params.requestId),
    ]);
    for (const result of projectionResults) {
      if (result.status === "rejected") {
        console.error(
          "[API] Failed to recover one accepted Mission projection:",
          result.reason,
        );
      }
    }
    await params.publishWorkspaceProgress({
      stage: 5,
      previewUrl: accepted.previewUrl,
    });
    streamManager.publish(params.projectId, {
      type: "status",
      data: {
        status: "preview_ready",
        message: "Mission 已验收，看板预览已就绪。",
        requestId: params.requestId,
        metadata,
      },
    });
    return true;
  };
  const sealCandidate = async (candidate: MoAgentCandidateSubmission) => {
    const sealed = await sealQuantMoAgentMissionCandidate({
      mission: activeMission,
      candidate,
    });
    activeMission = sealed.mission;
    activeMission = await claimQuantMoAgentMissionVerification(activeMission);
    if (!activeMission.verificationSession) {
      throw new Error(
        "Mission verification claim did not return a live lease session.",
      );
    }
    activeVerificationSession = activeMission.verificationSession;
    await updateQuantGenerationStep({
      projectPath: params.projectPath,
      projectId: params.projectId,
      requestId: params.requestId,
      stepId: "agent_execution",
      status: "success",
      summary: "候选产物已封存，等待独立证据验收。",
      metadata: {
        missionId: activeMission.id,
        generationId: activeMission.generationId,
        candidateVersion: activeMission.candidateVersion,
        candidateReceiptId: sealed.receipt.id,
        candidateWorkspaceSha256: candidate.workspaceSha256,
      },
    });
    return sealed.receipt;
  };
  const captureAndSeal = async (
    source: Parameters<typeof capturePlatformMissionCandidate>[0]["source"],
    summary: string,
    sourceRequestId = params.requestId,
  ) => {
    const candidate = await capturePlatformMissionCandidate({
      mission: activeMission,
      source,
      sourceRequestId,
      summary,
    });
    await sealCandidate(candidate);
    return candidate;
  };
  const recordEvidence = async (preview?: ValidatedGenerationPreview) => {
    streamManager.publish(params.projectId, {
      type: "status",
      data: {
        status: "evidence_verification_running",
        message: preview
          ? "正在核验当前候选、验证报告、产物哈希与持久预览证据。"
          : "正在核验当前候选与失败验证证据，确定下一步修复归属。",
        requestId: params.requestId,
        metadata: {
          missionId: activeMission.id,
          generationId: activeMission.generationId,
          candidateVersion: activeMission.candidateVersion,
        },
      },
    });
    let verified: Awaited<
      ReturnType<typeof verifyAndRecordQuantMoAgentMission>
    >;
    const verificationSession = activeVerificationSession;
    try {
      verified = await verifyAndRecordQuantMoAgentMission({
        mission: activeMission,
        preview: preview
          ? { url: preview.url, port: preview.port }
          : { url: "http://127.0.0.1:1", port: 1 },
      });
    } finally {
      const releasedMission = verificationSession?.release;
      if (releasedMission) {
        activeMission = {
          ...releasedMission,
          projectPath: activeMission.projectPath,
        };
      }
      activeVerificationSession = null;
    }
    activeMission = verified.mission;
    await updateQuantGenerationStep({
      projectPath: params.projectPath,
      projectId: params.projectId,
      requestId: params.requestId,
      stepId: "evidence_verification",
      status: verified.decision.verdict === "accepted" ? "success" : "failed",
      summary:
        verified.decision.verdict === "accepted"
          ? "当前候选的验证、产物哈希与持久预览证据已验收。"
          : `证据验收未通过：${verified.decision.verdict}。`,
      metadata: {
        missionId: activeMission.id,
        generationId: activeMission.generationId,
        candidateVersion: verified.decision.candidateVersion,
        evidenceReceiptId: verified.receipt.id,
        evidenceReceiptSha256: verified.receipt.receiptHash,
        verdict: verified.decision.verdict,
        reasonCodes: verified.decision.reasonCodes,
        failedCheckIds: verified.decision.failedCheckIds,
      },
      ...(verified.decision.verdict === "accepted"
        ? {}
        : { errorMessage: `证据验收未通过：${verified.decision.verdict}。` }),
    });
    return verified;
  };

  const validateAndRepair = async (
    candidate: MoAgentCandidateSubmission | null,
    executionError?: unknown,
  ) => {
    if (await isUserRequestCancelled(params.projectId, params.requestId)) {
      await cancelMission("请求已取消，Mission 不再接受候选或验收证据。");
      await updateQuantGenerationStep({
        projectPath: params.projectPath,
        projectId: params.projectId,
        requestId: params.requestId,
        stepId: "agent_execution",
        status: "failed",
        summary: "请求已取消，停止执行后续验证。",
        runStatus: "cancelled",
        errorMessage: "请求已取消。",
      });
      await finishQuantGenerationQueueItem({
        projectPath: params.projectPath,
        projectId: params.projectId,
        requestId: params.requestId,
        status: "cancelled",
        errorMessage: "请求已取消。",
      });
      await params.publishWorkspaceProgress({
        stage: 5,
        cancelledReason: "用户暂停了当前任务。",
      });
      return;
    }

    const classifiedExecutionError = executionError
      ? classifyMoAgentExecutionError(executionError)
      : null;
    const executionFailureMessage =
      classifiedExecutionError?.message ??
      (executionError instanceof Error
        ? executionError.message
        : String(executionError || "Agent execution failed"));

    await updateQuantGenerationStep({
      projectPath: params.projectPath,
      projectId: params.projectId,
      requestId: params.requestId,
      stepId: "agent_execution",
      status: executionError ? "failed" : "success",
      summary: executionError
        ? classifiedExecutionError &&
          !classifiedExecutionError.repairableByValidation
          ? `Agent 执行失败：${executionFailureMessage}`
          : "Agent 执行异常结束，进入验证确认产物状态。"
        : (params.agentExecutionSuccessSummary ??
          "Agent 执行完成，进入自动验证。"),
      ...(executionError
        ? {
            errorMessage: executionFailureMessage,
            ...(classifiedExecutionError
              ? { metadata: { errorCode: classifiedExecutionError.code } }
              : {}),
          }
        : {}),
    });

    if (
      classifiedExecutionError &&
      !classifiedExecutionError.repairableByValidation
    ) {
      await failMission(classifiedExecutionError.code, executionFailureMessage);
      await updateQuantGenerationStep({
        projectPath: params.projectPath,
        projectId: params.projectId,
        requestId: params.requestId,
        stepId: "agent_execution",
        status: "failed",
        summary: `Agent 执行失败：${executionFailureMessage}`,
        runStatus: "failed",
        errorMessage: executionFailureMessage,
        metadata: { errorCode: classifiedExecutionError.code },
      });
      await markUserRequestAsFailed(
        params.projectId,
        params.requestId,
        executionFailureMessage,
      );
      await finishQuantGenerationQueueItem({
        projectPath: params.projectPath,
        projectId: params.projectId,
        requestId: params.requestId,
        status: "failed",
        errorMessage: executionFailureMessage,
      });
      await params.publishWorkspaceProgress({
        stage: 5,
        failureReason: executionFailureMessage,
      });
      streamManager.publish(params.projectId, {
        type: "status",
        data: {
          status: "agent_execution_failed",
          message: executionFailureMessage,
          requestId: params.requestId,
          metadata: {
            terminalFailure: true,
            errorCode: classifiedExecutionError.code,
            validationRepairSkipped: true,
          },
        },
      });
      return;
    }

    await params.publishWorkspaceProgress({ stage: 4 });
    const quantValidation = await loadQuantValidation();
    await quantValidation.prepareQuantProjectForValidation({
      projectId: params.projectId,
      projectPath: params.projectPath,
    });
    if (candidate) {
      await sealCandidate(
        await refreshMoAgentCandidateWorkspace({
          workspaceRoot: params.projectPath,
          candidate,
        }),
      );
    } else {
      await captureAndSeal(
        "workspace_recovery",
        "Agent 异常结束后，平台基于当前工作区封存恢复候选。",
      );
    }

    await updateQuantGenerationStep({
      projectPath: params.projectPath,
      projectId: params.projectId,
      requestId: params.requestId,
      stepId: "validation",
      status: "running",
      summary: "开始自动验证生成产物。",
    });
    const firstReport = await quantValidation.validateQuantProject({
      projectId: params.projectId,
      projectPath: params.projectPath,
      requestId: params.requestId,
      conversationId: params.conversationId,
      cliSource: params.cliSource,
    });

    const startValidatedPreview = async () => {
      await updateQuantGenerationStep({
        projectPath: params.projectPath,
        projectId: params.projectId,
        requestId: params.requestId,
        stepId: "preview",
        status: "running",
        summary: "自动验证通过，正在启动持久看板预览。",
      });
      streamManager.publish(params.projectId, {
        type: "status",
        data: {
          status: "preview_starting",
          message: "自动验证通过，正在启动并确认持久看板预览。",
          requestId: params.requestId,
          metadata: {
            validationPassed: true,
          },
        },
      });

      try {
        const preview = await startPersistentValidatedPreview({
          projectId: params.projectId,
        });
        await updateQuantGenerationStep({
          projectPath: params.projectPath,
          projectId: params.projectId,
          requestId: params.requestId,
          stepId: "preview",
          status: "success",
          summary: "持久看板预览已通过 HTTP 就绪检查。",
          metadata: {
            previewUrl: preview.url,
            previewPort: preview.port,
          },
        });
        return preview;
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new ValidatedPreviewStartError(
          `自动验证已通过，但持久看板预览启动失败：${detail}`,
          error instanceof Error ? { cause: error } : undefined,
        );
      }
    };

    const publishPreviewReady = (preview: ValidatedGenerationPreview) => {
      streamManager.publish(params.projectId, {
        type: "status",
        data: {
          status: "preview_ready",
          message: "自动验证通过，看板预览已就绪。",
          requestId: params.requestId,
          metadata: {
            previewUrl: preview.url,
            previewPort: preview.port,
            validationPassed: true,
          },
        },
      });
    };

    const completeValidatedGeneration = async (
      report: typeof firstReport,
      summary: string,
      preview: ValidatedGenerationPreview,
      acceptance: Awaited<ReturnType<typeof recordEvidence>>,
    ) => {
      if (
        acceptance.decision.verdict !== "accepted" ||
        acceptance.mission.status !== "completed"
      ) {
        throw new Error(
          "Mission completion requires a committed accepted evidence receipt.",
        );
      }
      if (await isUserRequestCancelled(params.projectId, params.requestId)) {
        await cancelMission("证据验收完成前请求已取消，拒绝投影完成态。");
        await updateQuantGenerationStep({
          projectPath: params.projectPath,
          projectId: params.projectId,
          requestId: params.requestId,
          stepId: "completed",
          status: "failed",
          summary: "自动验证通过，但请求已取消，未启动持久看板预览。",
          runStatus: "cancelled",
          errorMessage: "请求已取消。",
        });
        await finishQuantGenerationQueueItem({
          projectPath: params.projectPath,
          projectId: params.projectId,
          requestId: params.requestId,
          status: "cancelled",
          errorMessage: "请求已取消。",
        });
        await params.publishWorkspaceProgress({
          stage: 5,
          cancelledReason: "用户在验收完成投影前暂停了当前任务。",
        });
        return;
      }

      await updateQuantGenerationStep({
        projectPath: params.projectPath,
        projectId: params.projectId,
        requestId: params.requestId,
        stepId: "validation",
        status: "success",
        summary,
        metadata: {
          checkCount: report.checks.length,
          previewUrl: preview.url,
          previewPort: preview.port,
          missionId: acceptance.mission.id,
          generationId: acceptance.mission.generationId,
          candidateVersion: acceptance.mission.candidateVersion,
          acceptedReceiptId: acceptance.receipt.id,
          acceptedReceiptSha256: acceptance.receipt.receiptHash,
        },
      });
      await updateQuantGenerationStep({
        projectPath: params.projectPath,
        projectId: params.projectId,
        requestId: params.requestId,
        stepId: "completed",
        status: "success",
        summary: "生成链路完成。",
        runStatus: "completed",
        metadata: {
          previewUrl: preview.url,
          previewPort: preview.port,
          missionId: acceptance.mission.id,
          generationId: acceptance.mission.generationId,
          candidateVersion: acceptance.mission.candidateVersion,
          acceptedReceiptId: acceptance.receipt.id,
          acceptedReceiptSha256: acceptance.receipt.receiptHash,
        },
      });
      await finishQuantGenerationQueueItem({
        projectPath: params.projectPath,
        projectId: params.projectId,
        requestId: params.requestId,
        status: "completed",
      });
      await markUserRequestAsCompleted(params.projectId, params.requestId);
      let knowledgeUsage: Awaited<
        ReturnType<typeof recordGovernedKnowledgeUsage>
      > | null = null;
      if (params.governedKnowledge && params.governedKnowledgePreparation) {
        knowledgeUsage = await recordGovernedKnowledgeUsage({
          capsule: params.governedKnowledge,
          requestId: params.requestId,
          taskCategory:
            params.governedKnowledgeTaskCategory ?? "quant-research",
          occurredAt: acceptance.receipt.createdAt,
        });
        await persistAcceptedGovernedKnowledgeUse({
          projectId: params.projectId,
          requestId: params.requestId,
          taskCategory:
            params.governedKnowledgeTaskCategory ?? "quant-research",
          capsule: params.governedKnowledge,
          usage: knowledgeUsage,
          acceptedReceiptId: acceptance.receipt.id,
          acceptedReceiptSha256: acceptance.receipt.receiptHash,
        }).catch((error) => {
          console.error(
            "[GovernedKnowledge] Failed to persist accepted Usage attribution:",
            error,
          );
        });
        await writeGovernedKnowledgeEvidence({
          projectPath: params.projectPath,
          requestId: params.requestId,
          preparation: params.governedKnowledgePreparation,
          usage: knowledgeUsage,
        }).catch((error) => {
          console.error(
            "[GovernedKnowledge] Failed to persist Usage evidence projection:",
            error,
          );
        });
      }
      await recordContextAcceptance({
        projectPath: params.projectPath,
        projectId: params.projectId,
        requestId: params.requestId,
        knowledgeUsage,
        mission: {
          missionId: acceptance.mission.id,
          acceptedReceiptId: acceptance.receipt.id,
          acceptedReceiptSha256: acceptance.receipt.receiptHash,
        },
      }).catch((error) => {
        console.error(
          "[ContextUse] Failed to persist accepted context projection:",
          error,
        );
      });
      await params.publishWorkspaceProgress({
        stage: 5,
        validationCheckCount: report.checks.length,
        validationWarningCount: report.checks.filter(
          (check) => check.status === "warning",
        ).length,
        previewUrl: preview.url,
      });
      publishPreviewReady(preview);
      if (executionError) {
        streamManager.publish(params.projectId, {
          type: "status",
          data: {
            status: "validation_passed_after_agent_error",
            message: "Agent 执行异常结束，但产物自动验证已通过。",
            requestId: params.requestId,
          },
        });
      }
    };

    if (firstReport.passed) {
      const preview = await startValidatedPreview();
      const acceptance = await recordEvidence(preview);
      if (acceptance.decision.verdict !== "accepted") {
        throw new Error(
          `自动验证报告通过，但 Mission 证据未被接受：${acceptance.decision.reasonCodes.join(", ") || acceptance.decision.verdict}`,
        );
      }
      await completeValidatedGeneration(
        firstReport,
        "自动验证和独立证据验收通过。",
        preview,
        acceptance,
      );
      return;
    }

    const firstEvidence = await recordEvidence();
    if (firstEvidence.decision.verdict !== "repair_required") {
      throw new Error(
        `自动验证失败无法进入 Agent 修复：${firstEvidence.decision.reasonCodes.join(", ") || firstEvidence.decision.verdict}`,
      );
    }

    let validationReport = firstReport;
    let failedChecks = validationReport.checks.filter(
      (check) => check.status === "failed",
    );

    await updateQuantGenerationStep({
      projectPath: params.projectPath,
      projectId: params.projectId,
      requestId: params.requestId,
      stepId: "validation",
      status: "failed",
      summary: `自动验证未通过：${failedChecks.length} 项失败。`,
      metadata: {
        failedChecks: failedChecks.map((check) => ({
          id: check.id,
          summary: check.summary,
        })),
      },
      errorMessage: `自动验证未通过：${failedChecks.length} 项失败。`,
    });

    const baseRepairRequestId = `${params.requestId}-validation-repair`;
    let latestReport = validationReport;
    let latestFailedChecks = failedChecks;
    const generationState = await readQuantGenerationState(params.projectPath);
    const maxRepairAttempts = Math.max(
      1,
      generationState?.maxRepairAttempts ?? 1,
    );

    for (
      let attemptIndex = 0;
      attemptIndex < maxRepairAttempts;
      attemptIndex += 1
    ) {
      const repairAttempt = attemptIndex + 1;
      const repairRequestId =
        repairAttempt === 1
          ? baseRepairRequestId
          : `${baseRepairRequestId}-${repairAttempt}`;
      params.relatedAgentRequestIds.add(repairRequestId);
      const failedCheckIdsBeforeRepair = latestFailedChecks.map(
        (check) => check.id,
      );
      await beginRepair();
      const platformRepair =
        await quantValidation.repairQuantPlatformOwnedArtifacts({
          projectPath: params.projectPath,
          requestId: params.requestId,
          originalInstruction: params.instruction,
          report: latestReport,
        });
      if (platformRepair.runPlanRebuilt) {
        await quantValidation.prepareQuantProjectForValidation({
          projectId: params.projectId,
          projectPath: params.projectPath,
        });
        await captureAndSeal(
          "platform_repair",
          "平台重建只读规划产物后封存新的验证候选。",
        );
        latestReport = await quantValidation.validateQuantProject({
          projectId: params.projectId,
          projectPath: params.projectPath,
          requestId: params.requestId,
          conversationId: params.conversationId,
          cliSource: params.cliSource,
        });
        latestFailedChecks = latestReport.checks.filter(
          (check) => check.status === "failed",
        );
        if (latestReport.passed) {
          const preview = await startValidatedPreview();
          const acceptance = await recordEvidence(preview);
          if (acceptance.decision.verdict !== "accepted") {
            throw new Error(
              `平台结构修复后的证据未被接受：${acceptance.decision.reasonCodes.join(", ") || acceptance.decision.verdict}`,
            );
          }
          await completeValidatedGeneration(
            latestReport,
            "平台重建只读结构产物后，自动验证与证据验收通过。",
            preview,
            acceptance,
          );
          return;
        }
        const platformRepairEvidence = await recordEvidence();
        if (platformRepairEvidence.decision.verdict !== "repair_required") {
          throw new Error(
            `平台结构修复后无法进入 Agent 修复：${platformRepairEvidence.decision.reasonCodes.join(", ") || platformRepairEvidence.decision.verdict}`,
          );
        }
        await beginRepair();
      }
      const repairInstruction =
        quantValidation.buildQuantValidationRepairInstruction(latestReport, {
          originalInstruction: params.instruction,
        });

      streamManager.publish(params.projectId, {
        type: "status",
        data: {
          status: "validation_repairing",
          message:
            executionError && repairAttempt === 1
              ? `Agent 执行异常结束，正在基于自动验证失败项触发第 ${repairAttempt}/${maxRepairAttempts} 次修复。`
              : `自动验证未通过，正在进行第 ${repairAttempt}/${maxRepairAttempts} 次产物修复。`,
          requestId: params.requestId,
          metadata: {
            repairRequestId,
            repairAttempt,
            maxRepairAttempts,
            failedChecks: latestFailedChecks.map((check) => ({
              id: check.id,
              summary: check.summary,
            })),
          },
        },
      });

      try {
        await upsertUserRequest({
          id: repairRequestId,
          projectId: params.projectId,
          actorUserId: params.actorUserId,
          instruction: repairInstruction,
          cliPreference: params.cliSource,
        });
        await markUserRequestAsProcessing(params.projectId, repairRequestId);
        activeRepairRequestId = repairRequestId;
      } catch (error) {
        console.error(
          "[API] Failed to record validation repair request:",
          error,
        );
        throw error;
      }

      if (await isUserRequestCancelled(params.projectId, params.requestId)) {
        await cancelMission("原始请求已取消，自动修复未继续执行。");
        await updateQuantGenerationStep({
          projectPath: params.projectPath,
          projectId: params.projectId,
          requestId: params.requestId,
          stepId: "repair",
          status: "failed",
          summary: "原始请求已取消，自动修复未继续执行。",
          runStatus: "cancelled",
          errorMessage: "原始请求已取消。",
        });
        await finishQuantGenerationQueueItem({
          projectPath: params.projectPath,
          projectId: params.projectId,
          requestId: params.requestId,
          status: "cancelled",
          errorMessage: "原始请求已取消。",
        });
        await markUserRequestAsFailed(
          params.projectId,
          repairRequestId,
          "原始请求已取消，自动修复未继续执行。",
        );
        if (activeRepairRequestId === repairRequestId) {
          activeRepairRequestId = null;
        }
        await params.publishWorkspaceProgress({
          stage: 5,
          cancelledReason: "用户暂停了当前任务，自动修复未继续。",
        });
        return;
      }

      let repairExecutionFailed = false;
      let repairCandidate: MoAgentCandidateSubmission | null = null;
      try {
        const recordedAttempt = await incrementQuantGenerationRepairAttempt({
          projectPath: params.projectPath,
          projectId: params.projectId,
          requestId: params.requestId,
        });
        await updateQuantGenerationStep({
          projectPath: params.projectPath,
          projectId: params.projectId,
          requestId: params.requestId,
          stepId: "repair",
          status: "running",
          summary: `第 ${recordedAttempt}/${maxRepairAttempts} 次自动修复开始。`,
          runStatus: "repairing",
          metadata: {
            repairRequestId,
            repairAttempt: recordedAttempt,
            maxRepairAttempts,
            failedChecks: latestFailedChecks.map((check) => check.id),
          },
        });
        repairCandidate = await params.repairExecutor(
          params.projectId,
          params.projectPath,
          repairInstruction,
          params.selectedModel,
          repairRequestId,
          params.requestId,
        );
      } catch (error) {
        repairExecutionFailed = true;
        console.error("[API] Validation repair execution failed:", error);
        const message =
          error instanceof Error
            ? error.message
            : String(error || "Validation repair execution failed");
        await updateQuantGenerationStep({
          projectPath: params.projectPath,
          projectId: params.projectId,
          requestId: params.requestId,
          stepId: "repair",
          status: "failed",
          summary: `第 ${repairAttempt}/${maxRepairAttempts} 次自动修复执行失败。`,
          errorMessage: message,
        });
        await markUserRequestAsFailed(
          params.projectId,
          repairRequestId,
          message,
        );
        if (activeRepairRequestId === repairRequestId) {
          activeRepairRequestId = null;
        }
        streamManager.publish(params.projectId, {
          type: "status",
          data: {
            status: "validation_repair_failed",
            message: "自动修复执行失败，正在保留最终验证报告用于排查。",
            requestId: repairRequestId,
          },
        });
      }

      if (await isUserRequestCancelled(params.projectId, params.requestId)) {
        await cancelMission("原始请求已取消，修复后证据不再接受。");
        if (!repairExecutionFailed) {
          await updateQuantGenerationStep({
            projectPath: params.projectPath,
            projectId: params.projectId,
            requestId: params.requestId,
            stepId: "repair",
            status: "failed",
            summary: "原始请求已取消，自动修复后的验证未继续执行。",
            runStatus: "cancelled",
            errorMessage: "原始请求已取消。",
          });
          await markUserRequestAsFailed(
            params.projectId,
            repairRequestId,
            "原始请求已取消，自动修复后的验证未继续执行。",
          );
          if (activeRepairRequestId === repairRequestId) {
            activeRepairRequestId = null;
          }
        }
        await finishQuantGenerationQueueItem({
          projectPath: params.projectPath,
          projectId: params.projectId,
          requestId: params.requestId,
          status: "cancelled",
          errorMessage: "原始请求已取消。",
        });
        await params.publishWorkspaceProgress({
          stage: 5,
          cancelledReason: "用户暂停了当前任务，修复后的证据不再接受。",
        });
        return;
      }

      await quantValidation.prepareQuantProjectForValidation({
        projectId: params.projectId,
        projectPath: params.projectPath,
      });
      if (repairCandidate) {
        await sealCandidate(
          await refreshMoAgentCandidateWorkspace({
            workspaceRoot: params.projectPath,
            candidate: repairCandidate,
          }),
        );
      } else {
        await captureAndSeal(
          "workspace_recovery",
          repairExecutionFailed
            ? "Agent 修复异常结束后，平台封存当前工作区恢复候选。"
            : "Agent 修复未返回候选回执，平台封存当前工作区恢复候选。",
          repairRequestId,
        );
      }

      if (!repairExecutionFailed) {
        await updateQuantGenerationStep({
          projectPath: params.projectPath,
          projectId: params.projectId,
          requestId: params.requestId,
          stepId: "repair",
          status: "success",
          summary: `第 ${repairAttempt}/${maxRepairAttempts} 次自动修复执行完成，进入验证。`,
        });
      }

      await updateQuantGenerationStep({
        projectPath: params.projectPath,
        projectId: params.projectId,
        requestId: params.requestId,
        stepId: "final_validation",
        status: "running",
        summary: `开始第 ${repairAttempt}/${maxRepairAttempts} 次修复后自动验证。`,
      });
      const finalReport = await quantValidation.validateQuantProject({
        projectId: params.projectId,
        projectPath: params.projectPath,
        requestId: params.requestId,
        conversationId: params.conversationId,
        cliSource: params.cliSource,
      });

      if (finalReport.passed) {
        if (await isUserRequestCancelled(params.projectId, params.requestId)) {
          await cancelMission("修复后验证通过，但请求已经取消。");
          await markUserRequestAsFailed(
            params.projectId,
            repairRequestId,
            "原始请求已取消，自动修复结果未写回完成态。",
          );
          if (activeRepairRequestId === repairRequestId) {
            activeRepairRequestId = null;
          }
          await updateQuantGenerationStep({
            projectPath: params.projectPath,
            projectId: params.projectId,
            requestId: params.requestId,
            stepId: "completed",
            status: "failed",
            summary: "修复后验证通过，但请求已取消，未启动持久看板预览。",
            runStatus: "cancelled",
            errorMessage: "请求已取消。",
          });
          await finishQuantGenerationQueueItem({
            projectPath: params.projectPath,
            projectId: params.projectId,
            requestId: params.requestId,
            status: "cancelled",
            errorMessage: "原始请求已取消。",
          });
          await params.publishWorkspaceProgress({
            stage: 5,
            cancelledReason: "用户暂停了当前任务，修复结果未投影为完成态。",
          });
          return;
        }

        let preview: ValidatedGenerationPreview;
        try {
          preview = await startValidatedPreview();
        } catch (error) {
          await markUserRequestAsFailed(
            params.projectId,
            repairRequestId,
            error instanceof Error ? error.message : String(error),
          );
          if (activeRepairRequestId === repairRequestId) {
            activeRepairRequestId = null;
          }
          throw error;
        }
        const acceptance = await recordEvidence(preview);
        if (acceptance.decision.verdict !== "accepted") {
          throw new Error(
            `修复后验证报告通过，但 Mission 证据未被接受：${acceptance.decision.reasonCodes.join(", ") || acceptance.decision.verdict}`,
          );
        }
        await completeValidatedGeneration(
          finalReport,
          "修复后自动验证与独立证据验收通过。",
          preview,
          acceptance,
        );
        await markUserRequestAsCompleted(params.projectId, repairRequestId);
        if (activeRepairRequestId === repairRequestId) {
          activeRepairRequestId = null;
        }
        return;
      }

      const finalEvidence = await recordEvidence();
      if (finalEvidence.decision.verdict !== "repair_required") {
        throw new Error(
          `修复后验证失败无法继续：${finalEvidence.decision.reasonCodes.join(", ") || finalEvidence.decision.verdict}`,
        );
      }

      latestReport = finalReport;
      latestFailedChecks = finalReport.checks.filter(
        (check) => check.status === "failed",
      );
      const stalledRepair = shouldEscalateStalledRepair({
        repairAttempt,
        maxRepairAttempts,
        repairExecutionFailed,
        previousFailedCheckIds: failedCheckIdsBeforeRepair,
        currentFailedCheckIds: latestFailedChecks.map((check) => check.id),
      });
      const earlyTemplateRecovery =
        stalledRepair &&
        quantValidation.isQuantDashboardTemplateRecoveryEligible(latestReport);
      if (repairAttempt < maxRepairAttempts && !earlyTemplateRecovery) {
        await markUserRequestAsFailed(
          params.projectId,
          repairRequestId,
          `第 ${repairAttempt}/${maxRepairAttempts} 次自动修复后仍未通过平台验证，继续下一轮修复。`,
        );
        if (activeRepairRequestId === repairRequestId) {
          activeRepairRequestId = null;
        }
        await updateQuantGenerationStep({
          projectPath: params.projectPath,
          projectId: params.projectId,
          requestId: params.requestId,
          stepId: "final_validation",
          status: "warning",
          summary: `第 ${repairAttempt}/${maxRepairAttempts} 次修复后仍有 ${latestFailedChecks.length} 项失败，继续下一轮修复。`,
          metadata: {
            failedChecks: latestFailedChecks.map((check) => ({
              id: check.id,
              summary: check.summary,
            })),
            repairAttempt,
            maxRepairAttempts,
          },
          runStatus: "repairing",
        });
        continue;
      }

      await beginRepair();
      const templateRecovery =
        await quantValidation.restoreQuantDashboardTemplateAfterRepairExhaustion(
          {
            projectPath: params.projectPath,
            report: latestReport,
          },
        );
      if (templateRecovery.restored) {
        streamManager.publish(params.projectId, {
          type: "status",
          data: {
            status: "validation_repairing",
            message: earlyTemplateRecovery
              ? "Agent 修复未正常提交且失败项没有收敛，平台提前使用验证安全模板进行确定性恢复。"
              : "Agent 修复已耗尽，平台正在使用验证安全模板做最后一次确定性恢复。",
            requestId: params.requestId,
            metadata: {
              deterministicTemplateRecovery: true,
              earlyConvergence: earlyTemplateRecovery,
              failedChecks: templateRecovery.failedCheckIds,
            },
          },
        });
        await updateQuantGenerationStep({
          projectPath: params.projectPath,
          projectId: params.projectId,
          requestId: params.requestId,
          stepId: "repair",
          status: "running",
          summary: templateRecovery.reason,
          runStatus: "repairing",
          metadata: {
            deterministicTemplateRecovery: true,
            earlyConvergence: earlyTemplateRecovery,
            failedChecks: templateRecovery.failedCheckIds,
          },
        });

        await quantValidation.prepareQuantProjectForValidation({
          projectId: params.projectId,
          projectPath: params.projectPath,
        });
        await captureAndSeal(
          "platform_template_recovery",
          "平台验证安全模板恢复后封存新的确定性候选。",
          repairRequestId,
        );

        const recoveredReport = await quantValidation.validateQuantProject({
          projectId: params.projectId,
          projectPath: params.projectPath,
          requestId: params.requestId,
          conversationId: params.conversationId,
          cliSource: params.cliSource,
        });
        latestReport = recoveredReport;
        latestFailedChecks = recoveredReport.checks.filter(
          (check) => check.status === "failed",
        );
        if (recoveredReport.passed) {
          const preview = await startValidatedPreview();
          const acceptance = await recordEvidence(preview);
          if (acceptance.decision.verdict !== "accepted") {
            throw new Error(
              `平台安全模板恢复后的证据未被接受：${acceptance.decision.reasonCodes.join(", ") || acceptance.decision.verdict}`,
            );
          }
          await updateQuantGenerationStep({
            projectPath: params.projectPath,
            projectId: params.projectId,
            requestId: params.requestId,
            stepId: "final_validation",
            status: "success",
            summary: "平台验证安全模板恢复后，最终自动验证通过。",
            metadata: {
              deterministicTemplateRecovery: true,
              earlyConvergence: earlyTemplateRecovery,
              checkCount: recoveredReport.checks.length,
            },
          });
          await completeValidatedGeneration(
            recoveredReport,
            "平台验证安全模板恢复后，自动验证与独立证据验收通过。",
            preview,
            acceptance,
          );
          await markUserRequestAsFailed(
            params.projectId,
            repairRequestId,
            "Agent 修复候选未通过；平台安全模板已接管并完成 Mission。",
          );
          if (activeRepairRequestId === repairRequestId) {
            activeRepairRequestId = null;
          }
          return;
        }
        const recoveredEvidence = await recordEvidence();
        if (recoveredEvidence.decision.verdict !== "repair_required") {
          throw new Error(
            `平台安全模板恢复失败且证据状态不可修复：${recoveredEvidence.decision.reasonCodes.join(", ") || recoveredEvidence.decision.verdict}`,
          );
        }
      }

      if (earlyTemplateRecovery && repairAttempt < maxRepairAttempts) {
        await updateQuantGenerationStep({
          projectPath: params.projectPath,
          projectId: params.projectId,
          requestId: params.requestId,
          stepId: "final_validation",
          status: "warning",
          summary: templateRecovery.restored
            ? "确定性模板恢复后仍有阻断项，继续下一次受限修复。"
            : "失败项虽未收敛，但确定性模板不满足安全恢复条件，继续下一次受限修复。",
          metadata: {
            failedChecks: latestFailedChecks.map((check) => ({
              id: check.id,
              summary: check.summary,
            })),
            repairAttempt,
            maxRepairAttempts,
            earlyConvergence: true,
            deterministicTemplateRecovery: templateRecovery.restored,
          },
          runStatus: "repairing",
        });
        continue;
      }

      await failMission(
        "MISSION_VALIDATION_EXHAUSTED",
        "自动验证和修复耗尽后仍未通过平台验收。",
      );
      await updateQuantGenerationStep({
        projectPath: params.projectPath,
        projectId: params.projectId,
        requestId: params.requestId,
        stepId: "final_validation",
        status: "failed",
        summary: `自动修复 ${repairAttempt} 次后仍未通过：${latestFailedChecks.length} 项失败。`,
        metadata: {
          failedChecks: latestFailedChecks.map((check) => ({
            id: check.id,
            summary: check.summary,
          })),
          repairAttempt,
          maxRepairAttempts,
          ...(templateRecovery.restored
            ? { deterministicTemplateRecovery: true }
            : {}),
        },
        runStatus: "failed",
        errorMessage: "自动修复后仍未通过平台验证。",
      });
      await markUserRequestAsFailed(
        params.projectId,
        repairRequestId,
        "自动修复后仍未通过平台验证，请查看 .data-agent/validation.json 和 .data-agent/validation-repair-plan.json。",
      );
      if (activeRepairRequestId === repairRequestId) {
        activeRepairRequestId = null;
      }
      await markUserRequestAsFailed(
        params.projectId,
        params.requestId,
        "自动验证和修复后仍未通过，请查看验证摘要。",
      );
      await finishQuantGenerationQueueItem({
        projectPath: params.projectPath,
        projectId: params.projectId,
        requestId: params.requestId,
        status: "failed",
        errorMessage: "自动验证和修复后仍未通过，请查看验证摘要。",
      });
      await params.publishWorkspaceProgress({
        stage: 5,
        failureReason: `自动验证和修复后仍有 ${latestFailedChecks.length} 项失败。`,
      });
      streamManager.publish(params.projectId, {
        type: "status",
        data: {
          status: "validation_failed",
          message: "自动验证和修复后仍未通过，请查看验证摘要。",
          requestId: params.requestId,
          metadata: {
            terminalFailure: true,
            failedChecks: latestFailedChecks.map((check) => ({
              id: check.id,
              summary: check.summary,
            })),
          },
        },
      });
      return;
    }
  };

  return (async () => {
    let executionCandidate: MoAgentCandidateSubmission | null = null;
    let executionError: unknown;
    try {
      executionCandidate = await params.execution;
    } catch (error) {
      executionError = error;
      console.error(
        "[API] Agent execution or automatic validation failed:",
        error,
      );
    }

    try {
      await validateAndRepair(executionCandidate, executionError);
    } catch (validationError) {
      console.error(
        "[API] Automatic validation after agent execution failed:",
        validationError,
      );
      const message =
        validationError instanceof Error
          ? validationError.message
          : String(validationError || "Automatic validation failed");
      const previewFailure =
        validationError instanceof ValidatedPreviewStartError;
      if (
        validationError instanceof MoAgentMissionStateError &&
        validationError.code === "MISSION_VERIFICATION_LEASE_LOST"
      ) {
        await disposeVerificationSession().catch(() => undefined);
        return;
      }
      if (
        await recoverCommittedAcceptanceProjection().catch((error) => {
          console.error(
            "[API] Failed to inspect committed Mission acceptance:",
            error,
          );
          return false;
        })
      ) {
        return;
      }
      await failMission(
        previewFailure
          ? "MISSION_PREVIEW_FAILED"
          : "MISSION_VALIDATION_PIPELINE_FAILED",
        message,
      );
      await updateQuantGenerationStep({
        projectPath: params.projectPath,
        projectId: params.projectId,
        requestId: params.requestId,
        stepId: previewFailure ? "preview" : "validation",
        status: "failed",
        summary: previewFailure
          ? `持久看板预览启动失败：${message}`
          : `自动验证流程异常：${message}`,
        runStatus: "failed",
        errorMessage: message,
      });
      if (activeRepairRequestId) {
        await markUserRequestAsFailed(
          params.projectId,
          activeRepairRequestId,
          message,
        );
        activeRepairRequestId = null;
      }
      await markUserRequestAsFailed(
        params.projectId,
        params.requestId,
        `自动验证失败：${message}`,
      );
      await finishQuantGenerationQueueItem({
        projectPath: params.projectPath,
        projectId: params.projectId,
        requestId: params.requestId,
        status: "failed",
        errorMessage: message,
      });
      await params.publishWorkspaceProgress({
        stage: 5,
        failureReason: message,
      });
      streamManager.publish(params.projectId, {
        type: "status",
        data: {
          status: previewFailure ? "preview_failed" : "validation_failed",
          message: `生成终态失败：${message}`,
          requestId: params.requestId,
          metadata: {
            terminalFailure: true,
            ...(previewFailure ? { validationPassed: true } : {}),
          },
        },
      });
    } finally {
      await disposeVerificationSession().catch((error) => {
        console.error(
          "[API] Failed to release Mission verification lease:",
          error,
        );
      });
    }
  })();
}
