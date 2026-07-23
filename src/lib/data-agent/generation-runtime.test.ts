import { describe, expect, it, vi } from "vitest";

import {
  DataAgentGenerationRuntimeRegistry,
  parseDataAgentGenerationEnvelope,
} from "./generation-runtime";

const envelope = {
  schemaVersion: 2,
  kind: "data-agent.generation",
  profileId: "sales.studio",
  domainPackId: "sales.analytics",
  deliveryPackId: "workspace.next-dashboard",
  payload: { objective: "Analyse revenue." },
} as const;

describe("Data Agent generation runtime", () => {
  it("routes a provider-neutral envelope to its domain handler", async () => {
    const execute = vi.fn(async () => undefined);
    const registry = new DataAgentGenerationRuntimeRegistry().register({
      domainPackId: "sales.analytics",
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
});
