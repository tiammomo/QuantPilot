import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  activity: vi.fn(),
  publish: vi.fn(),
  enqueue: vi.fn(),
}));
vi.mock("@/lib/services/message", () => ({ createMessage: mocks.create }));
vi.mock("@/lib/services/project", () => ({
  updateProjectActivity: mocks.activity,
}));
vi.mock("@/lib/services/stream", () => ({
  streamManager: { publish: mocks.publish },
}));
vi.mock("@/lib/serializers/chat", () => ({
  serializeMessage: (value: unknown) => value,
}));
vi.mock("./generation-queue", () => ({
  enqueueQuantGeneration: mocks.enqueue,
}));
import { enqueueFinanceResearchRequest } from "./finance-research-request";

const input = {
  projectId: "project-1",
  projectPath: "/workspace/project-1",
  requestId: "request-1",
  finalInstruction: "分析沪深300",
  displayInstruction: "分析沪深300",
  imageAttachmentInstruction: "",
  attachmentContextPath: null,
  selectedModel: "local_qwen:qwen3.5-9b-q5km",
  isInitialPrompt: false,
  conversationId: null,
  actorUserId: null,
  memorySubjectId: "subject-1",
  processedImages: [],
};
beforeEach(() => {
  vi.resetAllMocks();
  mocks.create.mockResolvedValue({ id: "message-1" });
  mocks.activity.mockResolvedValue(undefined);
});

describe("research request acceptance", () => {
  it("persists the preparation instruction and scope with a single preparation attempt", async () => {
    await expect(enqueueFinanceResearchRequest(input)).resolves.toEqual({
      userMessageId: "message-1",
    });
    expect(mocks.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        stage: "planning_data_prefetch",
        maxAttempts: 1,
        executionEnvelope: expect.objectContaining({
          scope: expect.objectContaining({
            projectId: input.projectId,
            requestId: input.requestId,
          }),
          payload: expect.objectContaining({
            phase: "preparation",
            userMessageId: "message-1",
            finalInstruction: input.finalInstruction,
          }),
        }),
      }),
    );
  });

  it("keeps a committed request accepted when activity or SSE projection fails", async () => {
    mocks.activity.mockRejectedValue(new Error("projection unavailable"));
    mocks.publish.mockImplementation(() => {
      throw new Error("subscriber unavailable");
    });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await expect(enqueueFinanceResearchRequest(input)).resolves.toEqual({
      userMessageId: "message-1",
    });
    expect(mocks.enqueue).toHaveBeenCalledOnce();
  });

  it("does not publish acceptance when persistence rejects the envelope", async () => {
    mocks.enqueue.mockRejectedValue(new Error("database unavailable"));
    await expect(enqueueFinanceResearchRequest(input)).rejects.toThrow(
      "database unavailable",
    );
    expect(mocks.activity).not.toHaveBeenCalled();
    expect(mocks.publish).not.toHaveBeenCalled();
  });
});
