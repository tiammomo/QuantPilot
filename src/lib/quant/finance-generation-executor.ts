import path from "node:path";

import type {
  DataAgentGenerationEnvelope,
  DataAgentGenerationHandler,
  DataAgentGenerationJobInput,
  ProcessedDataAgentImageAttachment,
} from "@/lib/data-agent";
import {
  capturePlatformMissionCandidate,
  loadMoAgentMissionContext,
} from "@/lib/services/moagent-mission-control";
import { failMoAgentMission } from "@/lib/services/moagent-mission-store";
import { getProjectById, updateProjectActivity } from "@/lib/services/project";
import { createWorkspaceProgressPublisher } from "@/lib/quant/workspace-progress";
import { updateQuantGenerationStep } from "@/lib/quant/generation-state";
import { readQuantRunPlan } from "@/lib/domains/finance/workspace";
import {
  exposePersonalization,
  type PersonalizationRecallResult,
} from "@/lib/platform/memory";
import { type GovernedKnowledgePreparation } from "@/lib/platform/knowledge";
import { getProjectIntegrationScope } from "@/lib/platform/context/integration-scope";
import { recordContextExposure } from "@/lib/platform/context/use-manifest";
import { renewQuotaReservation, releaseQuotaReservation } from "@/lib/quota";
import { streamManager } from "@/lib/services/stream";
import { markUserRequestAsFailed } from "@/lib/services/user-requests";
import { runValidationAfterExecution } from "@/lib/quant/generation-validation";
import {
  FINANCE_DOMAIN_PACK_ID,
  QUANTPILOT_AGENT_PROFILE,
} from "@/lib/domains/finance/agent-profile";

export interface FinanceGenerationPayload {
  effectiveInstruction: string;
  userVisibleInstructionForRepair: string;
  selectedModel: string;
  cliPreference: "moagent";
  isInitialPrompt: boolean;
  conversationId: string | null;
  actorUserId: string | null;
  memorySubjectId: string;
  processedImages: ProcessedDataAgentImageAttachment[];
  usePrefetchedSelectionDashboard: boolean;
  missionId: string;
  generationId: string;
  governedKnowledgeTaskCategory: string;
  personalizationRecall: PersonalizationRecallResult;
  governedKnowledgePreparation: GovernedKnowledgePreparation;
  concurrencyReservationId: string | null;
}

type CliRuntime = typeof import("@/lib/services/cli/moagent");

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, label: string, max = 100_000): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) {
    throw new Error(`${label} must be a non-empty bounded string.`);
  }
  return value;
}

function nullableString(value: unknown, label: string): string | null {
  if (value === null || value === undefined) return null;
  return requiredString(value, label, 512);
}

function imageAttachments(value: unknown): ProcessedDataAgentImageAttachment[] {
  if (!Array.isArray(value) || value.length > 8) {
    throw new Error(
      "processedImages must be an array with at most eight entries.",
    );
  }
  return value.map((item, index) => {
    const image = record(item, `processedImages[${index}]`);
    const size = Number(image.size);
    if (!Number.isSafeInteger(size) || size < 0) {
      throw new Error(
        `processedImages[${index}].size must be a non-negative integer.`,
      );
    }
    return {
      name: requiredString(image.name, `processedImages[${index}].name`, 512),
      path: requiredString(image.path, `processedImages[${index}].path`, 4_096),
      url: requiredString(image.url, `processedImages[${index}].url`, 4_096),
      publicUrl: requiredString(
        image.publicUrl,
        `processedImages[${index}].publicUrl`,
        4_096,
      ),
      mimeType: requiredString(
        image.mimeType,
        `processedImages[${index}].mimeType`,
        128,
      ),
      size,
    };
  });
}

