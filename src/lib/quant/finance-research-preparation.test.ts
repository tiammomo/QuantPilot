import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  project: vi.fn(),
  configure: vi.fn(),
  lock: vi.fn(),
  update: vi.fn(),
  cancelled: vi.fn(),
  processing: vi.fn(),
  failed: vi.fn(),
  fence: vi.fn(),
  readClaimed: vi.fn(),
  checkpoint: vi.fn(),
  failMission: vi.fn(),
  readPlan: vi.fn(),
  continuation: vi.fn(),
  recall: vi.fn(),
  prepare: vi.fn(),
  finish: vi.fn(),
  stage: vi.fn(),
  execute: vi.fn(),
  progress: vi.fn(),
  updateStep: vi.fn(),
}));
vi.mock("@/lib/services/project", () => ({
  getProjectById: mocks.project,
  ensureProjectLlmConfiguration: mocks.configure,
  lockProjectDataAgentComposition: mocks.lock,
  updateProject: mocks.update,
}));
vi.mock("@/lib/services/user-requests", () => ({
  isUserRequestCancelled: mocks.cancelled,
  markUserRequestAsProcessing: mocks.processing,
  markUserRequestAsFailed: mocks.failed,
}));
vi.mock("@/lib/services/pi-agent-generation-dispatch-session", () => ({
  currentPiAgentGenerationDispatchFence: mocks.fence,
}));
vi.mock("@/lib/services/pi-agent-generation-dispatch-store", () => ({
  readClaimedPiAgentGenerationJob: mocks.readClaimed,
  checkpointPiAgentGenerationPreparation: mocks.checkpoint,
}));
vi.mock("@/lib/services/pi-agent-mission-store", () => ({
  failPiAgentMission: mocks.failMission,
}));
vi.mock("@/lib/domains/finance/workspace", () => ({
  readQuantRunPlan: mocks.readPlan,
}));
vi.mock("@/lib/domains/finance/intent", () => ({
  buildClarificationContinuation: mocks.continuation,
}));
vi.mock("@/lib/platform/memory", () => ({
  recallPersonalization: mocks.recall,
}));
vi.mock("./finance-act-preparation", () => ({
  prepareFinanceActGenerationUnderLease: mocks.prepare,
}));
vi.mock("./generation-queue", () => ({
  finishQuantGenerationQueueItem: mocks.finish,
  runQuantGenerationStage: mocks.stage,
}));
vi.mock("./workspace-progress", () => ({
  createWorkspaceProgressPublisher: () => mocks.progress,
}));
vi.mock("./generation-state", () => ({
  updateQuantGenerationStep: mocks.updateStep,
}));
vi.mock("@/lib/data-agent", async (original) => ({
  ...(await original<object>()),
  assertManagedWorkspaceExists: vi.fn(async () => "/workspace/project-1"),
}));
vi.mock("./finance-generation-executor", async (original) => {
  const actual =
    await original<typeof import("./finance-generation-executor")>();
  return {
    ...actual,
    FINANCE_GENERATION_HANDLER: {
      ...actual.FINANCE_GENERATION_HANDLER,
      execute: mocks.execute,
    },
  };
});

import {
  createFinanceGenerationEnvelope,
  parseFinanceGenerationEnvelope,
} from "./finance-generation-executor";
import { createApplicationGenerationRuntime } from "./generation-runtime";
import type { FinanceResearchRequest } from "./finance-research-request";

const payload: FinanceResearchRequest = {
  phase: "preparation",
  schemaVersion: 1,
  finalInstruction: "分析沪深300",
  displayInstruction: "分析沪深300",
  imageAttachmentInstruction: "",
  selectedModel: "local_qwen:qwen3.5-9b-q5km",
  cliPreference: "pi",
  isInitialPrompt: false,
  conversationId: null,
  actorUserId: null,
  memorySubjectId: "subject-1",
  userMessageId: "message-1",
  capabilityId: null,
  capabilitySelectionSource: null,
  processedImages: [],
};
const envelope = createFinanceGenerationEnvelope(payload, {
  projectId: "project-1",
  requestId: "request-1",
  capabilityId: "stock_diagnosis",
});
const job = {
  jobId: "job-1",
  projectId: "project-1",
  requestId: "request-1",
  selectedModel: payload.selectedModel,
  cliPreference: "pi",
  executionEnvelope: envelope,
};
const fence = {
  jobId: job.jobId,
  projectId: job.projectId,
  requestId: job.requestId,
  leaseOwner: "worker-1",
  fencingToken: 1,
};
const memory = {
  status: "empty",
  capsule: null,
  exposedMemoryCount: 0,
  preparedUse: null,
};
const knowledge = {
  status: "empty",
  capsule: null,
  passageCount: 0,
  citationCount: 0,
};

