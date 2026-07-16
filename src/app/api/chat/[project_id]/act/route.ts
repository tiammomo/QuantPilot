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
} from "@/lib/constants/cliModels";
import { streamManager } from "@/lib/services/stream";
import type { ChatActRequest } from "@/types/backend";
import { generateProjectId } from "@/lib/utils";
import path from "path";
import fs from "fs/promises";
import { randomUUID } from "crypto";
import {
  configuredMaxImageBytes,
  decodeBase64Image,
  ImageAssetError,
  resolveExistingProjectAssetPath,
  resolveProjectAssetPath,
  resolveProjectAssetsPath,
  validateImageBytes,
} from "@/lib/server/image-assets";
import { serializeMessage } from "@/lib/serializers/chat";
import {
  assertUserRequestProjectBinding,
  upsertUserRequest,
  markUserRequestAsProcessing,
  markUserRequestAsCompleted,
  markUserRequestAsFailed,
  isUserRequestCancelled,
  UserRequestProjectMismatchError,
} from "@/lib/services/user-requests";
import { readQuantRunPlan, writeInitialRunPlan } from "@/lib/quant/workspace";
import { prefetchQuantDataForRunPlan } from "@/lib/quant/data-prefetch";
import { getQuantCapability } from "@/lib/quant/capabilities";
import {
  createWorkspaceProgressPublisher,
  type WorkspaceProgressPublisher,
} from "@/lib/quant/workspace-progress";
import { shouldEscalateStalledRepair } from "@/lib/quant/repair-convergence";
import {
  buildClarificationContinuation,
  buildQuantClarificationMessage,
} from "@/lib/quant/intent";
import {
  incrementQuantGenerationRepairAttempt,
  readQuantGenerationState,
  startQuantGenerationRun,
  updateQuantGenerationStep,
} from "@/lib/quant/generation-state";
import {
  finishQuantGenerationQueueItem,
  runQuantGenerationQueued,
  runQuantGenerationStageLocked,
} from "@/lib/quant/generation-queue";
import { validateMoAgentIngressInput } from "@/lib/agent/input-policy";
import { classifyMoAgentExecutionError } from "@/lib/services/moagent-execution-error";
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

interface RouteContext {
  params: Promise<{ project_id: string }>;
}

class QuantPreparationError extends Error {
  constructor(
    readonly code: 'SYMBOL_RESOLVER_UNAVAILABLE' | 'QUANT_ARTIFACT_PREPARATION_FAILED',
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'QuantPreparationError';
  }
}

