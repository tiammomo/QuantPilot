/**
 * AI Action API Route
 * POST /api/chat/[project_id]/act - Execute AI command
 */

import { NextRequest, NextResponse } from "next/server";
import {
  getProjectById,
  ensureProjectLlmConfiguration,
  updateProject,
  updateProjectActivity,
} from "@/lib/services/project";
import { createMessage } from "@/lib/services/message";
import { collectMoAgentTurnMetrics } from "@/lib/services/moagent-turn-metrics";
import {
  getDefaultModelForCli,
  normalizeModelId,
} from "@/lib/constants/models";
import { streamManager } from "@/lib/services/stream";
import { generateProjectId } from "@/lib/utils";
import path from "path";
import fs from "fs/promises";
import { randomUUID } from "crypto";
import { ImageAssetError } from "@/lib/server/image-assets";
import {
  ChatActContractError,
  MAX_CHAT_ACT_IMAGE_ATTACHMENTS,
  parseChatActRequest,
} from "@/lib/quant/chat-act-contract";
import {
  MAX_DATA_AGENT_TOTAL_IMAGE_BYTES,
  normalizeDataAgentImageAttachment,
  type ProcessedDataAgentImageAttachment,
} from "@/lib/data-agent";
import {
  buildFinanceAttachmentInstruction,
  writeFinanceAttachmentContext,
} from "@/lib/domains/finance";
import { serializeMessage } from "@/lib/serializers/chat";
import {
  assertUserRequestProjectBinding,
  claimUserRequest,
  upsertUserRequest,
  markUserRequestAsProcessing,
  markUserRequestAsCompleted,
  markUserRequestAsFailed,
  isUserRequestCancelled,
  UserRequestActorMismatchError,
  UserRequestAlreadyExistsError,
  UserRequestProjectMismatchError,
} from "@/lib/services/user-requests";
import { requireAction } from "@/lib/auth/action";
import { AuthorizationError } from "@/lib/auth/authorization";
import { authErrorResponse } from "@/lib/auth/http";
import {
  consumeQuota,
  quotaErrorResponse,
  recordQuotaUsage,
  releaseQuotaReservation,
  renewQuotaReservation,
  reserveQuota,
  settleQuotaReservation,
} from "@/lib/quota";
import { readQuantRunPlan, writeInitialRunPlan } from "@/lib/domains/finance/workspace";
import { prefetchQuantDataForRunPlan } from "@/lib/quant/data-prefetch";
import { getQuantCapability } from "@/lib/domains/finance/capabilities";
import {
  createWorkspaceProgressPublisher,
  type WorkspaceProgressPublisher,
} from "@/lib/quant/workspace-progress";
import { shouldEscalateStalledRepair } from "@/lib/quant/repair-convergence";
import {
  buildClarificationContinuation,
  buildQuantClarificationMessage,
} from "@/lib/domains/finance/intent";
import {
  incrementQuantGenerationRepairAttempt,
  readQuantGenerationState,
  startQuantGenerationRun,
  updateQuantGenerationStep,
} from "@/lib/quant/generation-state";
import {
  finishQuantGenerationQueueItem,
  runQuantGenerationStage,
  startQuantGenerationQueued,
} from "@/lib/quant/generation-queue";
import { validateMoAgentIngressInput } from "@/lib/agent/input-policy";
import { classifyMoAgentExecutionError } from "@/lib/services/moagent-execution-error";
import { MoAgentGenerationLeaseError } from "@/lib/services/moagent-generation-lease-store";
import { refreshMoAgentCandidateWorkspace } from "@/lib/services/moagent-candidate";
import type { MoAgentCandidateSubmission } from "@/lib/agent/mission";
import {
  capturePlatformMissionCandidate,
  claimQuantMoAgentMissionVerification,
  createQuantMoAgentMission,
  markQuantMoAgentMissionNode,
  refreshMoAgentMissionContext,
  sealQuantMoAgentMissionCandidate,
  verifyAndRecordQuantMoAgentMission,
  type MoAgentMissionContext,
} from "@/lib/services/moagent-mission-control";
import {
  cancelMoAgentMission,
  failMoAgentMission,
  markMoAgentMissionRepairing,
  MoAgentMissionStateError,
  readMoAgentAcceptedMissionSnapshot,
} from "@/lib/services/moagent-mission-store";
import {
  startPersistentValidatedPreview,
  type ValidatedGenerationPreview,
} from "@/lib/quant/generation-preview";
import {
  exposePersonalization,
  recallPersonalization,
  type PersonalizationCapsule,
} from "@/lib/platform/memory";
import { detectPersonalMemoryCandidate } from "@/lib/platform/memory/candidate";
import {
  persistAcceptedGovernedKnowledgeUse,
  prepareGovernedKnowledge,
  recordGovernedKnowledgeUsage,
  writeGovernedKnowledgeEvidence,
  type GovernedKnowledgeCapsule,
  type GovernedKnowledgePreparation,
} from "@/lib/platform/knowledge";
import {
  recordContextAcceptance,
  recordContextExposure,
} from "@/lib/platform/context/use-manifest";
import { getProjectIntegrationScope } from "@/lib/platform/context/integration-scope";

interface RouteContext {
  params: Promise<{ project_id: string }>;
}

class QuantPreparationError extends Error {
  constructor(
    readonly code:
      | "SYMBOL_RESOLVER_UNAVAILABLE"
      | "QUANT_ARTIFACT_PREPARATION_FAILED",
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "QuantPreparationError";
  }
}

type CliRuntime = {
  initializeNextJsProject: (
    projectId: string,
    projectPath: string,
    instruction: string,
    model?: string,
    requestId?: string,
    personalization?: PersonalizationCapsule | null,
    governedKnowledge?: GovernedKnowledgeCapsule | null,
  ) => Promise<MoAgentCandidateSubmission>;
  applyChanges: (
    projectId: string,
    projectPath: string,
    instruction: string,
    model?: string,
    requestId?: string,
    images?: ProcessedDataAgentImageAttachment[],
    personalization?: PersonalizationCapsule | null,
    governedKnowledge?: GovernedKnowledgeCapsule | null,
  ) => Promise<MoAgentCandidateSubmission>;
  applyRepairChanges: (
    projectId: string,
    projectPath: string,
    instruction: string,
    model?: string,
    requestId?: string,
    parentRequestId?: string,
  ) => Promise<MoAgentCandidateSubmission>;
};

async function loadCliRuntime(): Promise<CliRuntime> {
  return import("@/lib/services/cli/moagent");
}

async function loadQuantValidation() {
  return import("@/lib/quant/validation");
}

async function ensureQuantDashboardTemplateForAct(projectPath: string) {
  const { ensureQuantDashboardTemplate } = await import("@/lib/utils/scaffold");
  return ensureQuantDashboardTemplate(projectPath);
}

const REQUIRED_AGENT_INPUT_ARTIFACTS = [
  "data_file/final/dashboard-data.json",
  "evidence/sources.json",
  "evidence/data_quality.json",
] as const;

async function missingAgentInputArtifacts(
  projectPath: string,
): Promise<string[]> {
  const checks = await Promise.all(
    REQUIRED_AGENT_INPUT_ARTIFACTS.map(async (relativePath) => {
      try {
        const stat = await fs.stat(
          path.join(/* turbopackIgnore: true */ projectPath, relativePath),
        );
        return stat.isFile() && stat.size > 2 ? null : relativePath;
      } catch {
        return relativePath;
      }
    }),
  );
  return checks.flatMap((value) => (value === null ? [] : [value]));
}

const PROJECTS_DIR = process.env.PROJECTS_DIR || "./data/projects";
const PROJECTS_DIR_ABSOLUTE = path.isAbsolute(PROJECTS_DIR)
  ? PROJECTS_DIR
  : path.resolve(
      /* turbopackIgnore: true */ process.cwd(),
      /* turbopackIgnore: true */ PROJECTS_DIR,
    );