function personalizationRecall(value: unknown): PersonalizationRecallResult {
  const recall = record(value, "personalizationRecall");
  if (
    !["disabled", "opted_out", "unavailable", "empty", "prepared"].includes(
      String(recall.status),
    )
  ) {
    throw new Error("personalizationRecall.status is invalid.");
  }
  if (
    !Number.isSafeInteger(recall.exposedMemoryCount) ||
    Number(recall.exposedMemoryCount) < 0
  ) {
    throw new Error(
      "personalizationRecall.exposedMemoryCount must be a non-negative integer.",
    );
  }
  if (recall.capsule !== null)
    record(recall.capsule, "personalizationRecall.capsule");
  if (recall.preparedUse !== null)
    record(recall.preparedUse, "personalizationRecall.preparedUse");
  if (
    recall.status === "prepared" &&
    (recall.capsule === null ||
      recall.preparedUse === null ||
      Number(recall.exposedMemoryCount) === 0)
  ) {
    throw new Error(
      "Prepared personalization recall requires a capsule, prepared use, and exposed memory.",
    );
  }
  return recall as unknown as PersonalizationRecallResult;
}

function governedKnowledgePreparation(
  value: unknown,
): GovernedKnowledgePreparation {
  const preparation = record(value, "governedKnowledgePreparation");
  if (
    !["disabled", "unavailable", "empty", "prepared"].includes(
      String(preparation.status),
    )
  ) {
    throw new Error("governedKnowledgePreparation.status is invalid.");
  }
  if (
    !Number.isSafeInteger(preparation.passageCount) ||
    Number(preparation.passageCount) < 0
  ) {
    throw new Error(
      "governedKnowledgePreparation.passageCount must be a non-negative integer.",
    );
  }
  if (
    !Number.isSafeInteger(preparation.citationCount) ||
    Number(preparation.citationCount) < 0
  ) {
    throw new Error(
      "governedKnowledgePreparation.citationCount must be a non-negative integer.",
    );
  }
  if (preparation.capsule !== null)
    record(preparation.capsule, "governedKnowledgePreparation.capsule");
  if (
    preparation.status === "prepared" &&
    (preparation.capsule === null || Number(preparation.citationCount) === 0)
  ) {
    throw new Error(
      "Prepared governed knowledge requires a capsule and citations.",
    );
  }
  return preparation as unknown as GovernedKnowledgePreparation;
}

export function createFinanceGenerationEnvelope(
  payload: FinanceGenerationPayload,
): DataAgentGenerationEnvelope<FinanceGenerationPayload> {
  return {
    schemaVersion: 2,
    kind: "data-agent.generation",
    profileId: QUANTPILOT_AGENT_PROFILE.id,
    domainPackId: FINANCE_DOMAIN_PACK_ID,
    deliveryPackId: QUANTPILOT_AGENT_PROFILE.deliveryPackId,
    payload,
  };
}

export function parseFinanceGenerationEnvelope(
  envelope: DataAgentGenerationEnvelope,
): FinanceGenerationPayload {
  if (
    envelope.profileId !== QUANTPILOT_AGENT_PROFILE.id ||
    envelope.domainPackId !== FINANCE_DOMAIN_PACK_ID ||
    envelope.deliveryPackId !== QUANTPILOT_AGENT_PROFILE.deliveryPackId
  ) {
    throw new Error(
      "Finance generation composition does not match the registered profile.",
    );
  }
  const payload = record(envelope.payload, "finance generation payload");
  if (payload.cliPreference !== "moagent") {
    throw new Error("Finance generation only supports the MoAgent runtime.");
  }
  if (typeof payload.isInitialPrompt !== "boolean") {
    throw new Error("isInitialPrompt must be a boolean.");
  }
  if (typeof payload.usePrefetchedSelectionDashboard !== "boolean") {
    throw new Error("usePrefetchedSelectionDashboard must be a boolean.");
  }
  return {
    effectiveInstruction: requiredString(
      payload.effectiveInstruction,
      "effectiveInstruction",
    ),
    userVisibleInstructionForRepair: requiredString(
      payload.userVisibleInstructionForRepair,
      "userVisibleInstructionForRepair",
    ),
    selectedModel: requiredString(payload.selectedModel, "selectedModel", 512),
    cliPreference: "moagent",
    isInitialPrompt: payload.isInitialPrompt,
    conversationId: nullableString(payload.conversationId, "conversationId"),
    actorUserId: nullableString(payload.actorUserId, "actorUserId"),
    memorySubjectId: requiredString(
      payload.memorySubjectId,
      "memorySubjectId",
      512,
    ),
    processedImages: imageAttachments(payload.processedImages),
    usePrefetchedSelectionDashboard: payload.usePrefetchedSelectionDashboard,
    missionId: requiredString(payload.missionId, "missionId", 512),
    generationId: requiredString(payload.generationId, "generationId", 512),
    governedKnowledgeTaskCategory: requiredString(
      payload.governedKnowledgeTaskCategory,
      "governedKnowledgeTaskCategory",
      512,
    ),
    personalizationRecall: personalizationRecall(payload.personalizationRecall),
    governedKnowledgePreparation: governedKnowledgePreparation(
      payload.governedKnowledgePreparation,
    ),
    concurrencyReservationId: nullableString(
      payload.concurrencyReservationId,
      "concurrencyReservationId",
    ),
  };
}

