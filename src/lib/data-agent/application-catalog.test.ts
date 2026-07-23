import { describe, expect, it, vi } from 'vitest';

import { NEXT_DASHBOARD_DELIVERY_PACK } from './delivery-packs';
import type { DataAgentDomainPack, DataAgentProfile } from './contracts';
import { DataAgentApplicationCatalog } from './application-catalog';
import { DataAgentRegistry } from './registry';

const domainPack: DataAgentDomainPack = {
  id: 'operations.analytics',
  version: '1.0.0',
  name: 'Operations',
  description: 'Operations analytics test pack.',
  capabilities: [{
    id: 'operations.overview',
    name: 'Overview',
    description: 'Operations overview.',
    status: 'ready',
    domainPackId: 'operations.analytics',
    requiredSkillIds: [],
    requiredConnectorOperationIds: [],
    supportedOutputs: ['dashboard'],
  }],
  resolverIds: [],
  connectors: [],
  skillIds: [],
  toolNames: [],
  validatorIds: [],
  visualizationProfileIds: [],
};

const profile: DataAgentProfile = {
  id: 'operations.studio',
  version: '1.0.0',
  name: 'Operations Studio',
  domainPackIds: [domainPack.id],
  defaultCapabilityId: 'operations.overview',
  deliveryPackId: NEXT_DASHBOARD_DELIVERY_PACK.id,
};

describe('DataAgentApplicationCatalog', () => {
  it('binds generic project provisioning to the selected profile', async () => {
    const provisionProject = vi.fn(async () => ({ settings: { domain: 'operations' } }));
    const catalog = new DataAgentApplicationCatalog(
      new DataAgentRegistry()
        .registerDeliveryPack(NEXT_DASHBOARD_DELIVERY_PACK)
        .registerDomainPack(domainPack)
        .registerProfile(profile),
    ).register({ profileId: profile.id, provisionProject });
    const application = catalog.resolve(profile.id);
    await application.adapter.provisionProject({
      projectPath: '/tmp/project',
      projectId: 'project-1',
      projectName: 'Project',
      preferredCli: 'moagent',
      selectedModel: 'model',
      capabilitySelectionSource: 'default',
    }, application);
    expect(application.capability.id).toBe('operations.overview');
    expect(provisionProject).toHaveBeenCalledOnce();
  });

  it('fails closed when a profile has no registered runtime adapter', () => {
    const catalog = new DataAgentApplicationCatalog(
      new DataAgentRegistry()
        .registerDeliveryPack(NEXT_DASHBOARD_DELIVERY_PACK)
        .registerDomainPack(domainPack)
        .registerProfile(profile),
    );
    expect(() => catalog.resolve(profile.id)).toThrow('No Data Agent application adapter');
  });
});