function resolveProjectRoot(
  projectId: string,
  repoPath?: string | null,
): string {
  if (repoPath) {
    return path.isAbsolute(repoPath)
      ? repoPath
      : path.resolve(
          /* turbopackIgnore: true */ process.cwd(),
          /* turbopackIgnore: true */ repoPath,
        );
  }
  return path.join(
    /* turbopackIgnore: true */ PROJECTS_DIR_ABSOLUTE,
    projectId,
  );
}

function canUsePrefetchedSelectionDashboard(params: {
  instruction: string;
  runPlan: Awaited<ReturnType<typeof writeInitialRunPlan>>;
  prefetchSkipped: boolean;
}): boolean {
  if (params.prefetchSkipped) {
    return false;
  }
  const normalized = params.instruction.replace(/\s+/g, "");
  return (
    params.runPlan.visualization?.templateId === "stock-selection" &&
    params.runPlan.symbols.length === 0 &&
    /(?:股票|个股|A股|全A|股票池)/.test(normalized) &&
    /全A|A股股票池|股票池|选股|筛选|候选|短线候选|次日|明日|明天|今日|今天|要买|买股|买入策略|短线|推荐\d*(?:只|个)?(?:股票|个股)|(?:股票|个股).{0,12}推荐|推荐.{0,18}(?:股票|个股)/.test(
      normalized,
    )
  );
}

function quantPipelineToolAction(toolName: string) {
  return toolName === "run-planner"
    ? "Generated"
    : toolName === "dashboard-visualization"
      ? "Created"
      : "Read";
}

function stringifyQuantPipelineToolDetail(value: unknown) {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

async function publishQuantPipelineToolStart(params: {
  projectId: string;
  requestId: string;
  conversationId?: string | null;
  cliSource?: string | null;
  toolName: string;
  summary: string;
  target?: string;
  input?: unknown;
}): Promise<string> {
  const toolCallId = `quant-pipeline-${randomUUID()}`;
  const metadata = {
    toolName: params.toolName,
    tool_name: params.toolName,
    toolCallId,
    tool_call_id: toolCallId,
    action: quantPipelineToolAction(params.toolName),
    success: true,
    resultStatus: "running",
    summary: params.summary,
    isTransientToolMessage: true,
    ...(params.target
      ? { target: params.target, filePath: params.target }
      : {}),
    ...(params.input !== undefined
      ? {
          toolInput: params.input,
          tool_input: params.input,
          input: params.input,
        }
      : {}),
    isQuantPilotPipelineStep: true,
  };
  const message = await createMessage({
    projectId: params.projectId,
    role: "assistant",
    messageType: "tool_use",
    content: params.summary,
    conversationId: params.conversationId ?? undefined,
    cliSource: params.cliSource ?? undefined,
    metadata,
    requestId: params.requestId,
  });
  streamManager.publish(params.projectId, {
    type: "message",
    data: serializeMessage(message, { requestId: params.requestId }),
  });
  return toolCallId;
}

async function publishQuantPipelineToolMessage(params: {
  projectId: string;
  requestId: string;
  conversationId?: string | null;
  cliSource?: string | null;
  toolName: string;
  summary: string;
  target?: string;
  input?: unknown;
  output?: unknown;
  toolCallId?: string;
  success?: boolean;
  resultStatus?: "completed" | "failed" | "skipped";
}) {
  const success = params.success !== false;
  const resultStatus =
    params.resultStatus ?? (success ? "completed" : "failed");
  const metadata = {
    toolName: params.toolName,
    tool_name: params.toolName,
    ...(params.toolCallId
      ? { toolCallId: params.toolCallId, tool_call_id: params.toolCallId }
      : {}),
    action: quantPipelineToolAction(params.toolName),
    success,
    resultStatus,
    summary: params.summary,
    isTransientToolMessage: false,
    ...(params.target
      ? {
          target: params.target,
          filePath: params.target,
        }
      : {}),
    ...(params.input !== undefined
      ? {
          toolInput: params.input,
          tool_input: params.input,
          input: params.input,
        }
      : {}),
    ...(params.output !== undefined
      ? {
          toolOutput: stringifyQuantPipelineToolDetail(params.output),
          tool_output: stringifyQuantPipelineToolDetail(params.output),
          output: stringifyQuantPipelineToolDetail(params.output),
        }
      : {}),
    isQuantPilotPipelineStep: true,
  };

  const message = await createMessage({
    projectId: params.projectId,
    role: "assistant",
    messageType: "tool_result",
    content: params.summary,
    conversationId: params.conversationId ?? undefined,
    cliSource: params.cliSource ?? undefined,
    metadata,
    requestId: params.requestId,
  });

  streamManager.publish(params.projectId, {
    type: "message",
    data: serializeMessage(message, { requestId: params.requestId }),
  });

  return message;
}

class ValidatedPreviewStartError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ValidatedPreviewStartError";
  }
}