function projectPath(projectId: string, repoPath?: string | null): string {
  if (repoPath)
    return path.isAbsolute(repoPath)
      ? repoPath
      : path.resolve(process.cwd(), repoPath);
  const root = process.env.PROJECTS_DIR || "./data/projects";
  return path.resolve(process.cwd(), root, projectId);
}

async function executeFinanceGeneration(
  job: DataAgentGenerationJobInput,
): Promise<void> {
  const envelope = job.executionEnvelope as DataAgentGenerationEnvelope;
  const payload = parseFinanceGenerationEnvelope(envelope);
  if (job.selectedModel && job.selectedModel !== payload.selectedModel) {
    throw new Error(
      "Selected model does not match the durable finance payload.",
    );
  }
  const project = await getProjectById(job.projectId);
  if (!project) throw new Error("Generation project does not exist.");
  const workspace = projectPath(job.projectId, project.repoPath);
  const mission = await loadMoAgentMissionContext({
    projectId: job.projectId,
    projectPath: workspace,
    requestId: job.requestId,
    missionId: payload.missionId,
    generationId: payload.generationId,
  });
  const runPlan = await readQuantRunPlan(workspace);
  if (!runPlan || runPlan.status !== "planned" || !runPlan.capabilityId) {
    throw new Error(
      "A planned Finance run plan is required before worker execution.",
    );
  }
  const relatedAgentRequestIds = new Set<string>([job.requestId]);
  const publishWorkspaceProgress = createWorkspaceProgressPublisher({
    projectId: job.projectId,
    requestId: job.requestId,
    conversationId: payload.conversationId,
    cliSource: payload.cliPreference,
    relatedAgentRequestIds,
  });
  const integrationScope = getProjectIntegrationScope(job.projectId);
  const personalization = await exposePersonalization({
    projectId: job.projectId,
    actorUserId: payload.memorySubjectId,
    requestId: job.requestId,
    recall: payload.personalizationRecall,
  });
  const governedKnowledge = payload.usePrefetchedSelectionDashboard
    ? null
    : payload.governedKnowledgePreparation.capsule;
  await recordContextExposure({
    projectPath: workspace,
    projectId: job.projectId,
    requestId: job.requestId,
    integrationScope,
    memory: personalization,
    knowledge: governedKnowledge,
  });
  await updateProjectActivity(job.projectId);
  const cliRuntime: CliRuntime = await import("@/lib/services/cli/moagent");

  await runValidationAfterExecution({
    execution: (async () => {
      await updateQuantGenerationStep({
        projectPath: workspace,
        projectId: job.projectId,
        requestId: job.requestId,
        stepId: "agent_execution",
        status: "running",
        summary: payload.usePrefetchedSelectionDashboard
          ? "平台已完成选股数据预取和标准看板生成，跳过 Agent 生成。"
          : payload.isInitialPrompt
            ? "开始初始化并生成工作空间。"
            : "开始让 Agent 修改工作空间。",
      });
      if (payload.usePrefetchedSelectionDashboard) {
        streamManager.publish(job.projectId, {
          type: "status",
          data: {
            status: "prefetched_selection_dashboard_ready",
            message:
              "已基于本地选股接口和数据库数据生成标准选股看板，正在进入自动验证。",
            requestId: job.requestId,
          },
        });
        return capturePlatformMissionCandidate({
          mission,
          source: "platform_prefetch",
          sourceRequestId: job.requestId,
          summary: "平台已基于预取数据生成确定性选股看板候选。",
        });
      }
      if (payload.isInitialPrompt) {
        return cliRuntime.initializeNextJsProject(
          job.projectId,
          workspace,
          payload.effectiveInstruction,
          payload.selectedModel,
          job.requestId,
          personalization,
          governedKnowledge,
        );
      }
      return cliRuntime.applyChanges(
        job.projectId,
        workspace,
        payload.effectiveInstruction,
        payload.selectedModel,
        job.requestId,
        payload.processedImages,
        personalization,
        governedKnowledge,
      );
    })(),
    repairExecutor: cliRuntime.applyRepairChanges,
    mission,
    projectId: job.projectId,
    projectPath: workspace,
    instruction: payload.userVisibleInstructionForRepair,
    selectedModel: payload.selectedModel,
    requestId: job.requestId,
    actorUserId: payload.actorUserId,
    conversationId: payload.conversationId,
    cliSource: payload.cliPreference,
    agentExecutionSuccessSummary: payload.usePrefetchedSelectionDashboard
      ? "平台已完成本地选股、行情预取和标准看板生成，跳过 Agent 生成并进入自动验证。"
      : undefined,
    governedKnowledge,
    governedKnowledgePreparation: payload.governedKnowledgePreparation,
    governedKnowledgeTaskCategory: payload.governedKnowledgeTaskCategory,
    publishWorkspaceProgress,
    relatedAgentRequestIds,
  });
}

