import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAction: vi.fn(),
  listApprovals: vi.fn(),
}));

vi.mock("@/lib/auth/action", () => ({ requireAction: mocks.requireAction }));
vi.mock("@/lib/services/moagent-tool-approval-store", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/lib/services/moagent-tool-approval-store")
    >();
  return {
    ...actual,
    listMoAgentToolApprovals: mocks.listApprovals,
  };
});

import { GET } from "./route";

const context = {
  params: Promise.resolve({ project_id: "project-a" }),
};

describe("/api/projects/:projectId/agent/approvals", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAction.mockResolvedValue({ actorUserId: "reader-a" });
    mocks.listApprovals.mockResolvedValue([
      { id: "approval-a", runId: "run-a", status: "pending" },
    ]);
  });

  it("lists project-bound pending approvals with bounded query inputs", async () => {
    const response = await GET(
      new Request(
        "http://localhost/api/projects/project-a/agent/approvals?runId=run-a&status=pending&limit=20",
      ),
      context,
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mocks.requireAction).toHaveBeenCalledWith({
      headers: expect.any(Headers),
      action: "project.read",
      projectId: "project-a",
    });
    expect(mocks.listApprovals).toHaveBeenCalledWith({
      projectId: "project-a",
      runId: "run-a",
      status: "pending",
      limit: 20,
    });
    expect(body.data).toEqual([
      { id: "approval-a", runId: "run-a", status: "pending" },
    ]);
  });

  it("rejects unknown statuses without accessing the store", async () => {
    const response = await GET(
      new Request(
        "http://localhost/api/projects/project-a/agent/approvals?status=running",
      ),
      context,
    );

    expect(response.status).toBe(400);
    expect(mocks.listApprovals).not.toHaveBeenCalled();
  });
});
