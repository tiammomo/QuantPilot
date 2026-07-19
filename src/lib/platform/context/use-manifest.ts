import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import type {
  GovernedKnowledgeCapsule,
  KnowledgeUsageResult,
} from '@/lib/platform/knowledge/types';
import type { PersonalizationCapsule } from '@/lib/platform/memory/types';
import {
  getProjectIntegrationScope,
  type ProjectIntegrationScope,
} from './integration-scope';

const SCHEMA_VERSION = 2 as const;
const MEMORY_PROVIDER = 'evolvable-memory-http-v1' as const;
const KNOWLEDGE_PROVIDER = 'akep-http-v0.1' as const;

interface MemoryContextUse {
  provider: typeof MEMORY_PROVIDER;
  usageId: string;
  traceId: string;
  revisionIds: string[];
  sourceProjectionSha256: string;
  deliveredContextSha256: string;
}

interface KnowledgeContextUse {
  provider: typeof KNOWLEDGE_PROVIDER;
  contextPackId: string;
  exposureReceiptId: string;
  contextDigest: string;
  policyEpoch: string;
  citationIds: string[];
  revisionIds: string[];
  spaceIds: string[];
  usage: KnowledgeUsageResult | null;
}

interface AcceptedMissionUse {
  missionId: string;
  acceptedReceiptId: string;
  acceptedReceiptSha256: string;
}

interface IntegrationScopeUse {
  consumerId: string;
  memoryTenantId: string;
  projectId: string;
  scopeSha256: string;
  modelPort: ProjectIntegrationScope['modelPort'];
  requestedKnowledgeSpaceIds: string[];
  projectKnowledgeSpaceId: string | null;
}

export interface ContextUseManifest {
  schemaVersion: typeof SCHEMA_VERSION;
  projectId: string;
  requestId: string;
  integrationScope: IntegrationScopeUse;
  memory: MemoryContextUse | null;
  knowledge: KnowledgeContextUse | null;
  acceptedMission: AcceptedMissionUse | null;
  createdAt: string;
  updatedAt: string;
}

function safeRequestId(value: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 160 || !/^[A-Za-z0-9._:-]+$/.test(normalized)) {
    throw new Error('Context use manifest request ID is invalid.');
  }
  return normalized;
}

function manifestPath(projectPath: string, requestId: string): string {
  return path.join(projectPath, 'evidence', 'context-uses', `${safeRequestId(requestId)}.json`);
}

function stableUnique(values: string[]): string[] {
  return [...new Set(values)].sort();
}

function integrationScopeUse(scope: ProjectIntegrationScope, projectId: string): IntegrationScopeUse {
  if (scope.projectId !== projectId) {
    throw new Error('Context use integration scope does not match the workspace project.');
  }
  return {
    consumerId: scope.consumerId,
    memoryTenantId: scope.memory.tenantId,
    projectId: scope.projectId,
    scopeSha256: scope.scopeSha256,
    modelPort: scope.modelPort,
    requestedKnowledgeSpaceIds: stableUnique(scope.knowledge.requestedSpaceIds),
    projectKnowledgeSpaceId: scope.knowledge.projectSpaceId,
  };
}

function memoryUse(capsule: PersonalizationCapsule | null): MemoryContextUse | null {
  if (!capsule) return null;
  if (!capsule.usageId) {
    throw new Error('Exposed personal memory is missing its provider usage receipt.');
  }
  return {
    provider: MEMORY_PROVIDER,
    usageId: capsule.usageId,
    traceId: capsule.traceId,
    revisionIds: stableUnique(capsule.revisionIds),
    sourceProjectionSha256: capsule.sourceProjectionSha256,
    deliveredContextSha256: capsule.contentSha256,
  };
}

function knowledgeUse(capsule: GovernedKnowledgeCapsule | null): KnowledgeContextUse | null {
  if (!capsule) return null;
  return {
    provider: KNOWLEDGE_PROVIDER,
    contextPackId: capsule.contextPackId,
    exposureReceiptId: capsule.exposureReceiptId,
    contextDigest: capsule.contextDigest,
    policyEpoch: capsule.policyEpoch,
    citationIds: stableUnique(capsule.citations.map((citation) => citation.citationId)),
    revisionIds: stableUnique(capsule.citations.map((citation) => citation.revisionId)),
    spaceIds: stableUnique(capsule.citations.map((citation) => citation.spaceId)),
    usage: null,
  };
}