async function withConcurrencyReservation(
  reservationId: string | null,
  task: () => Promise<void>,
): Promise<void> {
  if (!reservationId) return task();
  const timer = setInterval(
    () => {
      void renewQuotaReservation({
        reservationId,
        reservationTtlSeconds: 3_600,
      }).catch((error) => {
        console.error(
          "[GenerationWorker] Failed to renew concurrency reservation:",
          error,
        );
      });
    },
    5 * 60 * 1_000,
  );
  timer.unref?.();
  try {
    await renewQuotaReservation({
      reservationId,
      reservationTtlSeconds: 3_600,
    });
    await task();
  } finally {
    clearInterval(timer);
    await releaseQuotaReservation({ reservationId }).catch((error) => {
      console.error(
        "[GenerationWorker] Failed to release concurrency reservation:",
        error,
      );
    });
  }
}

export const FINANCE_GENERATION_HANDLER: DataAgentGenerationHandler = {
  domainPackId: FINANCE_DOMAIN_PACK_ID,
  async execute(job) {
    const envelope = job.executionEnvelope as DataAgentGenerationEnvelope;
    const payload = parseFinanceGenerationEnvelope(envelope);
    try {
      await withConcurrencyReservation(payload.concurrencyReservationId, () =>
        executeFinanceGeneration(job),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const project = await getProjectById(job.projectId).catch(() => null);
      const workspace = projectPath(job.projectId, project?.repoPath);
      await Promise.allSettled([
        failMoAgentMission({
          missionId: payload.missionId,
          projectId: job.projectId,
          requestId: job.requestId,
          code: "GENERATION_WORKER_FAILED",
          message,
        }),
        updateQuantGenerationStep({
          projectPath: workspace,
          projectId: job.projectId,
          requestId: job.requestId,
          stepId: "agent_execution",
          status: "failed",
          summary: `独立生成 Worker 执行失败：${message}`,
          runStatus: "failed",
          errorMessage: message,
        }),
        markUserRequestAsFailed(job.projectId, job.requestId, message),
      ]);
      throw error;
    }
  },
};
