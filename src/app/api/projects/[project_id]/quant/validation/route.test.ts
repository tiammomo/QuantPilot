import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getProjectById: vi.fn(),
  readGenerationState: vi.fn(),
  updateGenerationStep: vi.fn(),
  startPreview: vi.fn(),
  stopPreview: vi.fn(),
  publish: vi.fn(),
  prepareValidation: vi.fn(),
  validateProject: vi.fn(),
  readReport: vi.fn(),
  readRepairPlan: vi.fn(),
  readMission: vi.fn(),
  readAcceptanceSnapshot: vi.fn(),
  markRepairing: vi.fn(),
  assertRequestBinding: vi.fn(),
  captureCandidate: vi.fn(),
  sealCandidate: vi.fn(),
  claimVerification: vi.fn(),
  verifyEvidence: vi.fn(),
}));

vi.mock("@/lib/services/project", () => ({
  getProjectById: mocks.getProjectById,
}));

vi.mock("@/lib/quant/generation-state", () => ({
  readQuantGenerationState: mocks.readGenerationState,
  updateQuantGenerationStep: mocks.updateGenerationStep,
}));

vi.mock("@/lib/quant/generation-preview", () => ({
  startPersistentValidatedPreview: mocks.startPreview,
}));

vi.mock("@/lib/services/preview", () => ({
  previewManager: { stop: mocks.stopPreview },
}));

vi.mock("@/lib/services/stream", () => ({
  streamManager: { publish: mocks.publish },
}));

vi.mock("@/lib/quant/validation", () => ({
  prepareQuantProjectForValidation: mocks.prepareValidation,
  validateQuantProject: mocks.validateProject,
  readQuantValidationReport: mocks.readReport,
  readQuantValidationRepairPlan: mocks.readRepairPlan,
}));

vi.mock("@/lib/services/moagent-mission-control", () => ({
  capturePlatformMissionCandidate: mocks.captureCandidate,
  sealQuantMoAgentMissionCandidate: mocks.sealCandidate,
  claimQuantMoAgentMissionVerification: mocks.claimVerification,
  verifyAndRecordQuantMoAgentMission: mocks.verifyEvidence,
}));

vi.mock("@/lib/services/moagent-mission-store", () => {
  class MoAgentMissionStateError extends Error {
    constructor(
      readonly code: string,
      message: string,
    ) {
      super(message);
      this.name = "MoAgentMissionStateError";
    }
  }
  return {
    MoAgentMissionStateError,
    readMoAgentMission: mocks.readMission,
    readMoAgentAcceptedMissionSnapshot: mocks.readAcceptanceSnapshot,
    markMoAgentMissionRepairing: mocks.markRepairing,
  };
});

vi.mock("@/lib/services/user-requests", () => {
  class UserRequestProjectMismatchError extends Error {
    constructor(readonly requestId: string) {
      super("The request ID is already bound to a different project.");
      this.name = "UserRequestProjectMismatchError";
    }
  }
  return {
    UserRequestProjectMismatchError,
    assertUserRequestProjectBinding: mocks.assertRequestBinding,
  };
});

import { GET, POST } from "./route";

const projectId = "project-1";
const requestId = "request-1";
const projectPath = "/tmp/project-1";
const context = { params: Promise.resolve({ project_id: projectId }) };

function mission(status = "running") {
  return {
    id: "mission-1",
    generationId: "generation-1",
    projectId,
    requestId,
    status,
    version: 1,
    candidateVersion: status === "running" ? 0 : 1,
    specHash: `sha256:${"a".repeat(64)}`,
    acceptedReceiptId: status === "completed" ? "receipt-acceptance" : null,
  };
}

function validationReport(passed: boolean) {
  return {
    schemaVersion: 1,
    runId: requestId,
    status: passed ? "passed" : "failed",
    passed,
    projectId,
    reportPath: ".quantpilot/validation.json",
    checks: passed
      ? [{ id: "next_build", name: "Build", status: "passed", summary: "ok" }]
      : [
          {
            id: "next_build",
            name: "Build",
            status: "failed",
            summary: "broken",
          },
        ],
    createdAt: "2026-07-15T00:00:00.000Z",
    updatedAt: "2026-07-15T00:00:01.000Z",
  };
}

