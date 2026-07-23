import { createHash } from 'node:crypto';

import type {
  DataAgentCapabilityDescriptor,
  DataAgentCompositionLock,
  DataAgentDeliveryPackDescriptor,
  DataAgentDomainPack,
  DataAgentOutputKind,
  DataAgentProfile,
} from './contracts';

function assertIdentifier(value: string, label: string): string {
  const normalized = value.trim();
  if (!/^[a-z][a-z0-9._-]{1,127}$/.test(normalized)) {
    throw new Error(`${label} must be a stable lowercase identifier.`);
  }
  return normalized;
}

function assertVersion(value: string, label: string): string {
  const normalized = value.trim();
  if (!/^\d+\.\d+\.\d+(?:-[0-9a-z.-]+)?$/i.test(normalized)) {
    throw new Error(`${label} must be a semantic version.`);
  }
  return normalized;
}

function assertUniqueIdentifiers(values: readonly string[], label: string): Set<string> {
  const identifiers = new Set<string>();
  for (const value of values) {
    const id = assertIdentifier(value, label);
    if (identifiers.has(id)) throw new Error(`Duplicate ${label}: ${id}`);
    identifiers.add(id);
  }
  return identifiers;
}

function assertRelativeWorkspacePaths(values: readonly string[], label: string): void {
  const paths = new Set<string>();
  for (const value of values) {
    const normalized = value.trim();
    if (
      !normalized
      || normalized.startsWith('/')
      || normalized.includes('\\')
      || normalized.split('/').includes('..')
    ) {
      throw new Error(`${label} must contain safe workspace-relative POSIX paths.`);
    }
    if (paths.has(normalized)) throw new Error(`Duplicate ${label}: ${normalized}`);
    paths.add(normalized);
  }
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

export class DataAgentRegistry {
  private readonly deliveryPacks = new Map<string, DataAgentDeliveryPackDescriptor>();
  private readonly domainPacks = new Map<string, DataAgentDomainPack>();
  private readonly profiles = new Map<string, DataAgentProfile>();

  registerDeliveryPack(pack: DataAgentDeliveryPackDescriptor): this {
    const id = assertIdentifier(pack.id, 'deliveryPack.id');
    if (this.deliveryPacks.has(id)) throw new Error(`Duplicate Data Agent delivery pack: ${id}`);
    assertVersion(pack.version, `deliveryPack ${id} version`);
    if (pack.supportedOutputs.length === 0) {
      throw new Error(`Data Agent delivery pack ${id} must support at least one output kind.`);
    }
    if (new Set(pack.supportedOutputs).size !== pack.supportedOutputs.length) {
      throw new Error(`Data Agent delivery pack ${id} contains duplicate output kinds.`);
    }
    assertRelativeWorkspacePaths(pack.workspaceDirectories, `workspace directory in ${id}`);
    assertRelativeWorkspacePaths(pack.artifactPaths, `artifact path in ${id}`);
    assertUniqueIdentifiers(pack.validatorIds, `validator ID in delivery pack ${id}`);
    this.deliveryPacks.set(id, deepFreeze(structuredClone(pack)));
    return this;
  }

  registerDomainPack(pack: DataAgentDomainPack): this {
    const id = assertIdentifier(pack.id, 'domainPack.id');
    if (this.domainPacks.has(id)) throw new Error(`Duplicate Data Agent domain pack: ${id}`);
    assertVersion(pack.version, `domainPack ${id} version`);
    const declaredSkillIds = assertUniqueIdentifiers(pack.skillIds, `skill ID in ${id}`);
    assertUniqueIdentifiers(pack.resolverIds, `resolver ID in ${id}`);
    assertUniqueIdentifiers(pack.toolNames, `tool name in ${id}`);
    assertUniqueIdentifiers(pack.validatorIds, `validator ID in ${id}`);
    assertUniqueIdentifiers(pack.visualizationProfileIds, `visualization profile ID in ${id}`);
    const connectorIds = new Set<string>();
    const operationIds = new Set<string>();
    for (const connector of pack.connectors) {
      const connectorId = assertIdentifier(connector.id, `connector ID in ${id}`);
      if (connectorIds.has(connectorId)) {
        throw new Error(`Duplicate connector ID in ${id}: ${connectorId}`);
      }
      connectorIds.add(connectorId);
      assertVersion(connector.version, `connector ${connectorId} version`);
      if (connector.domain !== id) {
        throw new Error(`Connector ${connectorId} must belong to domain pack ${id}.`);
      }
      for (const operation of connector.operations) {
        const operationId = assertIdentifier(operation.id, `connector operation ID in ${id}`);
        if (operationIds.has(operationId)) {
          throw new Error(`Duplicate connector operation ID in ${id}: ${operationId}`);
        }
        operationIds.add(operationId);
        if (operation.effect === 'external_write' && !operation.requiredScopes?.length) {
          throw new Error(`External write operation ${operationId} must declare required scopes.`);
        }
      }
    }
    const capabilityIds = new Set<string>();
    for (const capability of pack.capabilities) {
      assertIdentifier(capability.id, `capability id in ${id}`);
      if (capability.domainPackId !== id) {
        throw new Error(`Capability ${capability.id} must belong to domain pack ${id}.`);
      }
      if (capabilityIds.has(capability.id)) {
        throw new Error(`Duplicate capability ${capability.id} in domain pack ${id}.`);
      }
      if (capability.supportedOutputs.length === 0) {
        throw new Error(`Capability ${capability.id} must support at least one output kind.`);
      }
      const requiredSkillIds = assertUniqueIdentifiers(
        capability.requiredSkillIds,
        `required skill ID in capability ${capability.id}`,
      );
      for (const skillId of requiredSkillIds) {
        if (!declaredSkillIds.has(skillId)) {
          throw new Error(`Capability ${capability.id} references undeclared skill ${skillId}.`);
        }
      }
      const requiredOperationIds = assertUniqueIdentifiers(
        capability.requiredConnectorOperationIds,
        `required connector operation ID in capability ${capability.id}`,
      );
      for (const operationId of requiredOperationIds) {
        if (!operationIds.has(operationId)) {
          throw new Error(
            `Capability ${capability.id} references missing connector operation ${operationId}.`,
          );
        }
      }
      capabilityIds.add(capability.id);
    }
    this.domainPacks.set(id, deepFreeze(structuredClone(pack)));
    return this;
  }

  registerProfile(profile: DataAgentProfile): this {
    const id = assertIdentifier(profile.id, 'profile.id');
    if (this.profiles.has(id)) throw new Error(`Duplicate Data Agent profile: ${id}`);
    assertVersion(profile.version, `profile ${id} version`);
    assertIdentifier(profile.defaultCapabilityId, `profile ${id} defaultCapabilityId`);
    assertIdentifier(profile.deliveryPackId, `profile ${id} deliveryPackId`);
    if (profile.memoryPolicyId) assertIdentifier(profile.memoryPolicyId, `profile ${id} memoryPolicyId`);
    if (profile.knowledgePolicyId) {
      assertIdentifier(profile.knowledgePolicyId, `profile ${id} knowledgePolicyId`);
    }
    if (profile.domainPackIds.length === 0) {
      throw new Error(`Data Agent profile ${id} must select at least one domain pack.`);
    }
    assertUniqueIdentifiers(profile.domainPackIds, `domain pack ID in profile ${id}`);
    this.profiles.set(id, deepFreeze(structuredClone(profile)));
    return this;
  }

  listProfiles(): readonly DataAgentProfile[] {
    return Array.from(this.profiles.values()).sort((left, right) => (
      left.id.localeCompare(right.id)
    ));
  }

  listDeliveryPacks(): readonly DataAgentDeliveryPackDescriptor[] {
    return Array.from(this.deliveryPacks.values()).sort((left, right) => (
      left.id.localeCompare(right.id)
    ));
  }

  resolveProfile(profileId: string): {
    profile: DataAgentProfile;
    deliveryPack: DataAgentDeliveryPackDescriptor;
    domainPacks: DataAgentDomainPack[];
    defaultCapability: DataAgentCapabilityDescriptor;
  } {
    const profile = this.profiles.get(profileId);
    if (!profile) throw new Error(`Unknown Data Agent profile: ${profileId}`);
    const domainPacks = profile.domainPackIds.map((id) => {
      const pack = this.domainPacks.get(id);
      if (!pack) throw new Error(`Profile ${profile.id} references missing domain pack ${id}.`);
      return pack;
    });
    const matches = domainPacks.flatMap((pack) => pack.capabilities)
      .filter((capability) => capability.id === profile.defaultCapabilityId);
    if (matches.length !== 1) {
      throw new Error(
        `Profile ${profile.id} must resolve exactly one default capability ${profile.defaultCapabilityId}.`,
      );
    }
    const deliveryPack = this.deliveryPacks.get(profile.deliveryPackId);
    if (!deliveryPack) {
      throw new Error(
        `Profile ${profile.id} references missing delivery pack ${profile.deliveryPackId}.`,
      );
    }
    const compatible = matches[0].supportedOutputs.some((output) => (
      deliveryPack.supportedOutputs.includes(output)
    ));
    if (!compatible) {
      throw new Error(
        `Profile ${profile.id} delivery pack ${deliveryPack.id} cannot deliver default capability ${matches[0].id}.`,
      );
    }
    return { profile, deliveryPack, domainPacks, defaultCapability: matches[0] };
  }

  resolveCapability(
    profileId: string,
    capabilityId?: string | null,
    requestedOutput?: DataAgentOutputKind | null,
  ): {
    profile: DataAgentProfile;
    deliveryPack: DataAgentDeliveryPackDescriptor;
    domainPacks: DataAgentDomainPack[];
    capability: DataAgentCapabilityDescriptor;
    composition: DataAgentCompositionLock;
  } {
    const resolved = this.resolveProfile(profileId);
    const selectedId = capabilityId?.trim() || resolved.profile.defaultCapabilityId;
    assertIdentifier(selectedId, `capability ID in profile ${resolved.profile.id}`);
    const matches = resolved.domainPacks
      .flatMap((pack) => pack.capabilities)
      .filter((capability) => capability.id === selectedId);
    if (matches.length !== 1) {
      throw new Error(
        `Profile ${resolved.profile.id} must resolve exactly one capability ${selectedId}.`,
      );
    }
    const capability = matches[0];
    if (capability.status !== 'ready') {
      throw new Error(
        `Capability ${capability.id} is not ready for execution (status=${capability.status}).`,
      );
    }
    const compatibleOutputs = capability.supportedOutputs.filter((output) => (
      resolved.deliveryPack.supportedOutputs.includes(output)
    ));
    if (compatibleOutputs.length === 0) {
      throw new Error(
        `Delivery pack ${resolved.deliveryPack.id} cannot deliver capability ${capability.id}.`,
      );
    }
    if (
      requestedOutput
      && (
        !capability.supportedOutputs.includes(requestedOutput)
        || !resolved.deliveryPack.supportedOutputs.includes(requestedOutput)
      )
    ) {
      throw new Error(
        `Output ${requestedOutput} is not supported by capability ${capability.id} and delivery pack ${resolved.deliveryPack.id}.`,
      );
    }
    const unsigned = {
      schemaVersion: 1 as const,
      profile: {
        id: resolved.profile.id,
        version: resolved.profile.version,
      },
      domainPacks: resolved.domainPacks.map((pack) => ({
        id: pack.id,
        version: pack.version,
      })),
      deliveryPack: {
        id: resolved.deliveryPack.id,
        version: resolved.deliveryPack.version,
      },
      capability: {
        id: capability.id,
      },
    };
    const composition: DataAgentCompositionLock = deepFreeze({
      ...unsigned,
      sha256: `sha256:${createHash('sha256')
        .update(JSON.stringify(unsigned), 'utf8')
        .digest('hex')}`,
    });
    return {
      profile: resolved.profile,
      deliveryPack: resolved.deliveryPack,
      domainPacks: resolved.domainPacks,
      capability,
      composition,
    };
  }
}
