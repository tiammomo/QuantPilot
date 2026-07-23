/**
 * AI Action API Route
 * POST /api/chat/[project_id]/act - Execute AI command
 */

import { NextRequest, NextResponse } from "next/server";
import {
  getProjectById,
  ensureProjectLlmConfiguration,
  lockProjectDataAgentComposition,
  updateProject,
  updateProjectActivity,
} from "@/lib/services/project";
import { createMessage } from "@/lib/services/message";
import {
  getDefaultModelForCli,
  normalizeModelId,
} from "@/lib/constants/models";
import { streamManager } from "@/lib/services/stream";
import { generateProjectId } from "@/lib/utils";
import fs from "fs/promises";
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
  markUserRequestAsFailed,
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
} from "@/lib/quota";
import { readQuantRunPlan } from "@/lib/domains/finance/workspace";
import { createWorkspaceProgressPublisher } from "@/lib/quant/workspace-progress";
import { shouldEscalateStalledRepair } from "@/lib/quant/repair-convergence";
import { buildClarificationContinuation } from "@/lib/domains/finance/intent";
import {
  incrementQuantGenerationRepairAttempt,
  readQuantGenerationState,
  updateQuantGenerationStep,
} from "@/lib/quant/generation-state";
import {
  finishQuantGenerationQueueItem,
  enqueueQuantGeneration,
  startQuantGenerationQueued,
} from "@/lib/quant/generation-queue";
import { validateMoAgentIngressInput } from "@/lib/agent/input-policy";
import { classifyMoAgentExecutionError } from "@/lib/services/moagent-execution-error";
import { MoAgentGenerationLeaseError } from "@/lib/services/moagent-generation-lease-store";
import { refreshMoAgentCandidateWorkspace } from "@/lib/services/moagent-candidate";
import type { MoAgentCandidateSubmission } from "@/lib/agent/mission";
import {
  claimQuantMoAgentMissionVerification,
  refreshMoAgentMissionContext,
  sealQuantMoAgentMissionCandidate,
  verifyAndRecordQuantMoAgentMission,
  type MoAgentMissionContext,
} from "@/lib/services/moagent-mission-control";
import {
  cancelMoAgentMission,
  failMoAgentMission,
  markMoAgentMissionRepairing,
  readMoAgentAcceptedMissionSnapshot,
} from "@/lib/services/moagent-mission-store";
import {
  startPersistentValidatedPreview,
  type ValidatedGenerationPreview,
} from "@/lib/quant/generation-preview";
import { recallPersonalization } from "@/lib/platform/memory";
import { detectPersonalMemoryCandidate } from "@/lib/platform/memory/candidate";
import {
  persistAcceptedGovernedKnowledgeUse,
  recordGovernedKnowledgeUsage,
} from "@/lib/platform/knowledge";
import { recordContextAcceptance } from "@/lib/platform/context/use-manifest";
import { createFinanceGenerationEnvelope } from "@/lib/quant/finance-generation-executor";
import { createApplicationGenerationRuntime } from "@/lib/quant/generation-runtime";
import { prepareFinanceActGeneration } from "@/lib/quant/finance-act-preparation";
import {
  loadQuantValidation,
  resolveProjectRoot,
} from "@/lib/quant/chat-act-support";

interface RouteContext {
  params: Promise<{ project_id: string }>;
}

/**
 * POST /api/chat/[project_id]/act
 * Execute AI command
 */