function evidence(verdict = "accepted") {
  const accepted = verdict === "accepted";
  const receiptId = accepted ? "receipt-acceptance" : "receipt-validation";
  return {
    mission: {
      ...mission(
        accepted
          ? "completed"
          : verdict === "repair_required"
            ? "repair_required"
            : "candidate_complete",
      ),
      candidateVersion: 1,
      acceptedReceiptId: accepted ? receiptId : null,
      projectPath,
    },
    decision: {
      verdict,
      reasonCodes: accepted ? [] : ["EVIDENCE_NOT_ACCEPTED"],
      failedCheckIds: accepted ? [] : ["next_build"],
      candidateVersion: 1,
    },
    receipt: {
      id: receiptId,
      missionId: "mission-1",
      generationId: "generation-1",
      candidateVersion: 1,
      receiptType: accepted ? "acceptance" : "validation",
      verdict,
      subjectHash: `sha256:${"b".repeat(64)}`,
      receiptHash: `sha256:${"c".repeat(64)}`,
      createdAt: "2026-07-15T00:00:02.000Z",
    },
  };
}

function postRequest(body: Record<string, unknown> = { requestId }) {
  return new Request("http://localhost/api/quant/validation", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }) as never;
}

describe("Mission-backed manual quant validation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getProjectById.mockResolvedValue({
      id: projectId,
      repoPath: projectPath,
    });
    mocks.readGenerationState.mockResolvedValue({ requestId });
    mocks.updateGenerationStep.mockResolvedValue(undefined);
    mocks.readMission.mockResolvedValue(mission("candidate_complete"));
    mocks.readAcceptanceSnapshot.mockResolvedValue(null);
    mocks.markRepairing.mockResolvedValue(mission("repairing"));
    mocks.assertRequestBinding.mockResolvedValue(true);
    mocks.prepareValidation.mockResolvedValue(projectPath);
    mocks.captureCandidate.mockResolvedValue({
      schemaVersion: 1,
      source: "workspace_recovery",
      sourceRunId: null,
      sourceRequestId: requestId,
      workspaceSha256: `sha256:${"d".repeat(64)}`,
      summarySha256: `sha256:${"e".repeat(64)}`,
      declaredArtifacts: [],
      verifiedArtifacts: [],
      submittedAt: "2026-07-15T00:00:00.000Z",
    });
    mocks.sealCandidate.mockResolvedValue({
      mission: { ...mission("candidate_complete"), projectPath },
      receipt: { id: "receipt-candidate" },
    });
    mocks.claimVerification.mockResolvedValue({
      ...mission("verifying"),
      projectPath,
    });
    mocks.validateProject.mockResolvedValue(validationReport(true));
    mocks.readReport.mockResolvedValue(validationReport(true));
    mocks.readRepairPlan.mockResolvedValue(null);
    mocks.startPreview.mockResolvedValue({
      url: "http://127.0.0.1:4100",
      port: 4100,
      status: "running",
    });
    mocks.stopPreview.mockResolvedValue({
      status: "stopped",
      url: null,
      port: null,
    });
    mocks.verifyEvidence.mockResolvedValue(evidence("accepted"));
  });

  it("runs prepare → candidate → validation → preview → EvidenceVerifier before publishing ready", async () => {
    const response = await POST(postRequest(), context);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      success: true,
      preview: { url: "http://127.0.0.1:4100", port: 4100 },
      acceptance: {
        required: true,
        satisfied: true,
        verdict: "accepted",
        receiptId: "receipt-acceptance",
      },
    });
    expect(mocks.prepareValidation).toHaveBeenCalledWith({
      projectId,
      projectPath,
    });
    expect(mocks.captureCandidate).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "workspace_recovery",
        mission: expect.objectContaining({ status: "candidate_complete" }),
      }),
    );
    expect(mocks.verifyEvidence).toHaveBeenCalledWith({
      mission: expect.objectContaining({ status: "verifying" }),
      preview: { url: "http://127.0.0.1:4100", port: 4100 },
    });
    expect(mocks.publish).toHaveBeenCalledWith(
      projectId,
      expect.objectContaining({
        data: expect.objectContaining({ status: "preview_ready" }),
      }),
    );

    const order = [
      mocks.prepareValidation,
      mocks.captureCandidate,
      mocks.sealCandidate,
      mocks.claimVerification,
      mocks.validateProject,
      mocks.startPreview,
      mocks.verifyEvidence,
      mocks.publish,
    ].map((mock) => mock.mock.invocationCallOrder[0]);
    expect(order).toEqual([...order].sort((left, right) => left - right));
  });

  it("persists a failed validation evidence decision without starting or publishing preview", async () => {
    mocks.validateProject.mockResolvedValue(validationReport(false));
    mocks.verifyEvidence.mockResolvedValue(evidence("repair_required"));

    const response = await POST(postRequest(), context);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      data: { passed: false },
      preview: null,
      acceptance: { satisfied: false, verdict: "repair_required" },
    });
    expect(mocks.startPreview).not.toHaveBeenCalled();
    expect(mocks.verifyEvidence).toHaveBeenCalledWith(
      expect.objectContaining({
        preview: { url: "http://127.0.0.1:1", port: 1 },
      }),
    );
    expect(mocks.publish).not.toHaveBeenCalledWith(
      projectId,
      expect.objectContaining({
        data: expect.objectContaining({ status: "preview_ready" }),
      }),
    );
  });

  it("stops and hides a provisional preview when evidence is not accepted", async () => {
    mocks.verifyEvidence.mockResolvedValue(evidence("retry_infrastructure"));

    const response = await POST(postRequest(), context);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      data: { passed: true },
      preview: null,
      acceptance: { satisfied: false, verdict: "retry_infrastructure" },
    });
    expect(mocks.stopPreview).toHaveBeenCalledWith(projectId);
    expect(mocks.publish).not.toHaveBeenCalled();
  });

  it("prepares before claiming repair and sealing a workspace recovery candidate", async () => {
    mocks.readMission.mockResolvedValue(mission("repair_required"));

    const response = await POST(postRequest(), context);

    expect(response.status).toBe(200);
    expect(mocks.markRepairing).toHaveBeenCalledWith({
      missionId: "mission-1",
      projectId,
      requestId,
    });
    expect(mocks.captureCandidate).toHaveBeenCalledWith(
      expect.objectContaining({
        mission: expect.objectContaining({ status: "repairing" }),
      }),
    );
    expect(mocks.prepareValidation.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.markRepairing.mock.invocationCallOrder[0],
    );
    expect(mocks.markRepairing.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.captureCandidate.mock.invocationCallOrder[0],
    );
  });

  it.each(["completed", "failed", "cancelled"])(
    "rejects a %s Mission without rewriting validation evidence",
    async (status) => {
      mocks.readMission.mockResolvedValue(mission(status));
      if (status === "completed") {
        mocks.readAcceptanceSnapshot.mockResolvedValue({
          missionId: "mission-1",
          missionStatus: "completed",
          acceptedReceiptId: "receipt-acceptance",
        });
      }

      const response = await POST(postRequest(), context);
      const body = await response.json();

      expect(response.status).toBe(409);
      expect(body.code).toBe(
        status === "completed"
          ? "MISSION_REVALIDATION_REQUIRES_NEW_REQUEST"
          : "MISSION_TERMINAL",
      );
      if (status === "completed") {
        expect(mocks.readAcceptanceSnapshot).toHaveBeenCalledWith(
          projectId,
          requestId,
        );
        expect(body.acceptance).toMatchObject({
          missionStatus: "completed",
          acceptedReceiptId: "receipt-acceptance",
        });
      }
      expect(mocks.prepareValidation).not.toHaveBeenCalled();
      expect(mocks.validateProject).not.toHaveBeenCalled();
      expect(mocks.verifyEvidence).not.toHaveBeenCalled();
      expect(mocks.updateGenerationStep).not.toHaveBeenCalled();
    },
  );

  it.each(["running", "repairing", "verifying"])(
    "rejects a busy %s Mission before reading or sealing its workspace",
    async (status) => {
      mocks.readMission.mockResolvedValue(mission(status));

      const response = await POST(postRequest(), context);
      const body = await response.json();

      expect(response.status).toBe(409);
      expect(body.code).toBe("MISSION_BUSY");
      expect(mocks.prepareValidation).not.toHaveBeenCalled();
      expect(mocks.captureCandidate).not.toHaveBeenCalled();
      expect(mocks.validateProject).not.toHaveBeenCalled();
      expect(mocks.updateGenerationStep).not.toHaveBeenCalled();
    },
  );

  it("uses the current Mission when callers omit requestId instead of falling through legacy validation", async () => {
    const response = await POST(postRequest({}), context);

    expect(response.status).toBe(200);
    expect(mocks.readMission).toHaveBeenCalledWith(projectId, requestId);
    expect(mocks.verifyEvidence).toHaveBeenCalled();
  });

  it("serializes duplicate manual validation and rejects the request that observes committed acceptance", async () => {
    mocks.readMission
      .mockResolvedValueOnce(mission("candidate_complete"))
      .mockResolvedValueOnce(mission("completed"));
    mocks.readAcceptanceSnapshot.mockResolvedValue({
      missionId: "mission-1",
      missionStatus: "completed",
      acceptedReceiptId: "receipt-acceptance",
    });

    const [firstResponse, secondResponse] = await Promise.all([
      POST(postRequest(), context),
      POST(postRequest(), context),
    ]);

    expect(firstResponse.status).toBe(200);
    expect(secondResponse.status).toBe(409);
    expect(mocks.validateProject).toHaveBeenCalledTimes(1);
    expect(mocks.verifyEvidence).toHaveBeenCalledTimes(1);
    expect(mocks.prepareValidation).toHaveBeenCalledTimes(1);
  });

  it("rejects a requestId that does not match the current generation", async () => {
    const response = await POST(
      postRequest({ requestId: "ops-console-request" }),
      context,
    );
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.code).toBe("GENERATION_REQUEST_ID_MISMATCH");
    expect(mocks.readMission).not.toHaveBeenCalled();
    expect(mocks.validateProject).not.toHaveBeenCalled();
  });

  it("rejects a requestId already bound to another project before generation reads or writes", async () => {
    const { UserRequestProjectMismatchError } =
      await import("@/lib/services/user-requests");
    mocks.assertRequestBinding.mockRejectedValue(
      new UserRequestProjectMismatchError("foreign-request"),
    );

    const response = await POST(
      postRequest({ requestId: "foreign-request" }),
      context,
    );
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.code).toBe("REQUEST_PROJECT_MISMATCH");
    expect(mocks.readGenerationState).not.toHaveBeenCalled();
    expect(mocks.readMission).not.toHaveBeenCalled();
    expect(mocks.prepareValidation).not.toHaveBeenCalled();
    expect(mocks.validateProject).not.toHaveBeenCalled();
  });

  it("rejects a fabricated requestId before generation reads or writes", async () => {
    mocks.assertRequestBinding.mockResolvedValue(false);

    const response = await POST(
      postRequest({ requestId: "missing-request" }),
      context,
    );
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body.code).toBe("REQUEST_NOT_FOUND");
    expect(mocks.readGenerationState).not.toHaveBeenCalled();
    expect(mocks.readMission).not.toHaveBeenCalled();
    expect(mocks.updateGenerationStep).not.toHaveBeenCalled();
    expect(mocks.validateProject).not.toHaveBeenCalled();
  });

  it("keeps legacy manual validation compatible when no Mission exists", async () => {
    mocks.readGenerationState.mockResolvedValue(null);
    mocks.readMission.mockResolvedValue(null);

    const response = await POST(postRequest({}), context);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      success: true,
      data: { passed: true },
      preview: { url: "http://127.0.0.1:4100", port: 4100 },
    });
    expect(body.acceptance).toBeUndefined();
    expect(mocks.prepareValidation).not.toHaveBeenCalled();
    expect(mocks.captureCandidate).not.toHaveBeenCalled();
    expect(mocks.verifyEvidence).not.toHaveBeenCalled();
    expect(mocks.publish).toHaveBeenCalledWith(
      projectId,
      expect.objectContaining({
        data: expect.objectContaining({ status: "preview_ready" }),
      }),
    );
  });

  it("attaches the current request acceptance snapshot to GET", async () => {
    const snapshot = {
      missionId: "mission-1",
      missionStatus: "completed",
      acceptedReceiptId: "receipt-acceptance",
    };
    mocks.readAcceptanceSnapshot.mockResolvedValue(snapshot);

    const response = await GET(
      new Request("http://localhost") as never,
      context,
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mocks.readAcceptanceSnapshot).toHaveBeenCalledWith(
      projectId,
      requestId,
    );
    expect(body.acceptance).toEqual(snapshot);
  });
});
