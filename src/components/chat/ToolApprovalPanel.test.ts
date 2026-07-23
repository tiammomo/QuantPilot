import { describe, expect, it } from "vitest";

import { parsePendingToolApprovals } from "./ToolApprovalPanel";

describe("ToolApprovalPanel contract parser", () => {
  it("accepts pending mutating-tool approvals only", () => {
    expect(
      parsePendingToolApprovals([
        {
          id: "approval_123456789012",
          runId: "run_1",
          toolName: "publish_report",
          effect: "external_write",
          publicInput: { reportId: "report_1" },
          reason: "将报告发布到外部系统",
          allowedDecisions: ["approve", "edit", "reject"],
          status: "pending",
          requestedAt: "2026-07-24T00:00:00.000Z",
          expiresAt: "2026-07-24T00:10:00.000Z",
        },
      ]),
    ).toHaveLength(1);
  });

  it("rejects resolved, read-only, or malformed approval records", () => {
    expect(
      parsePendingToolApprovals([
        {
          id: "approval_123456789012",
          runId: "run_1",
          toolName: "read_report",
          effect: "read",
          publicInput: {},
          reason: "read",
          allowedDecisions: ["approve", "reject"],
          status: "pending",
          requestedAt: "2026-07-24T00:00:00.000Z",
          expiresAt: "2026-07-24T00:10:00.000Z",
        },
        {
          id: "approval_123456789013",
          runId: "run_1",
          toolName: "publish_report",
          effect: "external_write",
          publicInput: {},
          reason: "publish",
          allowedDecisions: ["approve", "reject"],
          status: "approved",
          requestedAt: "2026-07-24T00:00:00.000Z",
          expiresAt: "2026-07-24T00:10:00.000Z",
        },
      ]),
    ).toEqual([]);
  });
});
