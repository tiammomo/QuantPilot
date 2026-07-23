import { describe, expect, it, vi } from "vitest";

import {
  DataAgentGenerationRuntimeRegistry,
  parseDataAgentGenerationEnvelope,
} from "./generation-runtime";
import { createHash } from 'node:crypto';

const compositionWithoutHash = {
  schemaVersion: 1 as const,
  profile: { id: "sales.studio", version: "1.0.0" },
  domainPacks: [{ id: "sales.analytics", version: "1.0.0" }],
  deliveryPack: { id: "workspace.next-dashboard", version: "1.0.0" },
  capability: { id: "sales.overview" },
};

const envelope = {
  schemaVersion: 3,
  kind: "data-agent.generation",
  composition: {
    ...compositionWithoutHash,
    sha256: `sha256:${createHash('sha256')
      .update(JSON.stringify(compositionWithoutHash), 'utf8')
      .digest('hex')}`,
  },
  scope: {
    schemaVersion: 1,
    consumerId: "sales-studio",
    tenantId: "tenant-1",
    projectId: "project-1",
    workspaceId: "project-1",
    requestId: "request-1",
    agentProfileId: "sales.studio",
    domainPackIds: ["sales.analytics"],
    integrationScopeSha256: `sha256:${"b".repeat(64)}`,
  },
  payload: { objective: "Analyse revenue." },
} as const;

describe("Data Agent generation runtime", () => {
  it("routes a provider-neutral envelope to its domain handler", async () => {
    const execute = vi.fn(async () => undefined);
    const registry = new DataAgentGenerationRuntimeRegistry().register({
      profileId: "sales.studio",
      execute,
    });
    await registry.execute({
      jobId: "job-1",
      projectId: "project-1",
      requestId: "request-1",
      selectedModel: null,
      cliPreference: "moagent",
      executionEnvelope: envelope,
    });
    expect(execute).toHaveBeenCalledOnce();
  });

  it("fails closed for old schemas and unregistered domains", async () => {
    expect(() =>
      parseDataAgentGenerationEnvelope({ ...envelope, schemaVersion: 1 }),
    ).toThrow("Unsupported Data Agent generation envelope schema");
    await expect(
      new DataAgentGenerationRuntimeRegistry().execute({
        jobId: "job-1",
        projectId: "project-1",
        requestId: "request-1",
        selectedModel: null,
        cliPreference: "moagent",
        executionEnvelope: envelope,
      }),
    ).rejects.toThrow("No generation handler is registered");
  });

  it("fails closed when scope and composition identities are incomplete", () => {
    expect(() => parseDataAgentGenerationEnvelope({
      ...envelope,
      scope: { ...envelope.scope, integrationScopeSha256: "unsigned" },
    })).toThrow("scope.integrationScopeSha256 must be a SHA-256 identity");
    expect(() => parseDataAgentGenerationEnvelope({
      ...envelope,
      composition: { ...envelope.composition, domainPacks: [] },
    })).toThrow("must contain at least one Domain Pack");
    expect(() => parseDataAgentGenerationEnvelope({
      ...envelope,
      composition: {
        ...envelope.composition,
        capability: { id: 'sales.changed' },
      },
    })).toThrow('composition.sha256 does not match');
  });
});