async function readManifest(
  projectPath: string,
  projectId: string,
  requestId: string,
  integrationScope: IntegrationScopeUse,
): Promise<ContextUseManifest | null> {
  let raw: string;
  try {
    raw = await fs.readFile(manifestPath(projectPath, requestId), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  const parsed = JSON.parse(raw) as Partial<Omit<ContextUseManifest, 'schemaVersion'>> & {
    schemaVersion?: number;
  };
  if (
    parsed.schemaVersion === 1
    && parsed.projectId === projectId
    && parsed.requestId === requestId
  ) {
    return {
      ...(parsed as Omit<ContextUseManifest, 'schemaVersion' | 'integrationScope'>),
      schemaVersion: SCHEMA_VERSION,
      integrationScope,
    };
  }
  if (
    parsed.schemaVersion !== SCHEMA_VERSION
    || parsed.projectId !== projectId
    || parsed.requestId !== requestId
    || !sameValue(parsed.integrationScope, integrationScope)
  ) {
    throw new Error('Context use manifest scope or schema does not match.');
  }
  return parsed as ContextUseManifest;
}

async function writeManifest(projectPath: string, manifest: ContextUseManifest): Promise<void> {
  const target = manifestPath(projectPath, manifest.requestId);
  const directory = path.dirname(target);
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  await fs.mkdir(directory, { recursive: true });
  try {
    await fs.writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    await fs.rename(temporary, target);
  } catch (error) {
    await fs.unlink(temporary).catch(() => undefined);
    throw error;
  }
}

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export async function recordContextExposure(input: {
  projectPath: string;
  projectId: string;
  requestId: string;
  integrationScope: ProjectIntegrationScope;
  memory: PersonalizationCapsule | null;
  knowledge: GovernedKnowledgeCapsule | null;
}): Promise<boolean> {
  const requestId = safeRequestId(input.requestId);
  const memory = memoryUse(input.memory);
  const knowledge = knowledgeUse(input.knowledge);
  const integrationScope = integrationScopeUse(input.integrationScope, input.projectId);
  if (
    input.knowledge
    && (
      input.knowledge.integrationScopeSha256 !== integrationScope.scopeSha256
      || !sameValue(
        stableUnique(input.knowledge.requestedSpaceIds),
        integrationScope.requestedKnowledgeSpaceIds,
      )
    )
  ) {
    throw new Error('Knowledge capsule does not match the workspace integration scope.');
  }
  const current = await readManifest(
    input.projectPath,
    input.projectId,
    requestId,
    integrationScope,
  );
  if (!memory && !knowledge && !current) return false;
  const currentKnowledgeExposure = current?.knowledge
    ? { ...current.knowledge, usage: null }
    : null;
  if (
    current
    && (
      !sameValue(current.integrationScope, integrationScope)
      || !sameValue(current.memory, memory)
      || !sameValue(currentKnowledgeExposure, knowledge)
    )
  ) {
    throw new Error('Context exposure idempotency collision.');
  }
  const now = new Date().toISOString();
  await writeManifest(input.projectPath, current ?? {
    schemaVersion: SCHEMA_VERSION,
    projectId: input.projectId,
    requestId,
    integrationScope,
    memory,
    knowledge,
    acceptedMission: null,
    createdAt: now,
    updatedAt: now,
  });
  return true;
}

export async function recordContextAcceptance(input: {
  projectPath: string;
  projectId: string;
  requestId: string;
  integrationScope?: ProjectIntegrationScope;
  knowledgeUsage: KnowledgeUsageResult | null;
  mission: AcceptedMissionUse;
}): Promise<boolean> {
  const requestId = safeRequestId(input.requestId);
  const integrationScope = integrationScopeUse(
    input.integrationScope ?? getProjectIntegrationScope(input.projectId),
    input.projectId,
  );
  const current = await readManifest(
    input.projectPath,
    input.projectId,
    requestId,
    integrationScope,
  );
  if (!current) return false;
  if (current.acceptedMission && !sameValue(current.acceptedMission, input.mission)) {
    throw new Error('Context acceptance idempotency collision.');
  }
  if (
    current.knowledge?.usage
    && input.knowledgeUsage
    && !sameValue(current.knowledge.usage, input.knowledgeUsage)
  ) {
    throw new Error('Knowledge outcome evidence idempotency collision.');
  }
  const knowledge = current.knowledge
    ? { ...current.knowledge, usage: current.knowledge.usage ?? input.knowledgeUsage }
    : null;
  await writeManifest(input.projectPath, {
    ...current,
    knowledge,
    acceptedMission: input.mission,
    updatedAt: new Date().toISOString(),
  });
  return true;
}