export async function POST(request: NextRequest, { params }: RouteContext) {
  let claimedRequest: { projectId: string; requestId: string } | null = null;
  let acceptedMission: MoAgentMissionContext | null = null;
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
    const maxRequestBytes = MAX_DATA_AGENT_TOTAL_IMAGE_BYTES + 2 * 1024 * 1024;
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
        {
          success: false,
          error: "INVALID_JSON",
          message: "Request body must be valid JSON.",
        },
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

    const projectRoot = resolveProjectRoot(project_id, project.repoPath);
    const projectPath = projectRoot;
    const normalizedInstruction = rawInstruction.trim();
    const normalizedVisibleInstruction = (
      rawDisplayInstruction ?? rawInstruction
    ).trim();

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
    const finalInstruction = [
      normalizedInstruction ||
        (processedImages.length > 0 ? "请分析用户上传的图片附件。" : ""),
      imageAttachmentInstruction,
    ]
      .filter((segment) => segment && segment.trim().length > 0)
      .join("\n\n")
      .trim();
    const displayInstruction =
      normalizedVisibleInstruction ||
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
      body.selectedModel ??
      project.selectedModel ??
      getDefaultModelForCli(cliPreference);
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
      agentProfileId: project.agentProfileId,
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
        normalizedInstruction ||
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
        : normalizedInstruction || effectiveInstruction;
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
    const preparation = await prepareFinanceActGeneration({
      projectId: project_id,
      projectPath,
      requestId,
      finalInstruction,
      effectiveInstruction,
      effectiveDisplayInstruction,
      isInitialPrompt,
      cliPreference,
      selectedModel,
      conversationId: conversationId ?? null,
      quantCapabilityId,
      quantCapabilitySource,
      processedImageCount: processedImages.length,
      previousRunPlan,
      quotaActorUserId: actorUserId,
      userMessageId: userMessage.id,
      relatedAgentRequestIds,
      publishWorkspaceProgress,
    });
    if (preparation.response) {
      return preparation.response;
    }
    const {
      missionContext,
      usePrefetchedSelectionDashboard,
      governedKnowledgePreparation,
      governedKnowledgeTaskCategory,
    } = preparation;
    const queuedMission = missionContext as MoAgentMissionContext | null;
    if (!queuedMission) {
      throw new Error("MoAgent Mission was not created after planning.");
    }
    if (!governedKnowledgePreparation) {
      throw new Error(
        "Governed knowledge preparation was not persisted after planning.",
      );
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

    const plannedRunPlan = await readQuantRunPlan(projectPath);
    if (!plannedRunPlan?.capabilityId) {
      throw new Error("A planned Data Agent capability is required before dispatch.");
    }
    await lockProjectDataAgentComposition({
      projectId: project_id,
      projectPath,
      composition: plannedRunPlan.composition,
    });
    const executionEnvelope = createFinanceGenerationEnvelope({
      effectiveInstruction,
      userVisibleInstructionForRepair,
      selectedModel,
      cliPreference,
      isInitialPrompt,
      conversationId: conversationId ?? null,
      actorUserId,
      memorySubjectId: actionContext.actorUserId,
      processedImages,
      usePrefetchedSelectionDashboard,
      missionId: queuedMission.id,
      generationId: queuedMission.generationId,
      governedKnowledgeTaskCategory,
      personalizationRecall: memoryRecall,
      governedKnowledgePreparation,
    }, {
      projectId: project_id,
      requestId,
      capabilityId: plannedRunPlan.capabilityId,
    });

    if (process.env.MOAGENT_DISPATCH_MODE === "worker") {
      await enqueueQuantGeneration({
        projectPath,
        projectId: project_id,
        requestId,
        instruction: effectiveInstruction,
        cliPreference,
        selectedModel,
        executionEnvelope,
        maxAttempts: 3,
      });
      return NextResponse.json({
        success: true,
        message: "AI execution queued",
        requestId,
        missionId: queuedMission.id,
        generationId: queuedMission.generationId,
        userMessageId: userMessage.id,
        conversationId: conversationId ?? null,
      });
    }

    const queuedGeneration = await startQuantGenerationQueued({
      projectPath,
      projectId: project_id,
      requestId,
      instruction: effectiveInstruction,
      cliPreference,
      selectedModel,
      executionEnvelope,
      completeOnTaskSuccess: false,
      completeOnTaskFailure: false,
      task: () =>
        createApplicationGenerationRuntime().execute({
          jobId: `inline:${requestId}`,
          projectId: project_id,
          requestId,
          selectedModel,
          cliPreference,
          executionEnvelope,
        }),
    });
    void queuedGeneration.completion.catch((error) => {
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
    if (acceptedMission) {
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
  }
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
