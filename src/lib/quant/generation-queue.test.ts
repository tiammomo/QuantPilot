import fs from "fs/promises";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const jobs = new Map<string, Record<string, unknown>>();
  const cancelled = new Set<string>();
  let currentSession: {
    fence: Record<string, unknown>;
    assertHealthy: () => void;
  } | null = null;
  return {
    jobs,
    cancelled,
    get currentSession() {
      return currentSession;
    },
    setCurrentSession(value: typeof currentSession) {
      currentSession = value;
    },
    withGenerationLease: vi.fn(async <T>(input: { task: () => Promise<T> }) =>
      input.task(),
    ),
    finishJob: vi.fn(),
    cancelJob: vi.fn(),
  };
});

function jobKey(projectId: string, requestId: string) {
  return `${projectId}:${requestId}`;
}

function makeJob(input: {
  projectId: string;
  requestId: string;
  instruction?: string;
  status?: string;
  errorMessage?: string | null;
}) {
  const now = new Date();
  return {
    id: `job-${input.requestId}`,
    projectId: input.projectId,
    requestId: input.requestId,
    status: input.status ?? "running",
    stage: "agent_execution",
    executionEnvelope: {},
    instructionHash: "sha256:test",
    instructionPreview: input.instruction ?? "",
    cliPreference: null,
    selectedModel: null,
    attemptCount: 1,
    maxAttempts: 1,
    availableAt: now,
    leaseOwner: input.status === "cancelled" ? null : "worker:test",
    leaseExpiresAt:
      input.status === "cancelled" ? null : new Date(now.getTime() + 60_000),
    lastHeartbeatAt: input.status === "cancelled" ? null : now,
    fencingToken: 1,
    version: 1,
    eventSequence: 2,
    errorCode: input.status === "cancelled" ? "USER_CANCELLED" : null,
    errorMessage: input.errorMessage ?? null,
    queuedAt: now,
    startedAt: input.status === "cancelled" ? null : now,
    completedAt: input.status === "cancelled" ? now : null,
    createdAt: now,
    updatedAt: now,
  };
}

vi.mock("@/lib/services/moagent-generation-lease-session", () => ({
  withMoAgentGenerationLease: mocks.withGenerationLease,
}));

vi.mock("@/lib/services/moagent-generation-dispatch-store", () => {
  class DispatchError extends Error {
    constructor(
      readonly code: string,
      message: string,
    ) {
      super(message);
      this.name = "MoAgentGenerationDispatchError";
    }
  }
  return {
    MoAgentGenerationDispatchError: DispatchError,
    listMoAgentGenerationJobs: vi.fn(async (projectId: string) =>
      [...mocks.jobs.values()].filter((job) => job.projectId === projectId),
    ),
    listPendingMoAgentGenerationOutboxEvents: vi.fn(async () => []),
    markMoAgentGenerationOutboxEventsPublished: vi.fn(async () => 0),
    reconcileExpiredMoAgentGenerationJobs: vi.fn(async () => []),
    finishMoAgentGenerationJob: mocks.finishJob.mockImplementation(
      async (input: {
        projectId: string;
        requestId: string;
        status: string;
        errorMessage?: string | null;
      }) => {
        const key = jobKey(input.projectId, input.requestId);
        const current = mocks.jobs.get(key)!;
        const next = {
          ...current,
          status: input.status,
          leaseOwner: null,
          leaseExpiresAt: null,
          completedAt: new Date(),
          updatedAt: new Date(),
          errorMessage: input.errorMessage ?? null,
        };
        mocks.jobs.set(key, next);
        return next;
      },
    ),
    cancelMoAgentGenerationJob: mocks.cancelJob.mockImplementation(
      async (input: {
        projectId: string;
        requestId: string;
        reason?: string | null;
      }) => {
        const key = jobKey(input.projectId, input.requestId);
        mocks.cancelled.add(key);
        const next = makeJob({
          projectId: input.projectId,
          requestId: input.requestId,
          status: "cancelled",
          errorMessage: input.reason ?? "用户暂停了当前任务",
        });
        mocks.jobs.set(key, next);
        return next;
      },
    ),
  };
});