beforeEach(() => {
  vi.resetAllMocks();
  mocks.fence.mockReturnValue(fence);
  mocks.cancelled.mockResolvedValue(false);
  mocks.processing.mockResolvedValue(true);
  mocks.project.mockResolvedValue({
    name: "test",
    repoPath: "/workspace/project-1",
    preferredCli: "pi",
    settings: {},
    agentProfileId: envelope.composition.profile.id,
    agentProfileVersion: envelope.composition.profile.version,
  });
  mocks.stage.mockImplementation(async ({ task }) => task());
  mocks.readPlan.mockResolvedValue({
    runId: job.requestId,
    capabilityId: "stock_diagnosis",
    composition: envelope.composition,
  });
  mocks.recall.mockResolvedValue(memory);
  mocks.prepare.mockResolvedValue({
    response: null,
    missionContext: { id: "mission-1", generationId: "generation-1" },
    governedKnowledgePreparation: knowledge,
    governedKnowledgeTaskCategory: "single-stock-diagnosis",
    usePrefetchedSelectionDashboard: false,
  });
});

describe("durable research preparation", () => {
  it("holds the workspace through preparation and checkpoints all inputs before Agent execution", async () => {
    const order: string[] = [];
    mocks.stage.mockImplementation(async ({ task }) => {
      order.push("lease");
      await task();
      order.push("release");
    });
    mocks.checkpoint.mockImplementation(async () => {
      order.push("checkpoint");
    });
    mocks.execute.mockImplementation(async () => {
      order.push("execute");
    });
    await createApplicationGenerationRuntime().execute(job);
    expect(order).toEqual(["lease", "checkpoint", "release", "execute"]);
    expect(mocks.stage).toHaveBeenCalledWith(
      expect.objectContaining({
        stage: "planning_data_prefetch",
        lockWorkspace: true,
      }),
    );
    const saved = mocks.checkpoint.mock.calls[0][0];
    expect(saved.fence).toEqual(fence);
    expect(
      parseFinanceGenerationEnvelope(saved.executionEnvelope),
    ).toMatchObject({
      personalizationRecall: memory,
      governedKnowledgePreparation: knowledge,
      missionId: "mission-1",
      generationId: "generation-1",
    });
    expect(mocks.execute).toHaveBeenCalledWith({
      ...job,
      executionEnvelope: saved.executionEnvelope,
    });
    // A replacement worker routes the saved envelope directly to execution.
    mocks.prepare.mockClear();
    mocks.recall.mockClear();
    await createApplicationGenerationRuntime().execute({
      ...job,
      executionEnvelope: saved.executionEnvelope,
    });
    expect(mocks.prepare).not.toHaveBeenCalled();
    expect(mocks.recall).not.toHaveBeenCalled();
  });

  it.each([
    ["intent_clarification_required", 200, "completed"],
    ["intent_refused", 200, "completed"],
    ["failed", 503, "failed"],
  ])("closes %s without starting an Agent", async (status, http, terminal) => {
    mocks.prepare.mockResolvedValue({
      response: { status: http, body: { status } },
      missionContext: null,
    });
    await createApplicationGenerationRuntime().execute(job);
    expect(mocks.finish).toHaveBeenCalledWith(
      expect.objectContaining({ status: terminal }),
    );
    expect(mocks.checkpoint).not.toHaveBeenCalled();
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it("stops a cancelled preparation before checkpoint or execution", async () => {
    mocks.prepare.mockImplementation(async () => {
      mocks.cancelled.mockResolvedValue(true);
      return { missionContext: null };
    });
    await createApplicationGenerationRuntime().execute(job);
    expect(mocks.checkpoint).not.toHaveBeenCalled();
    expect(mocks.execute).not.toHaveBeenCalled();
    expect(mocks.failed).not.toHaveBeenCalled();
  });

  it("does not publish stale failure when the dispatch lease is replaced", async () => {
    mocks.recall.mockImplementation(async () => {
      mocks.readClaimed.mockRejectedValue(new Error("lease lost"));
      return memory;
    });
    await expect(
      createApplicationGenerationRuntime().execute(job),
    ).rejects.toThrow("lease lost");
    expect(mocks.prepare).not.toHaveBeenCalled();
    expect(mocks.failed).not.toHaveBeenCalled();
    expect(mocks.updateStep).not.toHaveBeenCalled();
  });

  it("rejects a scope mismatch before invoking any model or data preparation", async () => {
    await expect(
      createApplicationGenerationRuntime().execute({
        ...job,
        requestId: "other",
      }),
    ).rejects.toThrow();
    expect(mocks.configure).not.toHaveBeenCalled();
    expect(mocks.recall).not.toHaveBeenCalled();
    expect(mocks.prepare).not.toHaveBeenCalled();
  });

  it("does not execute if the prepared envelope cannot be persisted", async () => {
    mocks.checkpoint.mockRejectedValue(new Error("database unavailable"));
    await expect(
      createApplicationGenerationRuntime().execute(job),
    ).rejects.toThrow("database unavailable");
    expect(mocks.execute).not.toHaveBeenCalled();
    expect(mocks.failed).toHaveBeenCalledWith(
      job.projectId,
      job.requestId,
      "database unavailable",
    );
    expect(mocks.failMission).toHaveBeenCalled();
  });
});
