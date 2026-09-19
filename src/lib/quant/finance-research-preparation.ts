import type {
  DataAgentGenerationEnvelope,
  DataAgentGenerationJobInput,
} from "@/lib/data-agent";
import { assertManagedWorkspaceExists } from "@/lib/data-agent";
import {
  getProjectById,
  ensureProjectLlmConfiguration,
  lockProjectDataAgentComposition,
  updateProject,
} from "@/lib/services/project";
import {
  isUserRequestCancelled,
  markUserRequestAsProcessing,
  markUserRequestAsFailed,
} from "@/lib/services/user-requests";
import { currentPiAgentGenerationDispatchFence } from "@/lib/services/pi-agent-generation-dispatch-session";
import {
  readClaimedPiAgentGenerationJob,
  checkpointPiAgentGenerationPreparation,
} from "@/lib/services/pi-agent-generation-dispatch-store";
import { failPiAgentMission } from "@/lib/services/pi-agent-mission-store";
import { readQuantRunPlan } from "@/lib/domains/finance/workspace";
import { buildClarificationContinuation } from "@/lib/domains/finance/intent";
import { recallPersonalization } from "@/lib/platform/memory";
import { getProjectIntegrationScope } from "@/lib/platform/context/integration-scope";
import { financeResearchRequestSchema } from "./finance-research-request";
import {
  assertRegisteredFinanceComposition,
  createFinanceGenerationEnvelope,
  FINANCE_GENERATION_HANDLER,
} from "./finance-generation-executor";
import { prepareFinanceActGenerationUnderLease } from "./finance-act-preparation";
import {
  finishQuantGenerationQueueItem,
  runQuantGenerationStage,
} from "./generation-queue";
import { createWorkspaceProgressPublisher } from "./workspace-progress";
import { updateQuantGenerationStep } from "./generation-state";

