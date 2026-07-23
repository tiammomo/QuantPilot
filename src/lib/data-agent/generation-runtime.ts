export const DATA_AGENT_GENERATION_ENVELOPE_SCHEMA_VERSION = 2 as const;

export interface DataAgentGenerationEnvelope<TPayload = unknown> {
  schemaVersion: typeof DATA_AGENT_GENERATION_ENVELOPE_SCHEMA_VERSION;
  kind: "data-agent.generation";
  profileId: string;
  domainPackId: string;
  deliveryPackId: string;
  payload: TPayload;
}

export interface DataAgentGenerationJobInput {
  jobId: string;
  projectId: string;
  requestId: string;
  selectedModel: string | null;
  cliPreference: string | null;
  executionEnvelope: unknown;
}

export interface DataAgentGenerationHandler {
  domainPackId: string;
  execute(job: DataAgentGenerationJobInput): Promise<void>;
}

function boundedIdentifier(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[a-z][a-z0-9._-]{1,127}$/u.test(value)) {
    throw new Error(`${label} must be a stable lowercase identifier.`);
  }
  return value;
}

export function parseDataAgentGenerationEnvelope(
  value: unknown,
): DataAgentGenerationEnvelope {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Data Agent generation envelope must be an object.");
  }
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== DATA_AGENT_GENERATION_ENVELOPE_SCHEMA_VERSION) {
    throw new Error("Unsupported Data Agent generation envelope schema.");
  }
  if (record.kind !== "data-agent.generation") {
    throw new Error("Unsupported Data Agent generation envelope kind.");
  }
  if (!Object.hasOwn(record, "payload")) {
    throw new Error("Data Agent generation envelope payload is required.");
  }
  return {
    schemaVersion: DATA_AGENT_GENERATION_ENVELOPE_SCHEMA_VERSION,
    kind: "data-agent.generation",
    profileId: boundedIdentifier(record.profileId, "profileId"),
    domainPackId: boundedIdentifier(record.domainPackId, "domainPackId"),
    deliveryPackId: boundedIdentifier(record.deliveryPackId, "deliveryPackId"),
    payload: record.payload,
  };
}

export class DataAgentGenerationRuntimeRegistry {
  private readonly handlers = new Map<string, DataAgentGenerationHandler>();

  register(handler: DataAgentGenerationHandler): this {
    const domainPackId = boundedIdentifier(
      handler.domainPackId,
      "domainPackId",
    );
    if (this.handlers.has(domainPackId)) {
      throw new Error(
        `Duplicate Data Agent generation handler: ${domainPackId}`,
      );
    }
    this.handlers.set(domainPackId, handler);
    return this;
  }

  resolve(envelope: DataAgentGenerationEnvelope): DataAgentGenerationHandler {
    const handler = this.handlers.get(envelope.domainPackId);
    if (!handler) {
      throw new Error(
        `No generation handler is registered for ${envelope.domainPackId}.`,
      );
    }
    return handler;
  }

  async execute(job: DataAgentGenerationJobInput): Promise<void> {
    const envelope = parseDataAgentGenerationEnvelope(job.executionEnvelope);
    await this.resolve(envelope).execute({
      ...job,
      executionEnvelope: envelope,
    });
  }
}
