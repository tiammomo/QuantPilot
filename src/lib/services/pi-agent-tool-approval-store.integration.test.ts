import { createHash, randomUUID } from "node:crypto";

import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { PiAgentToolApprovalRequest } from "@/lib/agent/types";
import {
  createPrismaPiAgentToolApprovalHandler,
  listPiAgentToolApprovals,
  resolvePiAgentToolApproval,
} from "./pi-agent-tool-approval-store";

const TEST_DATABASE_URL = process.env.PI_AGENT_TEST_DATABASE_URL?.trim();
const TEST_SCOPE = `approval_pg_it_${randomUUID().replaceAll("-", "")}`;

describe.skipIf(!TEST_DATABASE_URL)(
  "PI Agent tool approval store (PostgreSQL integration)",
  () => {
    let client: PrismaClient;
    let sequence = 0;
    const projectIds = new Set<string>();

    function uniqueId(label: string): string {
      sequence += 1;
      return `${TEST_SCOPE}:${label}:${sequence}`;
    }

    function workspaceKey(label: string): string {
      return `sha256:${createHash("sha256")
        .update(`${TEST_SCOPE}:${label}`)
        .digest("hex")}`;
    }

    async function createWaitingRun(label: string) {
      const projectId = uniqueId(`project:${label}`);
      const runId = uniqueId(`run:${label}`);
      await client.project.create({
        data: { id: projectId, name: `Approval integration: ${label}` },
      });
      projectIds.add(projectId);
      await client.agentRun.create({
        data: {
          id: runId,
          projectId,
          workspaceKey: workspaceKey(label),
          status: "waiting",
          provider: "openai",
          model: "integration-test",
          frameworkVersion: "pi-agent:integration-test",
          buildRevision: "test:approval-store",
          profileHash: "sha256:profile",
          promptHash: "sha256:prompt",
          toolHash: "sha256:tool",
          skillHash: "sha256:skill",
          workspaceHash: "sha256:workspace",
          startedAt: new Date(),
        },
      });
      return { projectId, runId };
    }

    function request(
      runId: string,
      label: string,
    ): PiAgentToolApprovalRequest {
      const now = Date.now();
      return {
        approvalId: `approval_${label.padEnd(12, "0")}`,
        runId,
        turn: 1,
        toolCallId: `call:${label}`,
        toolName: "publish_report",
        effect: "external_write",
        idempotency: "operation_key",
        inputSha256: "a".repeat(64),
        publicInput: { reportId: label },
        reason: "Publish the reviewed report.",
        allowedDecisions: ["approve", "edit", "reject"],
        requestedAt: now,
        expiresAt: now + 60_000,
      };
    }

    async function waitUntilStored(approvalId: string): Promise<void> {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if (
          await client.agentToolApproval.findUnique({
            where: { id: approvalId },
            select: { id: true },
          })
        ) {
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error(`Approval ${approvalId} was not stored in time.`);
    }

    beforeAll(async () => {
      client = new PrismaClient({ datasourceUrl: TEST_DATABASE_URL! });
      await client.$connect();
    });

    afterAll(async () => {
      try {
        if (projectIds.size > 0) {
          await client.project.deleteMany({
            where: { id: { in: [...projectIds] } },
          });
        }
      } finally {
        await client.$disconnect();
      }
    });

    it("persists a decision and releases the waiting handler", async () => {
      const { projectId, runId } = await createWaitingRun("approve");
      const approval = request(runId, "approve");
      const controller = new AbortController();
      const resolution = createPrismaPiAgentToolApprovalHandler(10)(
        approval,
        { signal: controller.signal },
      );
      try {
        await waitUntilStored(approval.approvalId);
        await expect(
          resolvePiAgentToolApproval({
            projectId,
            approvalId: approval.approvalId,
            actorId: "integration-reviewer",
            decision: "approve",
          }),
        ).resolves.toMatchObject({
          status: "approved",
          decision: "approve",
        });
        await expect(resolution).resolves.toEqual({
          decision: "approve",
          resolvedBy: "integration-reviewer",
        });
      } finally {
        controller.abort();
      }
    });

    it("expires pending decisions when their run leaves waiting", async () => {
      const { projectId, runId } = await createWaitingRun("stale");
      const approval = request(runId, "stale");
      const controller = new AbortController();
      const resolution = createPrismaPiAgentToolApprovalHandler(10)(
        approval,
        { signal: controller.signal },
      );
      try {
        await waitUntilStored(approval.approvalId);
        await client.agentRun.update({
          where: { id: runId },
          data: {
            status: "interrupted",
            errorCode: "REPLAN_REQUIRED",
            finishedAt: new Date(),
          },
        });
        await expect(
          listPiAgentToolApprovals({
            projectId,
            status: "expired",
          }),
        ).resolves.toEqual([
          expect.objectContaining({
            id: approval.approvalId,
            status: "expired",
          }),
        ]);
        await expect(resolution).resolves.toEqual({
          decision: "reject",
          resolvedBy: "expired",
        });
      } finally {
        controller.abort();
      }
    });
  },
);
