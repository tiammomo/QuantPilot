import { describe, expect, it } from 'vitest';

import type { DataAgentDomainPack, DataAgentProfile } from './contracts';
import { DataAgentRegistry } from './registry';

const pack: DataAgentDomainPack = {
  id: 'sales.analytics',
  version: '1.0.0',
  name: 'Sales Analytics',
  description: 'Test domain pack',
  capabilities: [{
    id: 'sales.overview',
    name: 'Sales overview',
    description: 'Analyse sales data',
    status: 'ready',
    domainPackId: 'sales.analytics',
    requiredSkillIds: ['data-quality'],
    requiredConnectorOperationIds: ['sales.query'],
    supportedOutputs: ['answer', 'dashboard'],
  }],
  resolverIds: ['sales.customer-resolver'],
  connectors: [{
    id: 'sales.system',
    version: '1.0.0',
    domain: 'sales.analytics',
    operations: [{
      id: 'sales.query',
      title: 'Query sales',
      description: 'Read sales data',
      effect: 'read',
      inputSchema: { type: 'object' },
    }],
  }],
  skillIds: ['data-quality'],
  toolNames: ['sales_query'],
  validatorIds: ['dataset-schema'],
  visualizationProfileIds: ['sales-dashboard'],
};

const profile: DataAgentProfile = {
  id: 'sales.studio',
  version: '1.0.0',
  name: 'Sales Studio',
  domainPackIds: ['sales.analytics'],
  defaultCapabilityId: 'sales.overview',
  deliveryPackId: 'workspace.next-dashboard',
};

describe('DataAgentRegistry', () => {
  it('resolves a profile and its default capability without product-specific logic', () => {
    const resolved = new DataAgentRegistry()
      .registerDomainPack(pack)
      .registerProfile(profile)
      .resolveProfile(profile.id);

    expect(resolved.defaultCapability.id).toBe('sales.overview');
    expect(resolved.domainPacks.map((item) => item.id)).toEqual(['sales.analytics']);
  });

  it('fails closed for missing packs and duplicate registrations', () => {
    expect(() => new DataAgentRegistry().registerProfile(profile).resolveProfile(profile.id))
      .toThrow('missing domain pack');
    const registry = new DataAgentRegistry().registerDomainPack(pack);
    expect(() => registry.registerDomainPack(pack)).toThrow('Duplicate Data Agent domain pack');
  });

  it('rejects capabilities that reference undeclared skills or connector operations', () => {
    expect(() => new DataAgentRegistry().registerDomainPack({
      ...pack,
      capabilities: [{
        ...pack.capabilities[0],
        requiredSkillIds: ['missing-skill'],
      }],
    })).toThrow('references undeclared skill missing-skill');

    expect(() => new DataAgentRegistry().registerDomainPack({
      ...pack,
      connectors: [],
      capabilities: [{
        ...pack.capabilities[0],
        requiredConnectorOperationIds: ['sales.query'],
      }],
    })).toThrow('references missing connector operation sales.query');
  });

  it('requires scoped external writes and freezes registered contracts', () => {
    const mutablePack: DataAgentDomainPack = {
      ...pack,
      connectors: [{
        id: 'sales.system',
        version: '1.0.0',
        domain: 'sales.analytics',
        operations: [{
          id: 'sales.query',
          title: 'Query sales',
          description: 'Read sales data',
          effect: 'read',
          inputSchema: { type: 'object' },
        }],
      }],
    };
    const registry = new DataAgentRegistry()
      .registerDomainPack(mutablePack)
      .registerProfile(profile);
    mutablePack.capabilities[0].name = 'Mutated outside registry';

    expect(registry.resolveProfile(profile.id).defaultCapability.name).toBe('Sales overview');
    expect(() => new DataAgentRegistry().registerDomainPack({
      ...mutablePack,
      id: 'sales.writes',
      connectors: [{
        id: 'sales.writer',
        version: '1.0.0',
        domain: 'sales.writes',
        operations: [{
          id: 'sales.update',
          title: 'Update sales',
          description: 'Update source system',
          effect: 'external_write',
          inputSchema: { type: 'object' },
        }],
      }],
      capabilities: [],
    })).toThrow('must declare required scopes');
  });
});