function runValidationAfterExecution(params: {
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

/**
 * POST /api/chat/[project_id]/act
 * Execute AI command
 */
export async function POST(request: NextRequest, { params }: RouteContext) {
  let concurrentQuotaReservationId: string | null = null;
  let concurrentQuotaHeartbeat: ReturnType<typeof setInterval> | null = null;
  let concurrentQuotaHandedOff = false;
  let claimedRequest: { projectId: string; requestId: string } | null = null;
  let acceptedMission: MoAgentMissionContext | null = null;
  const releaseConcurrentQuota = async () => {
    if (concurrentQuotaHeartbeat) {
      clearInterval(concurrentQuotaHeartbeat);
      concurrentQuotaHeartbeat = null;
    }
    if (!concurrentQuotaReservationId) return;
    await releaseQuotaReservation({
      reservationId: concurrentQuotaReservationId,
    }).catch((error) => {
      console.error(
        "[Quota] Failed to release Agent concurrency reservation:",
        error,
      );
    });
  };
  try {
    const { project_id } = await params;
    const actionContext = await requireAction({
      headers: request.headers,
      action: "agent.run",
      projectId: project_id,
    });
    const authSession = actionContext.session;
    const actorUserId = authSession?.user.id ?? null;
    const contentLength = Number(request.headers.get("content-length"));
    const maxRequestBytes =
      MAX_DATA_AGENT_TOTAL_IMAGE_BYTES + 2 * 1024 * 1024;
    if (Number.isFinite(contentLength) && contentLength > maxRequestBytes) {
      return NextResponse.json(
        { success: false, error: "Request attachments are too large" },
        { status: 413 },
      );
    }
    let rawBody: unknown;
    try {
      rawBody = await request.json();
    } catch {
      return NextResponse.json(
        { success: false, error: "INVALID_JSON", message: "Request body must be valid JSON." },
        { status: 400 },
      );
    }
    let body;
    try {
      body = parseChatActRequest(rawBody);
    } catch (error) {
      if (error instanceof ChatActContractError) {
        return NextResponse.json(
          {
            success: false,
            error: "INVALID_ACT_REQUEST",
            message: error.message,
            issues: error.issues,
          },
          { status: 400 },
        );
      }
      throw error;
    }
    const rawInstruction = body.instruction;
    const rawDisplayInstruction = body.displayInstruction;
    const requestId = body.requestId ?? generateProjectId();
    const ingressDecision = validateMoAgentIngressInput({
      instruction: rawInstruction,
      displayInstruction: rawDisplayInstruction,
      requestId,
    });
    if (!ingressDecision.ok) {
      return NextResponse.json(
        { success: false, error: ingressDecision.error },
        { status: ingressDecision.status },
      );
    }

    const rawImages = body.images;
    if (rawImages.length > MAX_CHAT_ACT_IMAGE_ATTACHMENTS) {
      return NextResponse.json(
        {
          success: false,
          error: `At most ${MAX_CHAT_ACT_IMAGE_ATTACHMENTS} image attachments are allowed`,
        },
        { status: 413 },
      );
    }
    if (
      !rawInstruction.trim() &&
      !(rawDisplayInstruction ?? "").trim() &&
      rawImages.length === 0
    ) {
      return NextResponse.json(
        { success: false, error: "instruction or images are required" },
        { status: 400 },
      );
    }

    const project = await getProjectById(project_id);
    if (!project) {
      return NextResponse.json(
        { success: false, error: "Project not found" },
        { status: 404 },
      );
    }

    let requestAlreadyExists = false;
    try {
      requestAlreadyExists = await assertUserRequestProjectBinding(
        project_id,
        requestId,
        actorUserId,
      );
    } catch (error) {
      if (
        error instanceof UserRequestProjectMismatchError ||
        error instanceof UserRequestActorMismatchError
      ) {
        return NextResponse.json(
          {
            success: false,
            error: "Request ID belongs to a different project or user",
          },
          { status: 409 },
        );
      }
      throw error;
    }
    if (requestAlreadyExists) {
      return NextResponse.json(
        {
          success: false,
          error: "REQUEST_ID_ALREADY_EXISTS",
          message:
            "该 requestId 已被使用；请读取原请求状态，或为新的执行生成新 requestId。",
          requestId,
        },
        { status: 409 },
      );
    }

    const cliPreference = "moagent";
    try {
      await claimUserRequest({
        id: requestId,
        projectId: project_id,
        actorUserId,
        instruction:
          rawDisplayInstruction?.trim() ||
          rawInstruction.trim() ||
          "请分析用户上传的图片附件。",
        cliPreference,
      });
      claimedRequest = { projectId: project_id, requestId };
    } catch (error) {
      if (error instanceof UserRequestAlreadyExistsError) {
        return NextResponse.json(
          {
            success: false,
            error: "REQUEST_ID_ALREADY_EXISTS",
            message: "该 requestId 已由另一个请求占用，请读取原请求状态。",
            requestId,
          },
          { status: 409 },
        );
      }
      if (
        error instanceof UserRequestProjectMismatchError ||
        error instanceof UserRequestActorMismatchError
      ) {
        return NextResponse.json(
          {
            success: false,
            error: "Request ID belongs to a different project or user",
          },
          { status: 409 },
        );
      }
      throw error;
    }

    if (authSession) {
      const concurrencyQuota = await reserveQuota({
        actorUserId: authSession.user.id,
        projectId: project_id,
        metric: "agent.concurrent",
        quantity: 1,
        idempotencyKey: `agent-concurrent:${authSession.user.id}:${requestId}`,
        reservationTtlSeconds: 3_600,
      });
      if (
        !concurrencyQuota.reservation ||
        concurrencyQuota.reservation.status !== "active" ||
        concurrencyQuota.reservation.idempotent
      ) {
        await markUserRequestAsFailed(
          project_id,
          requestId,
          "Agent concurrency reservation could not be acquired for this request.",
        );
        return NextResponse.json(
          {
            success: false,
            error: "REQUEST_ACCEPTANCE_IN_PROGRESS",
            message: "相同 requestId 正在被接收或已经结束，请读取原请求状态。",
            requestId,
          },
          { status: 409 },
        );
      }
      concurrentQuotaReservationId = concurrencyQuota.reservation.id;
      const reservationLeaseMs = Math.max(
        30_000,
        concurrencyQuota.reservation.expiresAt.getTime() - Date.now(),
      );
      const heartbeatIntervalMs = Math.max(
        1_000,
        Math.min(5 * 60 * 1_000, Math.floor(reservationLeaseMs / 3)),
      );
      concurrentQuotaHeartbeat = setInterval(() => {
        void renewQuotaReservation({
          reservationId: concurrentQuotaReservationId!,
          reservationTtlSeconds: 3_600,
        }).catch((error) => {
          console.error(
            "[Quota] Failed to renew Agent concurrency reservation:",
            error,
          );
        });
      }, heartbeatIntervalMs);
      if (
        typeof concurrentQuotaHeartbeat === "object" &&
        "unref" in concurrentQuotaHeartbeat
      ) {
        concurrentQuotaHeartbeat.unref();
      }
    }

    const projectRoot = resolveProjectRoot(project_id, project.repoPath);
    const projectPath =
      project.repoPath ||
      path.join(
        /*turbopackIgnore: true*/ process.cwd(),
        "projects",
        project_id,
      );
    const instructionWithoutLegacyPaths = rawInstruction
      .replace(/\n*Image #\d+ path: [^\n]+/g, "")
      .trim();
    const visibleInstructionWithoutLegacyPaths = (
      rawDisplayInstruction ?? rawInstruction
    )
      .replace(/\n*Image #\d+ path: [^\n]+/g, "")
      .trim();

    const conversationId = body.conversationId;

    const processedImages: ProcessedDataAgentImageAttachment[] = [];
    let totalImageBytes = 0;
    try {
      for (let index = 0; index < rawImages.length; index += 1) {
        const normalized = await normalizeDataAgentImageAttachment({
          projectId: project_id,
          projectRoot,
          attachment: rawImages[index],
          index,
        });
        totalImageBytes += normalized.size ?? 0;
        if (totalImageBytes > MAX_DATA_AGENT_TOTAL_IMAGE_BYTES) {
          throw new ImageAssetError(
            `Image attachments exceed the ${Math.floor(MAX_DATA_AGENT_TOTAL_IMAGE_BYTES / 1024 / 1024)}MB total limit`,
            413,
          );
        }
        processedImages.push(normalized);
      }
    } catch (error) {
      if (error instanceof ImageAssetError) {
        await markUserRequestAsFailed(project_id, requestId, error.message);
        return NextResponse.json(
          { success: false, error: error.message },
          { status: error.status },
        );
      }
      throw error;
    }

    const attachmentContextPath = await writeFinanceAttachmentContext({
      projectRoot,
      projectId: project_id,
      requestId,
      images: processedImages,
    });
    const imageAttachmentInstruction = buildFinanceAttachmentInstruction({
      attachmentContextPath,
      images: processedImages,
    });
    const imageLines = processedImages.map(
      (image, idx) => `Image #${idx + 1} path: ${image.path}`,
    );
    const finalInstruction = [
      instructionWithoutLegacyPaths ||
        (processedImages.length > 0 ? "请分析用户上传的图片附件。" : ""),
      imageAttachmentInstruction || imageLines.join("\n"),
    ]
      .filter((segment) => segment && segment.trim().length > 0)
      .join("\n\n")
      .trim();
    const displayInstruction =
      visibleInstructionWithoutLegacyPaths ||
      (processedImages.length > 0 ? "请分析上传的图片附件" : finalInstruction);

    if (!finalInstruction) {
      await markUserRequestAsFailed(
        project_id,
        requestId,
        "instruction or images are required",
      );
      return NextResponse.json(
        { success: false, error: "instruction or images are required" },
        { status: 400 },
      );
    }

    if (authSession) {
      await consumeQuota({
        actorUserId: authSession.user.id,
        projectId: project_id,
        metric: "agent.requests.daily",
        quantity: 1,
        idempotencyKey: `agent-request:${authSession.user.id}:${requestId}`,
        sourceType: "user_request",
        sourceId: requestId,
        usageEventIdempotencyKey: `user-request:${requestId}:daily`,
      });
    }

    const selectedModelRaw =
      body.selectedModel ?? project.selectedModel ?? getDefaultModelForCli(cliPreference);
    const selectedModel = normalizeModelId(cliPreference, selectedModelRaw);

    const quantCapabilityId = body.quantCapabilityId;
    const quantCapabilitySource = body.quantCapabilitySource;

    await ensureProjectLlmConfiguration({
      projectId: project_id,
      projectName: project.name,
      projectPath,
      preferredCli: project.preferredCli,
      selectedModel,
      settings: project.settings,
    });

    const isInitialPrompt = body.isInitialPrompt;

    const previousRunPlan = await readQuantRunPlan(projectPath);
    const clarificationContinuation = buildClarificationContinuation({
      previousPlan: previousRunPlan,
      instruction: finalInstruction,
      displayInstruction,
      capabilityId: quantCapabilityId,
      reset: isInitialPrompt,
    });
    const effectiveInstruction = clarificationContinuation
      ? `${clarificationContinuation.resolvedInstruction}${imageAttachmentInstruction}`
      : finalInstruction;
    const effectiveDisplayInstruction =
      clarificationContinuation?.displayInstruction ?? displayInstruction;
    const userVisibleInstructionForRepair =
      effectiveDisplayInstruction &&
      effectiveDisplayInstruction.trim().length > 0
        ? effectiveDisplayInstruction.trim()
        : finalInstruction;

    const memoryRecall = await recallPersonalization({
      projectId: project_id,
      actorUserId: actionContext.actorUserId,
      requestId,
      instruction: effectiveDisplayInstruction || effectiveInstruction,
      capabilityId: quantCapabilityId,
    });
    const personalizationCandidate = detectPersonalMemoryCandidate(
      effectiveDisplayInstruction ||
        instructionWithoutLegacyPaths ||
        effectiveInstruction,
    );

    const metadata =
      processedImages.length > 0 ||
      clarificationContinuation ||
      memoryRecall.status !== "disabled" ||
      personalizationCandidate !== null
        ? {
            ...(processedImages.length > 0
              ? {
                  attachments: processedImages.map((image) => ({
                    name: image.name,
                    url: image.url,
                    publicUrl: image.publicUrl,
                    path: image.path,
                  })),
                  attachmentContextPath,
                }
              : {}),
            ...(clarificationContinuation
              ? {
                  type: "intent_clarification_continuation",
                  clarificationContinuation: {
                    previousRunId: clarificationContinuation.previousRunId,
                    originalQuestion:
                      clarificationContinuation.originalQuestion,
                    userResponse: clarificationContinuation.userResponse,
                    missing: clarificationContinuation.missing,
                  },
                }
              : {}),
            ...(memoryRecall.status !== "disabled"
              ? {
                  personalization: {
                    status: memoryRecall.status,
                    exposedMemoryCount: memoryRecall.exposedMemoryCount,
                  },
                }
              : {}),
            ...(personalizationCandidate ? { personalizationCandidate } : {}),
          }
        : undefined;

    const storedInstruction =
      effectiveDisplayInstruction &&
      effectiveDisplayInstruction.trim().length > 0
        ? effectiveDisplayInstruction.trim()
        : instructionWithoutLegacyPaths || effectiveInstruction;
    try {
      await upsertUserRequest({
        id: requestId,
        projectId: project_id,
        actorUserId,
        instruction: storedInstruction || effectiveInstruction,
        cliPreference,
      });
      const processing = await markUserRequestAsProcessing(
        project_id,
        requestId,
      );
      if (!processing) {
        return NextResponse.json(
          {
            success: false,
            error: "Request is no longer active for this project",
          },
          { status: 409 },
        );
      }
    } catch (error) {
      if (
        error instanceof UserRequestProjectMismatchError ||
        error instanceof UserRequestActorMismatchError
      ) {
        return NextResponse.json(
          {
            success: false,
            error: "Request ID belongs to a different project or user",
          },
          { status: 409 },
        );
      }
      throw error;
    }

    console.log("📸 Creating message with attachments:", {
      projectId: project_id,
      hasAttachments: processedImages.length > 0,
      attachmentsCount: processedImages.length,
      metadataKeys: metadata ? Object.keys(metadata) : [],
    });

    const userMessage = await createMessage({
      projectId: project_id,
      role: "user",
      messageType: "chat",
      content: effectiveDisplayInstruction || effectiveInstruction,
      conversationId: conversationId ?? undefined,
      cliSource: cliPreference,
      metadata,
      requestId: requestId,
    });

    console.log("📸 Message created successfully:", {
      messageId: userMessage.id,
      hasMetadata: Boolean(metadata),
      metadataType: metadata ? typeof metadata : "undefined",
      metadataKeys: metadata ? Object.keys(metadata) : [],
      metadataString: metadata ? JSON.stringify(metadata, null, 2) : undefined,
      metadataJsonLength: userMessage.metadataJson
        ? userMessage.metadataJson.length
        : 0,
    });

    streamManager.publish(project_id, {
      type: "message",
      data: serializeMessage(userMessage, { requestId }),
    });

    const relatedAgentRequestIds = new Set<string>([requestId]);
    const publishWorkspaceProgress = createWorkspaceProgressPublisher({
      projectId: project_id,
      requestId,
      conversationId,
      cliSource: cliPreference,
      relatedAgentRequestIds,
    });

    await updateProjectActivity(project_id);

    const existingSelected = normalizeModelId(
      project.preferredCli ?? "moagent",
      project.selectedModel ?? undefined,
    );
    let usePrefetchedSelectionDashboard = false;
    let missionContext: MoAgentMissionContext | null = null;
    const projectIntegrationScope = getProjectIntegrationScope(project_id);
    let governedKnowledgePreparation: GovernedKnowledgePreparation | null =
      null;
    let governedKnowledgeTaskCategory = "quant-research";

    const clarificationResponse = await runQuantGenerationStage({
      projectPath,
      projectId: project_id,
      requestId,
      stage: "planning_data_prefetch",
      lockWorkspace: true,
      task: async () => {
        const generationState = await startQuantGenerationRun({
          projectPath,
          projectId: project_id,
          requestId,
          instruction: finalInstruction,
          cliPreference,
          selectedModel,
        });
        if (
          generationState.status === "cancelled" ||
          (await isUserRequestCancelled(project_id, requestId))
        ) {
          await publishWorkspaceProgress({
            stage: 5,
            cancelledReason: "请求在规划开始前已暂停。",
          });
          return NextResponse.json({
            success: true,
            status: "cancelled",
            message: "Generation request was cancelled before planning",
            requestId,
            userMessageId: userMessage.id,
            conversationId: conversationId ?? null,
          });
        }
        let queryRewriteToolCallId: string | undefined;
        let runPlannerToolCallId: string | undefined;
        let dataRegistryToolCallId: string | undefined;
        let marketDataToolCallId: string | undefined;
        let dashboardVisualizationToolCallId: string | undefined;
        let queryRewriteQuotaReservationId: string | null = null;
        try {
          await updateQuantGenerationStep({
            projectPath,
            projectId: project_id,
            requestId,
            stepId: "planning",
            status: "running",
            summary: "开始生成 run plan。",
          });
          const planningInstruction =
            effectiveDisplayInstruction &&
            effectiveDisplayInstruction.trim().length > 0
              ? effectiveDisplayInstruction.trim()
              : effectiveInstruction;
          queryRewriteToolCallId = await publishQuantPipelineToolStart({
            projectId: project_id,
            requestId,
            conversationId,
            cliSource: cliPreference,
            toolName: "query-rewrite",
            target: ".data-agent/finance-query-rewrite.json",
            summary: "正在把用户问题整理为可执行的标的、周期和分析合同。",
            input: {
              question: planningInstruction,
              requestedCapabilityId: quantCapabilityId,
            },
          });
          runPlannerToolCallId = await publishQuantPipelineToolStart({
            projectId: project_id,
            requestId,
            conversationId,
            cliSource: cliPreference,
            toolName: "run-planner",
            target: ".data-agent/finance-run-plan.json",
            summary: "正在核对分析对象、时间范围、数据需求和验收规则。",
            input: {
              question: planningInstruction,
              requestedCapabilityId: quantCapabilityId,
            },
          });
          if (authSession) {
            const queryRewriteQuota = await reserveQuota({
              actorUserId: authSession.user.id,
              projectId: project_id,
              metric: "query_rewrite.llm.daily",
              quantity: 1,
              idempotencyKey: `chat-query-rewrite:${authSession.user.id}:${requestId}:reservation`,
            });
            queryRewriteQuotaReservationId =
              queryRewriteQuota.reservation?.id ?? null;
          }
          const runPlan = await writeInitialRunPlan({
            projectId: project_id,
            projectPath,
            instruction: planningInstruction,
            requestId,
            capabilityId: quantCapabilityId,
            capabilitySource: quantCapabilitySource,
            hasImageAttachments: processedImages.length > 0,
            previousPlan: previousRunPlan,
            llmModel: selectedModel,
          });

          const queryRewriteUsage = runPlan.queryRewrite?.execution.llm.usage;
          if (authSession && queryRewriteQuotaReservationId) {
            await settleQuotaReservation({
              reservationId: queryRewriteQuotaReservationId,
              actualQuantity: runPlan.queryRewrite?.execution.llm.attempted
                ? 1
                : 0,
              sourceType: "query_rewrite",
              sourceId: requestId,
              usageEventIdempotencyKey: `chat-query-rewrite:${authSession.user.id}:${requestId}:request`,
              metadata: {
                status:
                  runPlan.queryRewrite?.execution.llm.status ?? "not_attempted",
                strategy:
                  runPlan.queryRewrite?.execution.strategy ?? "deterministic",
              },
            });
            queryRewriteQuotaReservationId = null;
          }
          if (
            authSession &&
            runPlan.queryRewrite?.execution.llm.attempted &&
            queryRewriteUsage &&
            queryRewriteUsage.totalTokens > 0
          ) {
            const actorId = authSession.user.id;
            await recordQuotaUsage({
              actorUserId: actorId,
              projectId: project_id,
              metric: "llm.total_tokens.monthly",
              quantity: queryRewriteUsage.totalTokens,
              idempotencyKey: `chat-query-rewrite:${actorId}:${requestId}:tokens`,
              sourceType: "query_rewrite",
              sourceId: requestId,
              metadata: {
                provider: runPlan.queryRewrite.execution.llm.provider,
                model: runPlan.queryRewrite.execution.llm.model,
                inputTokens: queryRewriteUsage.inputTokens,
                outputTokens: queryRewriteUsage.outputTokens,
              },
            }).catch((error) => {
              console.error(
                "[Quota] Failed to record chat Query Rewrite token usage:",
                error,
              );
            });
          }

          await publishQuantPipelineToolMessage({
            projectId: project_id,
            requestId,
            conversationId,
            cliSource: cliPreference,
            toolName: "query-rewrite",
            toolCallId: queryRewriteToolCallId,
            target: ".data-agent/finance-query-rewrite.json",
            summary:
              runPlan.queryRewrite?.status === "refused"
                ? "问题改写完成，安全策略已阻止确定性收益承诺。"
                : runPlan.queryRewrite?.status === "ready"
                  ? `问题改写完成，已解析 ${runPlan.queryRewrite.resolvedSymbols.length} 个标的${runPlan.queryRewrite.execution.llm.applied ? "，并完成 LLM 语义增强" : ""}。`
                  : "问题改写完成，存在需要确认的标的或输入。",
            input: { question: planningInstruction },
            output: runPlan.queryRewrite ?? {},
          });
          queryRewriteToolCallId = undefined;

          await publishWorkspaceProgress({ stage: 1, runPlan });
          await publishQuantPipelineToolMessage({
            projectId: project_id,
            requestId,
            conversationId,
            cliSource: cliPreference,
            toolName: "run-planner",
            toolCallId: runPlannerToolCallId,
            target: ".data-agent/finance-run-plan.json",
            summary:
              runPlan.status === "refused"
                ? "请求触发确定性安全策略，停止进入取数和生成链路。"
                : runPlan.status === "needs_clarification"
                  ? "已完成初步识别，发现关键输入仍需澄清。"
                  : `生成 ${runPlan.capabilityId} 执行计划，准备进入数据源选择和预取。`,
            input: {
              question: runPlan.question,
              capabilityId: runPlan.capabilityId,
            },
            output: {
              status: runPlan.status,
              templateId: runPlan.visualization?.templateId,
              symbols: runPlan.symbols,
              dataRequirements: runPlan.dataRequirements,
              analysisSteps: runPlan.analysisSteps,
            },
          });
          runPlannerToolCallId = undefined;

          if (runPlan.status === "refused" && runPlan.refusal) {
            await updateQuantGenerationStep({
              projectPath,
              projectId: project_id,
              requestId,
              stepId: "planning",
              status: "warning",
              summary: "请求触发安全策略，未执行取数或生成。",
              runStatus: "refused",
              metadata: {
                code: runPlan.refusal.code,
              },
            });
            const assistantMessage = await createMessage({
              projectId: project_id,
              role: "assistant",
              messageType: "chat",
              content: runPlan.refusal.message,
              conversationId: conversationId ?? undefined,
              cliSource: cliPreference,
              metadata: {
                type: "intent_refusal",
                refusal: runPlan.refusal,
                runPlanPath: ".data-agent/finance-run-plan.json",
                isMissionFinal: true,
                progressStatus: "refused",
              },
              requestId,
            });
            await markUserRequestAsCompleted(project_id, requestId);
            streamManager.publish(project_id, {
              type: "message",
              data: serializeMessage(assistantMessage, { requestId }),
            });
            streamManager.publish(project_id, {
              type: "status",
              data: {
                status: "intent_refused",
                message: runPlan.refusal.message,
                requestId,
                metadata: { code: runPlan.refusal.code },
              },
            });
            return NextResponse.json({
              success: true,
              status: "intent_refused",
              message: runPlan.refusal.message,
              requestId,
              userMessageId: userMessage.id,
              assistantMessageId: assistantMessage.id,
              conversationId: conversationId ?? null,
              refusal: runPlan.refusal,
            });
          }

          if (
            runPlan.status === "needs_clarification" &&
            runPlan.clarification?.required
          ) {
            await updateQuantGenerationStep({
              projectPath,
              projectId: project_id,
              requestId,
              stepId: "planning",
              status: "warning",
              summary: "任务缺少关键输入，需要用户澄清。",
              runStatus: "needs_clarification",
              metadata: {
                missing: runPlan.clarification.missing,
                questions: runPlan.clarification.questions,
              },
            });
            const clarificationContent = buildQuantClarificationMessage(
              runPlan.clarification,
            );
            const turnMetrics = await collectMoAgentTurnMetrics({
              projectId: project_id,
              requestId,
              relatedRequestIds: relatedAgentRequestIds,
            }).catch((error) => {
              console.error(
                "[API] Failed to collect clarification turn metrics:",
                error,
              );
              return null;
            });
            const assistantMessage = await createMessage({
              projectId: project_id,
              role: "assistant",
              messageType: "chat",
              content: clarificationContent,
              conversationId: conversationId ?? undefined,
              cliSource: cliPreference,
              metadata: {
                type: "intent_clarification",
                clarification: runPlan.clarification,
                runPlanPath: ".data-agent/finance-run-plan.json",
                isMissionFinal: true,
                progressStatus: "clarification",
                ...(turnMetrics ? { turnMetrics } : {}),
              },
              requestId,
            });

            await markUserRequestAsCompleted(project_id, requestId);
            streamManager.publish(project_id, {
              type: "message",
              data: serializeMessage(assistantMessage, { requestId }),
            });
            streamManager.publish(project_id, {
              type: "status",
              data: {
                status: "intent_clarification_required",
                message: "需要补充关键信息后再开始取数和生成看板。",
                requestId,
                metadata: {
                  missing: runPlan.clarification.missing,
                  questions: runPlan.clarification.questions,
                },
              },
            });

            return NextResponse.json({
              success: true,
              status: "intent_clarification_required",
              message: "Need clarification before agent execution",
              requestId,
              userMessageId: userMessage.id,
              assistantMessageId: assistantMessage.id,
              conversationId: conversationId ?? null,
              clarification: runPlan.clarification,
            });
          }

          governedKnowledgePreparation = await prepareGovernedKnowledge({
            requestId,
            scope: projectIntegrationScope,
            task: [
              runPlan.queryRewrite?.rewrittenQuery ?? runPlan.question,
              `capability: ${runPlan.requestedCapabilityId ?? runPlan.capabilityId}`,
              ...runPlan.analysisSteps.slice(0, 12),
            ].join("\n"),
          });
          governedKnowledgeTaskCategory =
            runPlan.requestedCapabilityId ??
            runPlan.capabilityId ??
            "quant-research";
          await writeGovernedKnowledgeEvidence({
            projectPath,
            requestId,
            preparation: governedKnowledgePreparation,
          });
          streamManager.publish(project_id, {
            type: "status",
            data: {
              status: "governed_knowledge_prepared",
              message:
                governedKnowledgePreparation.status === "prepared"
                  ? `已取得 ${governedKnowledgePreparation.citationCount} 条受治理知识引用。`
                  : governedKnowledgePreparation.status === "empty"
                    ? "受治理知识检索无匹配结果，继续使用真实市场数据。"
                    : governedKnowledgePreparation.status === "unavailable"
                      ? "受治理知识服务当前不可用，已按可选依赖降级。"
                      : "受治理知识集成未启用。",
              requestId,
              metadata: {
                knowledgeStatus: governedKnowledgePreparation.status,
                passageCount: governedKnowledgePreparation.passageCount,
                citationCount: governedKnowledgePreparation.citationCount,
              },
            },
          });

          missionContext = await createQuantMoAgentMission({
            projectId: project_id,
            projectPath,
            requestId,
            objective:
              runPlan.queryRewrite?.rewrittenQuery ?? planningInstruction,
            runPlan,
            maxRepairAttempts: generationState.maxRepairAttempts,
          });

          await updateQuantGenerationStep({
            projectPath,
            projectId: project_id,
            requestId,
            stepId: "planning",
            status: "success",
            summary: `已生成 ${runPlan.capabilityId} 执行计划。`,
            metadata: {
              capabilityId: runPlan.capabilityId,
              symbols: runPlan.symbols,
              expectedArtifacts: runPlan.expectedArtifacts,
              missionId: missionContext.id,
              generationId: missionContext.generationId,
              missionSpecSha256: missionContext.specHash,
            },
          });
          missionContext = await markQuantMoAgentMissionNode({
            mission: missionContext,
            nodeKey: "planning",
            status: "passed",
          });
          await publishWorkspaceProgress({
            stage: 2,
            runPlan,
            skillIds: Array.from(
              new Set([
                "quant-data-registry",
                ...getQuantCapability(
                  runPlan.requestedCapabilityId ?? runPlan.capabilityId,
                ).requiredSkills.filter(
                  (skillId) =>
                    skillId !== "run-planner" &&
                    skillId !== "dashboard-visualization" &&
                    (skillId !== "image-extraction" ||
                      processedImages.length > 0),
                ),
              ]),
            ),
          });
          dataRegistryToolCallId = await publishQuantPipelineToolStart({
            projectId: project_id,
            requestId,
            conversationId,
            cliSource: cliPreference,
            toolName: "quant-data-registry",
            target: "本地数据覆盖与标的解析",
            summary: "正在核验本地数据覆盖、标的解析和可用信源。",
            input: {
              question: runPlan.question,
              templateId: runPlan.visualization?.templateId,
            },
          });
          marketDataToolCallId = await publishQuantPipelineToolStart({
            projectId: project_id,
            requestId,
            conversationId,
            cliSource: cliPreference,
            toolName: "quant-market-data",
            target: "data_file/final/dashboard-data.json",
            summary: "正在获取真实行情、历史数据和任务所需指标。",
            input: {
              symbols: runPlan.symbols,
              timeRange: runPlan.timeRange,
            },
          });
          await updateQuantGenerationStep({
            projectPath,
            projectId: project_id,
            requestId,
            stepId: "data_prefetch",
            status: "running",
            summary: "开始预取真实数据。",
          });
          missionContext = await markQuantMoAgentMissionNode({
            mission: missionContext,
            nodeKey: "data_prefetch",
            status: "running",
          });
          const prefetch = await prefetchQuantDataForRunPlan({
            projectPath,
            plan: runPlan,
          });
          if (authSession && !prefetch.skipped) {
            const dataUnits = Math.max(1, prefetch.rawFiles?.length ?? 0);
            await recordQuotaUsage({
              actorUserId: authSession.user.id,
              projectId: project_id,
              metric: "quant.data_units.daily",
              quantity: dataUnits,
              idempotencyKey: `chat-data-prefetch:${authSession.user.id}:${requestId}`,
              sourceType: "quant_data_prefetch",
              sourceId: requestId,
              metadata: {
                symbolCount:
                  prefetch.symbols?.length ?? (prefetch.symbol ? 1 : 0),
                rawFileCount: prefetch.rawFiles?.length ?? 0,
              },
            }).catch((error) => {
              console.error(
                "[Quota] Failed to record chat data-prefetch usage:",
                error,
              );
            });
          }
          const missingPreparedArtifacts =
            await missingAgentInputArtifacts(projectPath);
          if (
            processedImages.length === 0 &&
            (missingPreparedArtifacts.length > 0 ||
              (isInitialPrompt && prefetch.skipped))
          ) {
            const resolverUnavailable = runPlan.queryRewrite?.issues.find(
              (issue) => issue.code === "SYMBOL_RESOLVER_UNAVAILABLE",
            );
            if (resolverUnavailable) {
              throw new QuantPreparationError(
                "SYMBOL_RESOLVER_UNAVAILABLE",
                `证券标的解析服务暂不可用，平台已停止后续取数：${resolverUnavailable.message}`,
                true,
              );
            }
            throw new QuantPreparationError(
              "QUANT_ARTIFACT_PREPARATION_FAILED",
              `平台数据准备未完成，拒绝启动只具备 UI 创作权限的 MoAgent。${
                missingPreparedArtifacts.length
                  ? ` 缺少：${missingPreparedArtifacts.join("、")}。`
                  : ""
              } ${prefetch.summary}`.trim(),
              false,
            );
          }
          usePrefetchedSelectionDashboard = canUsePrefetchedSelectionDashboard({
            instruction: effectiveInstruction,
            runPlan,
            prefetchSkipped: prefetch.skipped,
          });
          await updateQuantGenerationStep({
            projectPath,
            projectId: project_id,
            requestId,
            stepId: "data_prefetch",
            status: prefetch.skipped ? "skipped" : "success",
            summary: prefetch.summary,
            metadata: {
              skipped: prefetch.skipped,
              symbol: prefetch.skipped ? undefined : prefetch.symbol,
              symbols: prefetch.skipped ? undefined : prefetch.symbols,
              finalDataPath: prefetch.skipped
                ? undefined
                : prefetch.finalDataPath,
              rawFiles: prefetch.skipped ? undefined : prefetch.rawFiles,
              deterministicDashboard:
                usePrefetchedSelectionDashboard || undefined,
            },
          });
          missionContext = await markQuantMoAgentMissionNode({
            mission: missionContext,
            nodeKey: "data_prefetch",
            status: prefetch.skipped ? "skipped" : "passed",
          });
          missionContext = await markQuantMoAgentMissionNode({
            mission: missionContext,
            nodeKey: "workspace_generation",
            status: "running",
          });
          if (prefetch.skipped) {
            await publishQuantPipelineToolMessage({
              projectId: project_id,
              requestId,
              conversationId,
              cliSource: cliPreference,
              toolName: "quant-data-registry",
              toolCallId: dataRegistryToolCallId,
              target: "本地数据预取",
              summary: prefetch.summary,
              output: {
                skipped: true,
                reason: prefetch.summary,
              },
            });
            dataRegistryToolCallId = undefined;
            await publishQuantPipelineToolMessage({
              projectId: project_id,
              requestId,
              conversationId,
              cliSource: cliPreference,
              toolName: "quant-market-data",
              toolCallId: marketDataToolCallId,
              target: "data_file/final/dashboard-data.json",
              summary: `本阶段未重复获取行情数据：${prefetch.summary}`,
              resultStatus: "skipped",
              output: {
                skipped: true,
                reason: prefetch.summary,
              },
            });
            marketDataToolCallId = undefined;
            await publishWorkspaceProgress({
              stage: 3,
              runPlan,
              skillIds: ["dashboard-visualization"],
            });
          } else {
            const symbols = prefetch.symbols?.length
              ? prefetch.symbols
              : prefetch.symbol
                ? [prefetch.symbol]
                : [];
            const screenerRawFiles =
              prefetch.rawFiles?.filter((file) =>
                file.includes("a-share-screener"),
              ) ?? [];
            const usedScreener = screenerRawFiles.length > 0;
            await publishQuantPipelineToolMessage({
              projectId: project_id,
              requestId,
              conversationId,
              cliSource: cliPreference,
              toolName: "quant-data-registry",
              toolCallId: dataRegistryToolCallId,
              target: usedScreener
                ? "/api/v1/research/screeners/a-share/short-term-candidates"
                : "/api/v1/symbols/resolve",
              summary: usedScreener
                ? symbols.length
                  ? `调用本地选股接口，得到候选标的：${symbols.join("、")}。`
                  : "调用本地选股接口并完成候选筛选。"
                : symbols.length
                  ? `解析用户问题中的标的并确认代码：${symbols.join("、")}。`
                  : "完成标的解析与本地数据能力检查。",
              input: {
                question: runPlan.question,
                templateId: runPlan.visualization?.templateId,
              },
              output: {
                symbols,
                rawFiles: usedScreener ? screenerRawFiles : prefetch.rawFiles,
              },
            });
            dataRegistryToolCallId = undefined;
            await publishQuantPipelineToolMessage({
              projectId: project_id,
              requestId,
              conversationId,
              cliSource: cliPreference,
              toolName: "quant-market-data",
              toolCallId: marketDataToolCallId,
              target: "data_file/final/dashboard-data.json",
              summary: prefetch.summary,
              input: {
                endpoints: [
                  "/api/v1/quotes/realtime",
                  "/api/v1/quotes/history/{symbol}",
                  "/api/v1/indicators/technical/{symbol}",
                  "/api/v1/fundamentals/financials/{symbol}",
                ],
                symbols,
              },
              output: {
                finalDataPath: prefetch.finalDataPath,
                rawFiles: prefetch.rawFiles,
              },
            });
            marketDataToolCallId = undefined;
            await publishWorkspaceProgress({
              stage: 3,
              runPlan,
              skillIds: ["dashboard-visualization"],
            });
            if (usePrefetchedSelectionDashboard) {
              dashboardVisualizationToolCallId =
                await publishQuantPipelineToolStart({
                  projectId: project_id,
                  requestId,
                  conversationId,
                  cliSource: cliPreference,
                  toolName: "dashboard-visualization",
                  target: "app/page.tsx",
                  summary: "正在基于本地选股数据生成标准选股工作区。",
                  input: {
                    templateId: "stock-selection",
                    variantId: runPlan.visualization?.variantId,
                    symbols,
                  },
                });
            }
            await ensureQuantDashboardTemplateForAct(projectPath);
            if (usePrefetchedSelectionDashboard) {
              await publishQuantPipelineToolMessage({
                projectId: project_id,
                requestId,
                conversationId,
                cliSource: cliPreference,
                toolName: "dashboard-visualization",
                toolCallId: dashboardVisualizationToolCallId,
                target: "app/page.tsx",
                summary:
                  "平台已基于本地选股数据生成标准选股看板，后续直接进入自动验证。",
                input: {
                  templateId: "stock-selection",
                  variantId: runPlan.visualization?.variantId,
                  symbols,
                },
                output: {
                  finalDataPath: prefetch.finalDataPath,
                  deterministicDashboard: true,
                },
              });
              dashboardVisualizationToolCallId = undefined;
            }
          }
          if (!prefetch.skipped) {
            streamManager.publish(project_id, {
              type: "status",
              data: {
                status: "quant_data_prefetched",
                message: prefetch.summary,
                requestId,
                metadata: {
                  symbol: prefetch.symbol,
                  finalDataPath: prefetch.finalDataPath,
                  rawFiles: prefetch.rawFiles,
                },
              },
            });
          }
        } catch (error) {
          if (queryRewriteQuotaReservationId) {
            await releaseQuotaReservation({
              reservationId: queryRewriteQuotaReservationId,
            }).catch((releaseError) => {
              console.error(
                "[Quota] Failed to release Query Rewrite reservation:",
                releaseError,
              );
            });
            queryRewriteQuotaReservationId = null;
          }
          console.error(
            "[API] Failed to prepare QuantPilot run plan or data prefetch:",
            error,
          );
          const preparationMessage =
            error instanceof Error ? error.message : String(error);
          const typedPreparationError =
            error instanceof QuantPreparationError ? error : null;
          const pendingToolFailures = [
            queryRewriteToolCallId
              ? {
                  toolName: "query-rewrite",
                  toolCallId: queryRewriteToolCallId,
                  target: ".data-agent/finance-query-rewrite.json",
                }
              : null,
            runPlannerToolCallId
              ? {
                  toolName: "run-planner",
                  toolCallId: runPlannerToolCallId,
                  target: ".data-agent/finance-run-plan.json",
                }
              : null,
            dataRegistryToolCallId
              ? {
                  toolName: "quant-data-registry",
                  toolCallId: dataRegistryToolCallId,
                  target: "本地数据覆盖与标的解析",
                }
              : null,
            marketDataToolCallId
              ? {
                  toolName: "quant-market-data",
                  toolCallId: marketDataToolCallId,
                  target: "data_file/final/dashboard-data.json",
                }
              : null,
            dashboardVisualizationToolCallId
              ? {
                  toolName: "dashboard-visualization",
                  toolCallId: dashboardVisualizationToolCallId,
                  target: "app/page.tsx",
                }
              : null,
          ].filter(
            (value): value is NonNullable<typeof value> => value !== null,
          );
          await Promise.all(
            pendingToolFailures.map((pending) =>
              publishQuantPipelineToolMessage({
                projectId: project_id,
                requestId,
                conversationId,
                cliSource: cliPreference,
                ...pending,
                summary: `本阶段未完成：${preparationMessage}`,
                success: false,
                resultStatus: "failed",
                output: { error: preparationMessage },
              }).catch((projectionError) => {
                console.error(
                  `[API] Failed to settle ${pending.toolName} projection:`,
                  projectionError,
                );
              }),
            ),
          );
          const missionProjectBusy =
            error instanceof MoAgentMissionStateError &&
            error.code === "MISSION_PROJECT_BUSY";
          if (missionContext) {
            await failMoAgentMission({
              missionId: missionContext.id,
              projectId: missionContext.projectId,
              requestId: missionContext.requestId,
              code: "MISSION_PREPARATION_FAILED",
              message: preparationMessage,
            });
          }
          await updateQuantGenerationStep({
            projectPath,
            projectId: project_id,
            requestId,
            stepId: "data_prefetch",
            status: "failed",
            summary: "生成计划或数据预取失败。",
            runStatus: "failed",
            errorMessage: preparationMessage,
          });
          await markUserRequestAsFailed(
            project_id,
            requestId,
            preparationMessage,
          );
          await publishWorkspaceProgress({
            stage: 5,
            failureReason: preparationMessage,
          });
          streamManager.publish(project_id, {
            type: "status",
            data: {
              status: "quant_data_preparation_failed",
              message: preparationMessage,
              requestId,
              metadata: {
                terminalFailure: true,
                errorCode: missionProjectBusy
                  ? "MISSION_PROJECT_BUSY"
                  : (typedPreparationError?.code ??
                    "QUANT_DATA_PREPARATION_FAILED"),
                retryable: typedPreparationError?.retryable ?? false,
                agentExecutionSkipped: true,
              },
            },
          });
          return NextResponse.json(
            {
              success: false,
              error: missionProjectBusy
                ? "MISSION_PROJECT_BUSY"
                : (typedPreparationError?.code ??
                  "QUANT_DATA_PREPARATION_FAILED"),
              message: preparationMessage,
              retryable: typedPreparationError?.retryable ?? false,
              requestId,
            },
            { status: missionProjectBusy ? 409 : 503 },
          );
        }
        return null;
      },
    });
    if (clarificationResponse) {
      return clarificationResponse;
    }
    const queuedMission = missionContext as MoAgentMissionContext | null;
    if (!queuedMission) {
      throw new Error("MoAgent Mission was not created after planning.");
    }
    acceptedMission = queuedMission;

    if (
      project.preferredCli !== cliPreference ||
      existingSelected !== selectedModel
    ) {
      try {
        await updateProject(project_id, {
          preferredCli: cliPreference,
          selectedModel,
        });
      } catch (error) {
        console.error(
          "[API] Failed to persist project CLI/model settings:",
          error,
        );
      }
    }

    const cliRuntime = await loadCliRuntime();

    const queuedGeneration = await startQuantGenerationQueued({
      projectPath,
      projectId: project_id,
      requestId,
      instruction: effectiveInstruction,
      cliPreference,
      selectedModel,
      executionEnvelope: {
        schemaVersion: 1,
        recoveryMode: "replan_required",
        effectiveInstruction,
        userVisibleInstructionForRepair,
        selectedModel,
        cliPreference,
        isInitialPrompt,
        conversationId: conversationId ?? null,
        actorUserId,
        processedImages,
        usePrefetchedSelectionDashboard,
        missionId: queuedMission.id,
        generationId: queuedMission.generationId,
        governedKnowledgeTaskCategory,
      },
      completeOnTaskSuccess: false,
      completeOnTaskFailure: false,
      task: async () => {
        await runValidationAfterExecution({
          execution: (async () => {
            await updateQuantGenerationStep({
              projectPath,
              projectId: project_id,
              requestId,
              stepId: "agent_execution",
              status: "running",
              summary: usePrefetchedSelectionDashboard
                ? "平台已完成选股数据预取和标准看板生成，跳过 Agent 生成。"
                : isInitialPrompt
                  ? "开始初始化并生成工作空间。"
                  : "开始让 Agent 修改工作空间。",
            });
            if (usePrefetchedSelectionDashboard) {
              streamManager.publish(project_id, {
                type: "status",
                data: {
                  status: "prefetched_selection_dashboard_ready",
                  message:
                    "已基于本地选股接口和数据库数据生成标准选股看板，正在进入自动验证。",
                  requestId,
                },
              });
              return capturePlatformMissionCandidate({
                mission: queuedMission,
                source: "platform_prefetch",
                sourceRequestId: requestId,
                summary: "平台已基于预取数据生成确定性选股看板候选。",
              });
            }
            const personalization = await exposePersonalization({
              projectId: project_id,
              actorUserId: actionContext.actorUserId,
              requestId,
              recall: memoryRecall,
            });
            const governedKnowledge = usePrefetchedSelectionDashboard
              ? null
              : (governedKnowledgePreparation?.capsule ?? null);
            await recordContextExposure({
              projectPath,
              projectId: project_id,
              requestId,
              integrationScope: projectIntegrationScope,
              memory: personalization,
              knowledge: governedKnowledge,
            });
            if (isInitialPrompt) {
              return cliRuntime.initializeNextJsProject(
                project_id,
                projectPath,
                effectiveInstruction,
                selectedModel,
                requestId,
                personalization,
                governedKnowledge,
              );
            }
            return cliRuntime.applyChanges(
              project_id,
              projectPath,
              effectiveInstruction,
              selectedModel,
              requestId,
              processedImages,
              personalization,
              governedKnowledge,
            );
          })(),
          repairExecutor: cliRuntime.applyRepairChanges,
          mission: queuedMission,
          projectId: project_id,
          projectPath,
          instruction: userVisibleInstructionForRepair,
          selectedModel,
          requestId,
          actorUserId,
          conversationId,
          cliSource: cliPreference,
          agentExecutionSuccessSummary: usePrefetchedSelectionDashboard
            ? "平台已完成本地选股、行情预取和标准看板生成，跳过 Agent 生成并进入自动验证。"
            : undefined,
          governedKnowledge: usePrefetchedSelectionDashboard
            ? null
            : (governedKnowledgePreparation?.capsule ?? null),
          governedKnowledgePreparation,
          governedKnowledgeTaskCategory,
          publishWorkspaceProgress,
          relatedAgentRequestIds,
        });
      },
    });
    concurrentQuotaHandedOff = true;
    void queuedGeneration.completion
      .catch((error) => {
        console.error("[API] Queued generation task failed:", error);
      })
      .finally(releaseConcurrentQuota);

    return NextResponse.json({
      success: true,
      message: "AI execution started",
      requestId,
      missionId: queuedMission.id,
      generationId: queuedMission.generationId,
      userMessageId: userMessage.id,
      conversationId: conversationId ?? null,
    });
  } catch (error) {
    console.error("[API] Failed to execute AI:", error);
    if (acceptedMission && !concurrentQuotaHandedOff) {
      await failMoAgentMission({
        missionId: acceptedMission.id,
        projectId: acceptedMission.projectId,
        requestId: acceptedMission.requestId,
        code: "GENERATION_DISPATCH_ACCEPTANCE_FAILED",
        message:
          error instanceof Error
            ? error.message
            : "Durable generation dispatch acceptance failed.",
      }).catch((missionError) => {
        console.error(
          "[API] Failed to close Mission after dispatch acceptance failure:",
          missionError,
        );
      });
    }
    if (claimedRequest) {
      await markUserRequestAsFailed(
        claimedRequest.projectId,
        claimedRequest.requestId,
        error instanceof Error ? error.message : "Request acceptance failed",
      ).catch((statusError) => {
        console.error(
          "[API] Failed to mark rejected request as failed:",
          statusError,
        );
      });
    }
    const quotaResponse = quotaErrorResponse(error);
    if (quotaResponse) return quotaResponse;
    if (error instanceof AuthorizationError) return authErrorResponse(error);
    if (error instanceof MoAgentGenerationLeaseError) {
      return NextResponse.json(
        {
          success: false,
          error: "Project generation is busy",
          code: error.code,
          message: error.message,
          activeRequestId: error.activeRequestId,
          activeStage: error.activeStage,
        },
        { status: 409 },
      );
    }
    return NextResponse.json(
      {
        success: false,
        error: "Failed to execute AI",
        message: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    );
  } finally {
    if (!concurrentQuotaHandedOff) await releaseConcurrentQuota();
  }
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
