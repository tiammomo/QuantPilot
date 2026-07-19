import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  enqueue: vi.fn(),
  claim: vi.fn(),
  heartbeat: vi.fn(),
}));

vi.mock("@/lib/services/moagent-generation-dispatch-store", () => ({
  enqueueMoAgentGenerationJob: mocks.enqueue,
  claimMoAgentGenerationJob: mocks.claim,
  heartbeatMoAgentGenerationJob: mocks.heartbeat,
}));

import {
  currentMoAgentGenerationDispatchFence,
  currentMoAgentGenerationDispatchSession,
  MoAgentGenerationDispatchSession,
} from "./moagent-generation-dispatch-session";

const claim = {
  jobId: "5e780f87-94f0-43a3-9659-675ab70c62c5",
  projectId: "project-dispatch-session",
  requestId: "request-dispatch-session",
  leaseOwner: "generation-dispatcher:test",
  fencingToken: 7,
  attemptCount: 1,
  leaseExpiresAt: "2026-07-19T07:02:00.000Z",
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  mocks.enqueue.mockResolvedValue({ id: claim.jobId });
  mocks.claim.mockResolvedValue(claim);
  mocks.heartbeat.mockResolvedValue({
    leaseExpiresAt: "2026-07-19T07:02:30.000Z",
  });
});

afterEach(() => {
  vi.useRealTimers();
});

async function createSession(heartbeatEnabled = true) {
  return MoAgentGenerationDispatchSession.enqueueAndClaim(
    {
      projectId: claim.projectId,
      requestId: claim.requestId,
      instruction: "Persist and claim this generation.",
      executionEnvelope: {
        schemaVersion: 1,
        recoveryMode: "replan_required",
      },
    },
    {
      leaseOwner: claim.leaseOwner,
      leaseTtlMs: 120_000,
      heartbeatIntervalMs: 30_000,
      heartbeatEnabled,
    },
  );
}

describe("MoAgent generation dispatch session", () => {
  it("persists the job before claiming and exposes its fence only inside the task context", async () => {
    const session = await createSession(false);

    expect(mocks.enqueue.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.claim.mock.invocationCallOrder[0],
    );
    expect(currentMoAgentGenerationDispatchFence()).toBeUndefined();
    await session.run(async () => {
      expect(currentMoAgentGenerationDispatchSession()).toBe(session);
      expect(currentMoAgentGenerationDispatchFence()).toEqual({
        jobId: claim.jobId,
        projectId: claim.projectId,
        requestId: claim.requestId,
        leaseOwner: claim.leaseOwner,
        fencingToken: claim.fencingToken,
      });
    });
    expect(currentMoAgentGenerationDispatchFence()).toBeUndefined();
    session.settle();
  });

  it("captures heartbeat ownership loss and fails closed", async () => {
    mocks.heartbeat.mockRejectedValueOnce(new Error("dispatch lease lost"));
    const session = await createSession();

    await vi.advanceTimersByTimeAsync(30_000);

    expect(session.failure?.message).toBe("dispatch lease lost");
    expect(() => session.assertHealthy()).toThrow("dispatch lease lost");
    session.dispose();
  });
});
