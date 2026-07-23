import { createHash } from 'node:crypto';

import type {
  DataAgentCompositionLock,
  DataAgentScopeEnvelope,
} from './contracts';

export const DATA_AGENT_GENERATION_ENVELOPE_SCHEMA_VERSION = 3 as const;

export interface DataAgentGenerationEnvelope<TPayload = unknown> {
  schemaVersion: typeof DATA_AGENT_GENERATION_ENVELOPE_SCHEMA_VERSION;
  kind: "data-agent.generation";
  composition: DataAgentCompositionLock;
  scope: DataAgentScopeEnvelope;
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
  profileId: string;
  execute(job: DataAgentGenerationJobInput): Promise<void>;
}

function boundedIdentifier(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[a-z][a-z0-9._-]{1,127}$/u.test(value)) {
    throw new Error(`${label} must be a stable lowercase identifier.`);
  }
  return value;
}

function boundedScopeIdentifier(value: unknown, label: string): string {
  if (
    typeof value !== "string"
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u.test(value)
  ) {
    throw new Error(`${label} must be a bounded scope identifier.`);
  }
  return value;
}

function semanticVersion(value: unknown, label: string): string {
  if (
    typeof value !== 'string'
    || !/^\d+\.\d+\.\d+(?:-[0-9a-z.-]+)?$/iu.test(value)
  ) {
    throw new Error(`${label} must be a semantic version.`);
  }
  return value;
}

function sha256(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(value)) {
    throw new Error(`${label} must be a SHA-256 identity.`);
  }
  return value;
}

function objectRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function parseComposition(value: unknown): DataAgentCompositionLock {
  const composition = objectRecord(value, 'composition');
  if (composition.schemaVersion !== 1) {
    throw new Error('Unsupported Data Agent composition lock schema.');
  }
  const profile = objectRecord(composition.profile, 'composition.profile');
  const deliveryPack = objectRecord(
    composition.deliveryPack,
    'composition.deliveryPack',
  );
  const capability = objectRecord(composition.capability, 'composition.capability');
  if (!Array.isArray(composition.domainPacks) || composition.domainPacks.length === 0) {
    throw new Error('composition.domainPacks must contain at least one Domain Pack.');
  }
  const domainPacks = composition.domainPacks.map((value, index) => {
    const pack = objectRecord(value, `composition.domainPacks[${index}]`);
    return {
      id: boundedIdentifier(pack.id, `composition.domainPacks[${index}].id`),
      version: semanticVersion(
        pack.version,
        `composition.domainPacks[${index}].version`,
      ),
    };
  });
  if (new Set(domainPacks.map((pack) => pack.id)).size !== domainPacks.length) {
    throw new Error('composition.domainPacks contains duplicate IDs.');
  }
  const parsed = {
    schemaVersion: 1 as const,
    profile: {
      id: boundedIdentifier(profile.id, 'composition.profile.id'),
      version: semanticVersion(profile.version, 'composition.profile.version'),
    },
    domainPacks,
    deliveryPack: {
      id: boundedIdentifier(deliveryPack.id, 'composition.deliveryPack.id'),
      version: semanticVersion(
        deliveryPack.version,
        'composition.deliveryPack.version',
      ),
    },
    capability: {
      id: boundedIdentifier(capability.id, 'composition.capability.id'),
    },
  };
  const expectedSha256 = `sha256:${createHash('sha256')
    .update(JSON.stringify(parsed), 'utf8')
    .digest('hex')}`;
  const claimedSha256 = sha256(composition.sha256, 'composition.sha256');
  if (claimedSha256 !== expectedSha256) {
    throw new Error('composition.sha256 does not match the composition contents.');
  }
  return {
    ...parsed,
    sha256: claimedSha256,
  };
}

function parseScope(value: unknown): DataAgentScopeEnvelope {
  const scope = objectRecord(value, 'scope');
  if (scope.schemaVersion !== 1) {
    throw new Error('Unsupported Data Agent scope schema.');
  }
  if (!Array.isArray(scope.domainPackIds) || scope.domainPackIds.length === 0) {
    throw new Error('scope.domainPackIds must contain at least one Domain Pack.');
  }
  const domainPackIds = scope.domainPackIds.map((id, index) => (
    boundedIdentifier(id, `scope.domainPackIds[${index}]`)
  ));
  if (new Set(domainPackIds).size !== domainPackIds.length) {
    throw new Error('scope.domainPackIds contains duplicate IDs.');
  }
  return {
    schemaVersion: 1,
    consumerId: boundedScopeIdentifier(scope.consumerId, 'scope.consumerId'),
    tenantId: boundedScopeIdentifier(scope.tenantId, 'scope.tenantId'),
    projectId: boundedScopeIdentifier(scope.projectId, 'scope.projectId'),
    workspaceId: boundedScopeIdentifier(scope.workspaceId, 'scope.workspaceId'),
    requestId: boundedScopeIdentifier(scope.requestId, 'scope.requestId'),
    agentProfileId: boundedIdentifier(
      scope.agentProfileId,
      'scope.agentProfileId',
    ),
    domainPackIds,
    integrationScopeSha256: sha256(
      scope.integrationScopeSha256,
      'scope.integrationScopeSha256',
    ),
  };
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
    composition: parseComposition(record.composition),
    scope: parseScope(record.scope),
    payload: record.payload,
  };
}

export class DataAgentGenerationRuntimeRegistry {
  private readonly handlers = new Map<string, DataAgentGenerationHandler>();

  register(handler: DataAgentGenerationHandler): this {
    const profileId = boundedIdentifier(
      handler.profileId,
      "profileId",
    );
    if (this.handlers.has(profileId)) {
      throw new Error(
        `Duplicate Data Agent generation handler: ${profileId}`,
      );
    }
    this.handlers.set(profileId, handler);
    return this;
  }

  resolve(envelope: DataAgentGenerationEnvelope): DataAgentGenerationHandler {
    const handler = this.handlers.get(envelope.composition.profile.id);
    if (!handler) {
      throw new Error(
        `No generation handler is registered for ${envelope.composition.profile.id}.`,
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
