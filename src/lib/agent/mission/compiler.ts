import { createHash } from 'node:crypto';

import type {
  MoAgentArtifactRequirement,
  MoAgentMissionDefinition,
  MoAgentExpectedEntityRef,
  MoAgentMissionCompositionRef,
  MoAgentMissionNodeKey,
  MoAgentMissionNodeSpec,
  MoAgentMissionSpec,
} from './types';

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function boundedIdentifier(value: string, label: string, max = 256): string {
  const normalized = value.trim();
  if (!normalized || Buffer.byteLength(normalized, 'utf8') > max) {
    throw new Error(`${label} must be between 1 and ${max} UTF-8 bytes.`);
  }
  return normalized;
}

function safeArtifactPattern(value: string): string {
  const normalized = value.trim().replace(/\\/g, '/').replace(/^\.\//, '');
  if (
    !normalized ||
    normalized.startsWith('/') ||
    normalized.includes('\0') ||
    normalized.split('/').includes('..') ||
    Buffer.byteLength(normalized, 'utf8') > 1_024
  ) {
    throw new Error(`Invalid MissionSpec artifact path: ${value}`);
  }
  return normalized;
}

function compileArtifacts(
  artifacts: readonly MoAgentArtifactRequirement[],
): MoAgentArtifactRequirement[] {
  const compiled = new Map<string, MoAgentArtifactRequirement>();
  for (const artifact of artifacts) {
    const artifactPath = safeArtifactPattern(artifact.path);
    const existing = compiled.get(artifactPath);
    const normalized = { ...artifact, path: artifactPath };
    if (existing && JSON.stringify(existing) !== JSON.stringify(normalized)) {
      throw new Error(`Conflicting MissionSpec artifact contract: ${artifactPath}`);
    }
    compiled.set(artifactPath, normalized);
  }
  return [...compiled.values()].sort((left, right) => left.path.localeCompare(right.path));
}

function compileNodes(nodes: readonly MoAgentMissionNodeSpec[]): MoAgentMissionNodeSpec[] {
  const byKey = new Map<MoAgentMissionNodeKey, MoAgentMissionNodeSpec>();
  for (const node of nodes) {
    if (byKey.has(node.key)) throw new Error(`Duplicate Mission node: ${node.key}`);
    if (
      !Number.isSafeInteger(node.budget.maxAttempts) || node.budget.maxAttempts <= 0 ||
      !Number.isSafeInteger(node.budget.maxToolCalls) || node.budget.maxToolCalls < 0 ||
      !Number.isSafeInteger(node.budget.maxInputTokens) || node.budget.maxInputTokens < 0 ||
      !Number.isSafeInteger(node.budget.maxOutputTokens) || node.budget.maxOutputTokens < 0 ||
      !Number.isSafeInteger(node.budget.timeoutMs) || node.budget.timeoutMs <= 0
    ) {
      throw new Error(`Mission node ${node.key} contains an invalid budget.`);
    }
    byKey.set(node.key, {
      ...node,
      dependencies: [...node.dependencies],
      allowedTools: [...node.allowedTools],
      requiredSkillSections: [...node.requiredSkillSections],
      inputArtifacts: node.inputArtifacts.map(safeArtifactPattern),
      outputArtifacts: node.outputArtifacts.map(safeArtifactPattern),
      budget: { ...node.budget },
      acceptancePredicates: [...node.acceptancePredicates],
    });
  }
  for (const node of byKey.values()) {
    for (const dependency of node.dependencies) {
      if (!byKey.has(dependency)) {
        throw new Error(`Mission node ${node.key} references missing dependency ${dependency}.`);
      }
      if (dependency === node.key) {
        throw new Error(`Mission node ${node.key} cannot depend on itself.`);
      }
    }
  }
  return [...byKey.values()];
}

export function compileMoAgentMissionSpec(input: {
  projectId: string;
  requestId: string;
  objective: string;
  capabilityId: string;
  runPlanId: string;
  composition: MoAgentMissionCompositionRef;
  entities?: readonly MoAgentExpectedEntityRef[];
  maxRepairAttempts: number;
  definition: MoAgentMissionDefinition;
  createdAt?: string;
}): MoAgentMissionSpec {
  if (!Number.isSafeInteger(input.maxRepairAttempts) || input.maxRepairAttempts < 0) {
    throw new Error('maxRepairAttempts must be a non-negative safe integer.');
  }
  const objective = input.objective.trim();
  if (!objective) throw new Error('Mission objective cannot be empty.');
  boundedIdentifier(input.definition.id, 'missionDefinition.id');
  boundedIdentifier(input.definition.version, 'missionDefinition.version', 64);
  const requiredValidationCheckIds = Array.from(new Set(
    input.definition.requiredValidationCheckIds.map((id) =>
      boundedIdentifier(id, 'validation check ID', 128)),
  ));
  const allowedValidationWarnings = Array.from(new Set(
    input.definition.allowedValidationWarnings.map((id) =>
      boundedIdentifier(id, 'validation warning ID', 128)),
  ));
  if (allowedValidationWarnings.some((id) => !requiredValidationCheckIds.includes(id))) {
    throw new Error('Allowed validation warnings must reference required validation checks.');
  }
  const acceptancePredicateIds = new Set<string>();
  const acceptancePredicates = input.definition.acceptancePredicates.map((predicate) => {
    const id = boundedIdentifier(predicate.id, 'acceptance predicate ID', 128);
    if (acceptancePredicateIds.has(id)) throw new Error(`Duplicate acceptance predicate: ${id}`);
    acceptancePredicateIds.add(id);
    return {
      ...predicate,
      id,
      ...(predicate.parameters ? { parameters: structuredClone(predicate.parameters) } : {}),
    };
  });
  const nodes = compileNodes(input.definition.nodes);
  const expectedEntities = new Map<string, MoAgentExpectedEntityRef>();
  for (const entity of input.entities ?? []) {
    const normalized = {
      entityType: boundedIdentifier(entity.entityType, 'entityType', 128),
      canonicalId: boundedIdentifier(entity.canonicalId, 'canonicalId', 256),
    };
    expectedEntities.set(`${normalized.entityType}\0${normalized.canonicalId}`, normalized);
  }
  return {
    schemaVersion: 1,
    framework: 'MoAgent',
    projectId: boundedIdentifier(input.projectId, 'projectId'),
    requestId: boundedIdentifier(input.requestId, 'requestId'),
    objectiveSha256: `sha256:${sha256(objective)}`,
    composition: {
      profileId: boundedIdentifier(input.composition.profileId, 'profileId'),
      profileVersion: boundedIdentifier(input.composition.profileVersion, 'profileVersion', 64),
      domainPackIds: Array.from(new Set(input.composition.domainPackIds.map((id) =>
        boundedIdentifier(id, 'domainPackId')))).sort(),
      deliveryPackId: boundedIdentifier(input.composition.deliveryPackId, 'deliveryPackId'),
    },
    capabilityId: boundedIdentifier(input.capabilityId, 'capabilityId'),
    runPlanId: boundedIdentifier(input.runPlanId, 'runPlanId'),
    validationReportPath: safeArtifactPattern(input.definition.validationReportPath),
    expectedEntities: [...expectedEntities.values()].sort((left, right) =>
      left.entityType.localeCompare(right.entityType) ||
      left.canonicalId.localeCompare(right.canonicalId)),
    artifacts: compileArtifacts(input.definition.artifacts),
    requiredValidationCheckIds,
    allowedValidationWarnings,
    maxRepairAttempts: input.maxRepairAttempts,
    nodes,
    acceptancePredicates,
    createdAt: input.createdAt ?? new Date().toISOString(),
  };
}