vi.mock("@/lib/services/moagent-generation-dispatch-session", async () => {
  const store =
    await import("@/lib/services/moagent-generation-dispatch-store");
  return {
    MoAgentGenerationDispatchSession: {
      enqueueAndClaim: vi.fn(
        async (input: {
          projectId: string;
          requestId: string;
          instruction: string;
        }) => {
          const key = jobKey(input.projectId, input.requestId);
          if (mocks.cancelled.has(key)) {
            throw new store.MoAgentGenerationDispatchError(
              "GENERATION_DISPATCH_CANCELLED",
              "test cancellation",
            );
          }
          const job = makeJob(input);
          mocks.jobs.set(key, job);
          const session = {
            claim: {
              jobId: job.id,
              projectId: input.projectId,
              requestId: input.requestId,
              leaseOwner: "worker:test",
              fencingToken: 1,
              attemptCount: 1,
              leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
            },
            fence: {
              jobId: job.id,
              projectId: input.projectId,
              requestId: input.requestId,
              leaseOwner: "worker:test",
              fencingToken: 1,
            },
            assertHealthy: vi.fn(),
            markTerminal: vi.fn(),
            run: async <T>(task: () => Promise<T>) => {
              mocks.setCurrentSession(session);
              try {
                return await task();
              } finally {
                mocks.setCurrentSession(null);
              }
            },
            dispose: vi.fn(),
          };
          return session;
        },
      ),
    },
    currentMoAgentGenerationDispatchFence: () => mocks.currentSession?.fence,
    currentMoAgentGenerationDispatchSession: () => mocks.currentSession,
  };
});

import {
  markQuantGenerationQueueCancelled,
  QuantGenerationCancelledError,
  readQuantGenerationQueue,
  runQuantGenerationQueued,
} from "./generation-queue";

const temporaryProjects: string[] = [];

async function createProject() {
  const projectPath = await fs.mkdtemp(
    path.join(os.tmpdir(), "quantpilot-generation-queue-"),
  );
  temporaryProjects.push(projectPath);
  return projectPath;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.jobs.clear();
  mocks.cancelled.clear();
  mocks.setCurrentSession(null);
});

afterEach(async () => {
  await Promise.all(
    temporaryProjects
      .splice(0)
      .map((projectPath) =>
        fs.rm(projectPath, { recursive: true, force: true }),
      ),
  );
});

describe("generation durable dispatch projection", () => {
  it("claims a durable job before delegating project exclusivity to the generation lease", async () => {
    const projectPath = await createProject();
    const projectId = `project-${Date.now()}`;
    let executed = false;

    await runQuantGenerationQueued({
      projectPath,
      projectId,
      requestId: "request-1",
      instruction: "first",
      task: async () => {
        executed = true;
      },
    });

    expect(executed).toBe(true);
    expect(mocks.withGenerationLease).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId,
        requestId: "request-1",
        stage: "agent_execution",
        task: expect.any(Function),
      }),
    );
    expect(mocks.finishJob).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId,
        requestId: "request-1",
        status: "completed",
        fence: expect.objectContaining({ fencingToken: 1 }),
      }),
    );
  });

  it("does not start a request cancelled before the worker claim", async () => {
    const projectPath = await createProject();
    const projectId = `project-cancel-${Date.now()}`;
    let started = false;

    await markQuantGenerationQueueCancelled({
      projectPath,
      projectId,
      requestId: "request-cancelled",
      reason: "test cancellation",
    });
    const result = await runQuantGenerationQueued({
      projectPath,
      projectId,
      requestId: "request-cancelled",
      instruction: "cancel me",
      task: async () => {
        started = true;
      },
    }).catch((error) => error);

    expect(result).toBeInstanceOf(QuantGenerationCancelledError);
    expect(started).toBe(false);
    const queue = await readQuantGenerationQueue(projectPath, projectId);
    expect(
      queue.items.find((item) => item.requestId === "request-cancelled"),
    ).toMatchObject({
      status: "cancelled",
      errorMessage: "test cancellation",
    });
  });
});