export async function executeFinanceResearchPreparation(
  job: DataAgentGenerationJobInput,
): Promise<void> {
  const envelope = job.executionEnvelope as DataAgentGenerationEnvelope;
  const payload = financeResearchRequestSchema.parse(envelope.payload);
  assertRegisteredFinanceComposition(envelope);
  if (
    envelope.scope.projectId !== job.projectId ||
    envelope.scope.workspaceId !== job.projectId ||
    envelope.scope.requestId !== job.requestId ||
    job.selectedModel !== payload.selectedModel ||
    job.cliPreference !== payload.cliPreference
  ) {
    throw new Error(
      "Research preparation identity does not match its durable job.",
    );
  }
  const integrationScope = getProjectIntegrationScope(job.projectId);
  if (
    integrationScope.scopeSha256 !== envelope.scope.integrationScopeSha256 ||
    integrationScope.consumerId !== envelope.scope.consumerId ||
    integrationScope.memory.tenantId !== envelope.scope.tenantId
  ) {
    throw new Error(
      "Research preparation integration scope changed after dispatch.",
    );
  }
  const fence = currentPiAgentGenerationDispatchFence();
  if (
    !fence ||
    fence.jobId !== job.jobId ||
    fence.projectId !== job.projectId ||
    fence.requestId !== job.requestId
  ) {
    throw new Error(
      "Research preparation requires its current dispatch lease.",
    );
  }
  const assertActive = async () => {
    await readClaimedPiAgentGenerationJob(fence);
    if (await isUserRequestCancelled(job.projectId, job.requestId))
      throw new Error("Research request was cancelled.");
  };
  await assertActive();
  const project = await getProjectById(job.projectId);
  if (
    !project ||
    project.agentProfileId !== envelope.composition.profile.id ||
    project.agentProfileVersion !== envelope.composition.profile.version
  ) {
    throw new Error(
      "Research project profile does not match the queued request.",
    );
  }
  const workspace = await assertManagedWorkspaceExists(
    job.projectId,
    project.repoPath,
  );
  const relatedAgentRequestIds = new Set([job.requestId]);
  const publishWorkspaceProgress = createWorkspaceProgressPublisher({
    projectId: job.projectId,
    requestId: job.requestId,
    conversationId: payload.conversationId,
    cliSource: "pi",
    relatedAgentRequestIds,
  });
  let missionId: string | null = null;
  let preparedEnvelope: DataAgentGenerationEnvelope | null = null;
  try {
    await runQuantGenerationStage({
      projectId: job.projectId,
      projectPath: workspace,
      requestId: job.requestId,
      stage: "planning_data_prefetch",
      lockWorkspace: true,
      task: async () => {
        await assertActive();
        if (
          !(await markUserRequestAsProcessing(job.projectId, job.requestId))
        ) {
          throw new Error("Research request is no longer active.");
        }
        await ensureProjectLlmConfiguration({
          projectId: job.projectId,
          projectName: project.name,
          projectPath: workspace,
          preferredCli: project.preferredCli,
          selectedModel: payload.selectedModel,
          settings: project.settings,
          agentProfileId: project.agentProfileId,
        });
        const previousRunPlan = await readQuantRunPlan(workspace);
        const continuation = buildClarificationContinuation({
          previousPlan: previousRunPlan,
          instruction: payload.finalInstruction,
          displayInstruction: payload.displayInstruction,
          capabilityId: payload.capabilityId,
          reset: payload.isInitialPrompt,
        });
        const effectiveInstruction = continuation
          ? [
              continuation.resolvedInstruction,
              payload.imageAttachmentInstruction,
            ]
              .filter(Boolean)
              .join("\n\n")
          : payload.finalInstruction;
        const effectiveDisplayInstruction =
          continuation?.displayInstruction ?? payload.displayInstruction;
        const memoryRecall = await recallPersonalization({
          projectId: job.projectId,
          actorUserId: payload.memorySubjectId,
          requestId: job.requestId,
          instruction: effectiveDisplayInstruction || effectiveInstruction,
          capabilityId: payload.capabilityId,
        });
        await assertActive();
        const preparation = await prepareFinanceActGenerationUnderLease({
          projectId: job.projectId,
          projectPath: workspace,
          requestId: job.requestId,
          finalInstruction: payload.finalInstruction,
          effectiveInstruction,
          effectiveDisplayInstruction,
          isInitialPrompt: payload.isInitialPrompt,
          cliPreference: "pi",
          selectedModel: payload.selectedModel,
          conversationId: payload.conversationId,
          capabilityId: payload.capabilityId,
          capabilitySelectionSource: payload.capabilitySelectionSource,
          processedImageCount: payload.processedImages.length,
          previousRunPlan,
          quotaActorUserId: payload.actorUserId,
          userMessageId: payload.userMessageId,
          relatedAgentRequestIds,
          publishWorkspaceProgress,
          assertActive,
        });
        missionId = preparation.missionContext?.id ?? null;
        await assertActive();
        if (preparation.response) {
          await finishQuantGenerationQueueItem({
            projectPath: workspace,
            projectId: job.projectId,
            requestId: job.requestId,
            status: preparation.response.status < 400 ? "completed" : "failed",
            errorCode:
              preparation.response.status >= 400 && typeof preparation.response.body.error === "string"
                ? preparation.response.body.error
                : undefined,
            errorMessage:
              preparation.response.status >= 400
                ? String(
                    preparation.response.body.message ?? "Preparation failed",
                  )
                : undefined,
          });
          return;
        }
        const mission = preparation.missionContext;
        const runPlan = await readQuantRunPlan(workspace);
        if (
          !mission ||
          !preparation.governedKnowledgePreparation ||
          !runPlan ||
          runPlan.runId !== job.requestId
        ) {
          throw new Error(
            "Preparation did not produce the current Mission and research inputs.",
          );
        }
        await lockProjectDataAgentComposition({
          projectId: job.projectId,
          projectPath: workspace,
          composition: runPlan.composition,
        });
        await updateProject(job.projectId, {
          preferredCli: "pi",
          selectedModel: payload.selectedModel,
        });
        preparedEnvelope = createFinanceGenerationEnvelope(
          {
            effectiveInstruction,
            userVisibleInstructionForRepair:
              effectiveDisplayInstruction || payload.finalInstruction,
            selectedModel: payload.selectedModel,
            cliPreference: "pi",
            isInitialPrompt: payload.isInitialPrompt,
            conversationId: payload.conversationId,
            actorUserId: payload.actorUserId,
            memorySubjectId: payload.memorySubjectId,
            processedImages: payload.processedImages,
            usePrefetchedSelectionDashboard:
              preparation.usePrefetchedSelectionDashboard,
            missionId: mission.id,
            generationId: mission.generationId,
            governedKnowledgeTaskCategory:
              preparation.governedKnowledgeTaskCategory,
            personalizationRecall: memoryRecall,
            governedKnowledgePreparation:
              preparation.governedKnowledgePreparation,
          },
          {
            projectId: job.projectId,
            requestId: job.requestId,
            capabilityId: runPlan.capabilityId,
          },
        );
        await assertActive();
        await checkpointPiAgentGenerationPreparation({
          fence,
          executionEnvelope: preparedEnvelope,
        });
      },
    });
  } catch (error) {
    if (await isUserRequestCancelled(job.projectId, job.requestId)) return;
    // A stale worker cannot publish a failure over cancellation or a replacement.
    await readClaimedPiAgentGenerationJob(fence);
    const message = error instanceof Error ? error.message : String(error);
    if (missionId)
      await failPiAgentMission({
        missionId,
        projectId: job.projectId,
        requestId: job.requestId,
        code: "RESEARCH_PREPARATION_FAILED",
        message,
      });
    await updateQuantGenerationStep({
      projectPath: workspace,
      projectId: job.projectId,
      requestId: job.requestId,
      stepId: "planning",
      status: "failed",
      runStatus: "failed",
      summary: "研究准备失败。",
      errorMessage: message,
    });
    await markUserRequestAsFailed(job.projectId, job.requestId, message);
    await publishWorkspaceProgress({ stage: 5, failureReason: message });
    throw error;
  }
  if (preparedEnvelope) {
    await assertActive();
    await FINANCE_GENERATION_HANDLER.execute({
      ...job,
      executionEnvelope: preparedEnvelope,
    });
  }
}