type CliRuntime = {
  initializeNextJsProject: (
    projectId: string,
    projectPath: string,
    instruction: string,
    model?: string,
    requestId?: string,
  ) => Promise<MoAgentCandidateSubmission>;
  applyChanges: (
    projectId: string,
    projectPath: string,
    instruction: string,
    model?: string,
    requestId?: string,
    images?: ProcessedImageAttachment[],
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

async function missingAgentInputArtifacts(projectPath: string): Promise<string[]> {
  const checks = await Promise.all(REQUIRED_AGENT_INPUT_ARTIFACTS.map(async (relativePath) => {
    try {
      const stat = await fs.stat(path.join(projectPath, relativePath));
      return stat.isFile() && stat.size > 2 ? null : relativePath;
    } catch {
      return relativePath;
    }
  }));
  return checks.flatMap((value) => value === null ? [] : [value]);
}

function coerceString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

const PROJECTS_DIR = process.env.PROJECTS_DIR || "./data/projects";
const PROJECTS_DIR_ABSOLUTE = path.isAbsolute(PROJECTS_DIR)
  ? PROJECTS_DIR
  : path.resolve(/*turbopackIgnore: true*/ process.cwd(), PROJECTS_DIR);

function resolveProjectRoot(
  projectId: string,
  repoPath?: string | null,
): string {
  if (repoPath) {
    return path.isAbsolute(repoPath)
      ? repoPath
      : path.resolve(/*turbopackIgnore: true*/ process.cwd(), repoPath);
  }
  return path.join(PROJECTS_DIR_ABSOLUTE, projectId);
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
    /全A|A股股票池|股票池|选股|筛选|候选|短线候选|次日|明日|明天|今日|今天|要买|买股|买入策略|短线|推荐\d*(?:只|个)?(?:股票|个股)|(?:股票|个股).{0,12}推荐|推荐.{0,18}(?:股票|个股)/.test(normalized)
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
    ...(params.target ? { target: params.target, filePath: params.target } : {}),
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
  const resultStatus = params.resultStatus ?? (success ? "completed" : "failed");
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
  conversationId?: string | null;
  cliSource?: string | null;
  agentExecutionSuccessSummary?: string;
  publishWorkspaceProgress: WorkspaceProgressPublisher;
  relatedAgentRequestIds: Set<string>;
}): Promise<void> {
  let activeRepairRequestId: string | null = null;
  let activeMission = params.mission;

  const cancelMission = async (message: string) => {
    activeMission = {
      ...(await cancelMoAgentMission({
        missionId: activeMission.id,
        projectId: activeMission.projectId,
        requestId: activeMission.requestId,
        message,
      })),
      projectPath: activeMission.projectPath,
    };
  };
  const failMission = async (code: string, message: string) => {
    activeMission = {
      ...(await failMoAgentMission({
        missionId: activeMission.id,
        projectId: activeMission.projectId,
        requestId: activeMission.requestId,
        code,
        message,
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
    const verified = await verifyAndRecordQuantMoAgentMission({
      mission: activeMission,
      preview: preview
        ? { url: preview.url, port: preview.port }
        : { url: "http://127.0.0.1:1", port: 1 },
    });
    activeMission = verified.mission;
    await updateQuantGenerationStep({
      projectPath: params.projectPath,
      projectId: params.projectId,
      requestId: params.requestId,
      stepId: "evidence_verification",
      status: verified.decision.verdict === "accepted" ? "success" : "failed",
      summary: verified.decision.verdict === "accepted"
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
    const executionFailureMessage = classifiedExecutionError?.message ??
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
        ? classifiedExecutionError && !classifiedExecutionError.repairableByValidation
          ? `Agent 执行失败：${executionFailureMessage}`
          : "Agent 执行异常结束，进入验证确认产物状态。"
        : params.agentExecutionSuccessSummary ??
          "Agent 执行完成，进入自动验证。",
      ...(executionError
        ? {
            errorMessage: executionFailureMessage,
            ...(classifiedExecutionError
              ? { metadata: { errorCode: classifiedExecutionError.code } }
              : {}),
          }
        : {}),
    });

    if (classifiedExecutionError && !classifiedExecutionError.repairableByValidation) {
      await failMission(
        classifiedExecutionError.code,
        executionFailureMessage,
      );
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
      await sealCandidate(await refreshMoAgentCandidateWorkspace({
        workspaceRoot: params.projectPath,
        candidate,
      }));
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
      const failedCheckIdsBeforeRepair = latestFailedChecks.map((check) => check.id);
      await beginRepair();
      const platformRepair = await quantValidation.repairQuantPlatformOwnedArtifacts({
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
      const repairInstruction = quantValidation.buildQuantValidationRepairInstruction(
        latestReport,
        {
          originalInstruction: params.instruction,
        },
      );

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
        await markUserRequestAsFailed(params.projectId, repairRequestId, message);
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
        await sealCandidate(await refreshMoAgentCandidateWorkspace({
          workspaceRoot: params.projectPath,
          candidate: repairCandidate,
        }));
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
      const earlyTemplateRecovery = stalledRepair &&
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
        await quantValidation.restoreQuantDashboardTemplateAfterRepairExhaustion({
          projectPath: params.projectPath,
          report: latestReport,
        });
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
        "自动修复后仍未通过平台验证，请查看 .quantpilot/validation.json 和 .quantpilot/validation-repair-plan.json。",
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
      const previewFailure = validationError instanceof ValidatedPreviewStartError;
      if (await recoverCommittedAcceptanceProjection().catch((error) => {
        console.error("[API] Failed to inspect committed Mission acceptance:", error);
        return false;
      })) {
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
        await markUserRequestAsFailed(params.projectId, activeRepairRequestId, message);
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
    }
  })();
}

const MAX_IMAGE_ATTACHMENTS = 8;
const MAX_IMAGE_BYTES = configuredMaxImageBytes();
const MAX_TOTAL_IMAGE_BYTES = Math.min(25 * 1024 * 1024, MAX_IMAGE_ATTACHMENTS * MAX_IMAGE_BYTES);

function isPathInside(basePath: string, candidatePath: string): boolean {
  const relative = path.relative(basePath, candidatePath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function mirrorAssetToProjectPublic(
  projectRoot: string,
  filename: string,
  sourcePath: string,
): Promise<string> {
  const [canonicalProjectRoot, canonicalAssetsRoot] = await Promise.all([
    fs.realpath(projectRoot),
    fs.realpath(path.dirname(sourcePath)),
  ]);
  if (!isPathInside(canonicalProjectRoot, canonicalAssetsRoot)) {
    throw new ImageAssetError("Project attachment storage is outside the project workspace");
  }
  const uploadsDir = path.join(canonicalProjectRoot, "public", "uploads");
  await fs.mkdir(uploadsDir, { recursive: true });
  const destinationPath = path.join(uploadsDir, filename);
  await fs.copyFile(sourcePath, destinationPath);
  return `/uploads/${filename}`;
}

async function materializeBase64Image(
  projectId: string,
  projectRoot: string,
  base64: string,
  nameHint?: string,
  mimeType?: string,
): Promise<{
  path: string;
  filename: string;
  publicUrl: string;
  mimeType: string;
  size: number;
}> {
  const buffer = decodeBase64Image(base64, { maxBytes: MAX_IMAGE_BYTES });
  const detected = validateImageBytes(buffer, {
    ...(mimeType ? { declaredMimeType: mimeType } : {}),
    maxBytes: MAX_IMAGE_BYTES,
  });
  const safeName =
    nameHint && nameHint.trim() ? nameHint.trim() : `image-${randomUUID()}`;
  const filename = `${safeName.slice(0, 80).replace(/[^a-zA-Z0-9-_]/g, "-") || "image"}-${randomUUID()}${detected.extension}`;
  const assetsDir = resolveProjectAssetsPath(projectId);
  await fs.mkdir(assetsDir, { recursive: true });
  const absolutePath = resolveProjectAssetPath(projectId, filename);
  await fs.writeFile(absolutePath, buffer, { flag: "wx" });
  const publicUrl = await mirrorAssetToProjectPublic(projectRoot, filename, absolutePath);
  return {
    path: `assets/${filename}`,
    filename,
    publicUrl,
    mimeType: detected.mimeType,
    size: buffer.byteLength,
  };
}

type RawImageAttachment = Record<string, unknown>;

type ProcessedImageAttachment = {
  name: string;
  path: string;
  url: string;
  publicUrl?: string;
  originalName?: string;
  mimeType?: string;
  size?: number;
};

async function normalizeImageAttachment(
  projectId: string,
  projectRoot: string,
  raw: RawImageAttachment,
  index: number,
): Promise<ProcessedImageAttachment> {
  const name =
    typeof raw.name === "string" && raw.name.trim().length > 0
      ? raw.name.trim().slice(0, 256)
      : `Image ${index + 1}`;

  const pathValue =
    typeof raw.path === "string" && raw.path.trim().length > 0
      ? raw.path.trim()
      : null;

  const base64DataCandidate =
    typeof raw.base64_data === "string"
      ? raw.base64_data
      : typeof raw.base64Data === "string"
        ? raw.base64Data
        : null;

  const mimeTypeCandidate =
    typeof raw.mime_type === "string"
      ? raw.mime_type
      : typeof raw.mimeType === "string"
        ? raw.mimeType
        : undefined;

  if (pathValue) {
    const asset = await resolveExistingProjectAssetPath(projectId, pathValue);
    if (asset.size > MAX_IMAGE_BYTES) {
      throw new ImageAssetError(
        `Image must be smaller than ${Math.floor(MAX_IMAGE_BYTES / 1024 / 1024)}MB`,
        413,
      );
    }
    const bytes = await fs.readFile(asset.absolutePath);
    const detected = validateImageBytes(bytes, {
      ...(mimeTypeCandidate ? { declaredMimeType: mimeTypeCandidate } : {}),
      maxBytes: MAX_IMAGE_BYTES,
    });
    const publicUrl = await mirrorAssetToProjectPublic(
      projectRoot,
      asset.filename,
      asset.absolutePath,
    );
    return {
      name,
      path: asset.relativePath,
      url: `/api/assets/${projectId}/${asset.filename}`,
      publicUrl,
      originalName:
        typeof raw.original_name === "string" ? raw.original_name.slice(0, 256) : undefined,
      mimeType: detected.mimeType,
      size: bytes.byteLength,
    };
  }

  if (base64DataCandidate) {
    const materialized = await materializeBase64Image(
      projectId,
      projectRoot,
      base64DataCandidate,
      name,
      mimeTypeCandidate,
    );
    return {
      name,
      path: materialized.path,
      url: `/api/assets/${projectId}/${materialized.filename}`,
      publicUrl: materialized.publicUrl,
      mimeType: materialized.mimeType,
      size: materialized.size,
    };
  }

  throw new ImageAssetError("Each image attachment must reference an uploaded project asset");
}

async function writeAttachmentContext(params: {
  projectRoot: string;
  projectId: string;
  requestId: string;
  images: ProcessedImageAttachment[];
}): Promise<string | null> {
  if (params.images.length === 0) {
    return null;
  }

  const quantDir = path.join(params.projectRoot, ".quantpilot");
  const relativePath = ".quantpilot/attachments.json";
  const absolutePath = path.join(params.projectRoot, relativePath);
  const payload = {
    schemaVersion: 1,
    projectId: params.projectId,
    requestId: params.requestId,
    createdAt: new Date().toISOString(),
    instruction:
      "这些图片由用户随本次问题上传。Agent 必须先读取本文件并检查图片，再解析其中的股票、持仓、成本、现金、盈亏、仓位等字段。",
    attachments: params.images.map((image, index) => ({
      id: `image-${index + 1}`,
      name: image.name,
      path: image.path,
      url: image.url,
      publicUrl: image.publicUrl ?? null,
      mimeType: image.mimeType ?? null,
      size: image.size ?? null,
    })),
    extractionContract: {
      requiredSkill: "image-extraction",
      requiredTool: "quant_extract_uploaded_image",
      portfolioScreenshotFields: [
        "account_total_asset",
        "cash_available",
        "market_value",
        "daily_pnl",
        "total_pnl",
        "position_ratio",
        "holdings[].name",
        "holdings[].symbol_if_visible_or_resolved",
        "holdings[].quantity",
        "holdings[].cost_price",
        "holdings[].current_price",
        "holdings[].market_value",
        "holdings[].pnl",
        "holdings[].pnl_percent",
      ],
      rule: "无法确定的截图字段必须写 null，并在 evidence/data_quality.json 说明不确定性，不允许编造。",
    },
  };

  await fs.mkdir(quantDir, { recursive: true });
  await fs.writeFile(
    absolutePath,
    `${JSON.stringify(payload, null, 2)}\n`,
    "utf8",
  );
  return relativePath;
}

function buildImageAttachmentInstruction(params: {
  attachmentContextPath: string | null;
  images: ProcessedImageAttachment[];
}): string {
  if (params.images.length === 0) {
    return "";
  }

  const imageList = params.images
    .map((image, index) => {
      return `${index + 1}. ${image.name}：${image.path}`;
    })
    .join("\n");

  return `

图片附件处理要求：
- 本次用户上传了 ${params.images.length} 张图片。先读取 ${params.attachmentContextPath ?? ".quantpilot/attachments.json"}，再检查图片内容，不要忽略附件。
- 先使用 \`image-extraction\` skill，并调用原生工具 \`quant_extract_uploaded_image\` 读取附件清单、校验图片文件、生成 imageExtraction 初始结构。不要只说“我看不到图片”。
- 当前不接入额外视觉模型或第三方 OCR；无法可靠识别的截图字段必须写 null，并在证据文件中列出需要用户确认的内容。
- 对识别出的股票名称必须使用 quant-symbol-resolver 或 /api/v1/symbols/resolve 解析代码，再获取真实行情、K 线、指标和必要的基本面数据。
- 必须把图片提取结果写入 evidence/image_extraction.json；没有 OCR/视觉结果时也要写明 visualRecognition.status 和 needs_manual_confirmation。
- 最终 dashboard-data.json 必须保留 portfolio、holdings、assets、comparison 和 imageExtraction 字段；imageExtraction 要说明哪些字段来自截图识别、哪些来自行情接口补全。
- 如果当前运行时无法直接识别图片视觉内容，也必须基于附件清单和文件路径继续处理，并明确列出需要人工确认的截图字段。

图片路径：
${imageList}`;
}

/**
 * POST /api/chat/[project_id]/act
 * Execute AI command
 */
export async function POST(request: NextRequest, { params }: RouteContext) {
  try {
    const { project_id } = await params;
    const contentLength = Number(request.headers.get("content-length"));
    const maxRequestBytes = Math.ceil((MAX_TOTAL_IMAGE_BYTES * 4) / 3) + 2 * 1024 * 1024;
    if (Number.isFinite(contentLength) && contentLength > maxRequestBytes) {
      return NextResponse.json(
        { success: false, error: "Request attachments are too large" },
        { status: 413 },
      );
    }
    const rawBody = await request.json().catch(() => ({}));
    const body = (
      rawBody && typeof rawBody === "object" ? rawBody : {}
    ) as ChatActRequest & Record<string, unknown>;
    const legacyBody = body as Record<string, unknown>;
    const rawInstruction =
      typeof body.instruction === "string" ? body.instruction : "";
    const rawDisplayInstruction =
      coerceString((body as Record<string, unknown>).displayInstruction) ??
      coerceString(legacyBody["display_instruction"]);
    const requestId =
      coerceString(body.requestId) ??
      coerceString(legacyBody["request_id"]) ??
      generateProjectId();
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

    const project = await getProjectById(project_id);
    if (!project) {
      return NextResponse.json(
        { success: false, error: "Project not found" },
        { status: 404 },
      );
    }

    try {
      await assertUserRequestProjectBinding(project_id, requestId);
    } catch (error) {
      if (error instanceof UserRequestProjectMismatchError) {
        return NextResponse.json(
          { success: false, error: "Request ID belongs to a different project" },
          { status: 409 },
        );
      }
      throw error;
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

    const conversationId =
      coerceString(body.conversationId) ??
      coerceString(legacyBody["conversation_id"]);

    const rawImages: RawImageAttachment[] = Array.isArray(
      (body as Record<string, unknown>).images,
    )
      ? ((body as Record<string, unknown>).images as RawImageAttachment[])
      : Array.isArray(legacyBody["images"])
        ? (legacyBody["images"] as RawImageAttachment[])
        : [];

    if (rawImages.length > MAX_IMAGE_ATTACHMENTS) {
      return NextResponse.json(
        {
          success: false,
          error: `At most ${MAX_IMAGE_ATTACHMENTS} image attachments are allowed`,
        },
        { status: 413 },
      );
    }

    const processedImages: ProcessedImageAttachment[] = [];
    let totalImageBytes = 0;
    try {
      for (let index = 0; index < rawImages.length; index += 1) {
        const normalized = await normalizeImageAttachment(
          project_id,
          projectRoot,
          rawImages[index],
          index,
        );
        totalImageBytes += normalized.size ?? 0;
        if (totalImageBytes > MAX_TOTAL_IMAGE_BYTES) {
          throw new ImageAssetError(
            `Image attachments exceed the ${Math.floor(MAX_TOTAL_IMAGE_BYTES / 1024 / 1024)}MB total limit`,
            413,
          );
        }
        processedImages.push(normalized);
      }
    } catch (error) {
      if (error instanceof ImageAssetError) {
        return NextResponse.json(
          { success: false, error: error.message },
          { status: error.status },
        );
      }
      throw error;
    }

    const attachmentContextPath = await writeAttachmentContext({
      projectRoot,
      projectId: project_id,
      requestId,
      images: processedImages,
    });
    const imageAttachmentInstruction = buildImageAttachmentInstruction({
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
      return NextResponse.json(
        { success: false, error: "instruction or images are required" },
        { status: 400 },
      );
    }

    const cliPreference = "moagent";

    const selectedModelRaw =
      coerceString(body.selectedModel) ??
      coerceString(legacyBody["selected_model"]) ??
      project.selectedModel ??
      getDefaultModelForCli(cliPreference);
    const selectedModel = normalizeModelId(cliPreference, selectedModelRaw);

    const quantCapabilityId =
      coerceString((body as Record<string, unknown>).quantCapabilityId) ??
      coerceString(legacyBody["quant_capability_id"]) ??
      coerceString((body as Record<string, unknown>).capabilityId) ??
      coerceString(legacyBody["capability_id"]);
    const quantCapabilitySource =
      coerceString((body as Record<string, unknown>).quantCapabilitySource) ??
      coerceString(legacyBody["quant_capability_source"]) ??
      coerceString((body as Record<string, unknown>).capabilitySource) ??
      coerceString(legacyBody["capability_source"]);

    await ensureProjectLlmConfiguration({
      projectId: project_id,
      projectName: project.name,
      projectPath,
      preferredCli: project.preferredCli,
      selectedModel,
      settings: project.settings,
    });

    const previousRunPlan = await readQuantRunPlan(projectPath);
    const clarificationContinuation = buildClarificationContinuation({
      previousPlan: previousRunPlan,
      instruction: finalInstruction,
      displayInstruction,
      capabilityId: quantCapabilityId,
    });
    const effectiveInstruction = clarificationContinuation
      ? `${clarificationContinuation.resolvedInstruction}${imageAttachmentInstruction}`
      : finalInstruction;
    const effectiveDisplayInstruction =
      clarificationContinuation?.displayInstruction ?? displayInstruction;
    const userVisibleInstructionForRepair =
      effectiveDisplayInstruction && effectiveDisplayInstruction.trim().length > 0
        ? effectiveDisplayInstruction.trim()
        : finalInstruction;

    const isInitialPrompt =
      body.isInitialPrompt === true ||
      legacyBody["is_initial_prompt"] === true ||
      legacyBody["is_initial_prompt"] === "true";

    const metadata =
      processedImages.length > 0 || clarificationContinuation
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
          }
        : undefined;

    const storedInstruction =
      effectiveDisplayInstruction && effectiveDisplayInstruction.trim().length > 0
        ? effectiveDisplayInstruction.trim()
        : instructionWithoutLegacyPaths || effectiveInstruction;
    try {
      await upsertUserRequest({
        id: requestId,
        projectId: project_id,
        instruction: storedInstruction || effectiveInstruction,
        cliPreference,
      });
      const processing = await markUserRequestAsProcessing(project_id, requestId);
      if (!processing) {
        return NextResponse.json(
          { success: false, error: "Request is no longer active for this project" },
          { status: 409 },
        );
      }
    } catch (error) {
      if (error instanceof UserRequestProjectMismatchError) {
        return NextResponse.json(
          { success: false, error: "Request ID belongs to a different project" },
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

    const clarificationResponse = await runQuantGenerationStageLocked({
      projectId: project_id,
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
        effectiveDisplayInstruction && effectiveDisplayInstruction.trim().length > 0
          ? effectiveDisplayInstruction.trim()
          : effectiveInstruction;
      queryRewriteToolCallId = await publishQuantPipelineToolStart({
        projectId: project_id,
        requestId,
        conversationId,
        cliSource: cliPreference,
        toolName: "query-rewrite",
        target: ".quantpilot/query_rewrite.json",
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
        target: ".quantpilot/run_plan.json",
        summary: "正在核对分析对象、时间范围、数据需求和验收规则。",
        input: {
          question: planningInstruction,
          requestedCapabilityId: quantCapabilityId,
        },
      });
      const runPlan = await writeInitialRunPlan({
        projectPath,
        instruction: planningInstruction,
        requestId,
        capabilityId: quantCapabilityId,
        capabilitySource: quantCapabilitySource,
        hasImageAttachments: processedImages.length > 0,
        previousPlan: previousRunPlan,
        enableLlmRewrite: true,
        llmModel: selectedModel,
      });

      await publishQuantPipelineToolMessage({
        projectId: project_id,
        requestId,
        conversationId,
        cliSource: cliPreference,
        toolName: "query-rewrite",
        toolCallId: queryRewriteToolCallId,
        target: ".quantpilot/query_rewrite.json",
        summary: runPlan.queryRewrite?.status === "refused"
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
        target: ".quantpilot/run_plan.json",
        summary: runPlan.status === "refused"
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
            runPlanPath: ".quantpilot/run_plan.json",
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
          console.error('[API] Failed to collect clarification turn metrics:', error);
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
            runPlanPath: ".quantpilot/run_plan.json",
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
        skillIds: Array.from(new Set([
          "quant-data-registry",
          ...getQuantCapability(
            runPlan.requestedCapabilityId ?? runPlan.capabilityId,
          ).requiredSkills.filter((skillId) =>
            skillId !== "run-planner" &&
            skillId !== "dashboard-visualization" &&
            (skillId !== "image-extraction" || processedImages.length > 0)
          ),
        ])),
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
      const missingPreparedArtifacts = await missingAgentInputArtifacts(projectPath);
      if (
        processedImages.length === 0 &&
        (missingPreparedArtifacts.length > 0 || (isInitialPrompt && prefetch.skipped))
      ) {
        const resolverUnavailable = runPlan.queryRewrite?.issues.find(
          (issue) => issue.code === 'SYMBOL_RESOLVER_UNAVAILABLE',
        );
        if (resolverUnavailable) {
          throw new QuantPreparationError(
            'SYMBOL_RESOLVER_UNAVAILABLE',
            `证券标的解析服务暂不可用，平台已停止后续取数：${resolverUnavailable.message}`,
            true,
          );
        }
        throw new QuantPreparationError(
          'QUANT_ARTIFACT_PREPARATION_FAILED',
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
          finalDataPath: prefetch.skipped ? undefined : prefetch.finalDataPath,
          rawFiles: prefetch.skipped ? undefined : prefetch.rawFiles,
          deterministicDashboard: usePrefetchedSelectionDashboard || undefined,
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
          prefetch.rawFiles?.filter((file) => file.includes("a-share-screener")) ??
          [];
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
          dashboardVisualizationToolCallId = await publishQuantPipelineToolStart({
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
      console.error(
        "[API] Failed to prepare QuantPilot run plan or data prefetch:",
        error,
      );
          const preparationMessage = error instanceof Error
            ? error.message
            : String(error);
          const typedPreparationError = error instanceof QuantPreparationError
            ? error
            : null;
          const pendingToolFailures = [
            queryRewriteToolCallId
              ? {
                  toolName: "query-rewrite",
                  toolCallId: queryRewriteToolCallId,
                  target: ".quantpilot/query_rewrite.json",
                }
              : null,
            runPlannerToolCallId
              ? {
                  toolName: "run-planner",
                  toolCallId: runPlannerToolCallId,
                  target: ".quantpilot/run_plan.json",
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
          ].filter((value): value is NonNullable<typeof value> => value !== null);
          await Promise.all(pendingToolFailures.map((pending) =>
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
            })
          ));
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
          await markUserRequestAsFailed(project_id, requestId, preparationMessage);
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
                  : typedPreparationError?.code ?? "QUANT_DATA_PREPARATION_FAILED",
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
                : typedPreparationError?.code ?? "QUANT_DATA_PREPARATION_FAILED",
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

    void runQuantGenerationQueued({
      projectPath,
      projectId: project_id,
      requestId,
      instruction: effectiveInstruction,
      cliPreference,
      selectedModel,
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
            if (isInitialPrompt) {
              return cliRuntime.initializeNextJsProject(
                project_id,
                projectPath,
                effectiveInstruction,
                selectedModel,
                requestId,
              );
            }
            return cliRuntime.applyChanges(
              project_id,
              projectPath,
              effectiveInstruction,
              selectedModel,
              requestId,
              processedImages,
            );
          })(),
          repairExecutor: cliRuntime.applyRepairChanges,
          mission: queuedMission,
          projectId: project_id,
          projectPath,
          instruction: userVisibleInstructionForRepair,
          selectedModel,
          requestId,
          conversationId,
          cliSource: cliPreference,
          agentExecutionSuccessSummary: usePrefetchedSelectionDashboard
            ? "平台已完成本地选股、行情预取和标准看板生成，跳过 Agent 生成并进入自动验证。"
            : undefined,
          publishWorkspaceProgress,
          relatedAgentRequestIds,
        });
      },
    }).catch((error) => {
      console.error("[API] Queued generation task failed:", error);
    });

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
    return NextResponse.json(
      {
        success: false,
        error: "Failed to execute AI",
        message: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    );
  }
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
