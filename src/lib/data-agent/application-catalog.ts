import type {
  DataAgentCapabilityDescriptor,
  DataAgentCompositionLock,
  DataAgentDeliveryPackDescriptor,
  DataAgentDomainPack,
  DataAgentProfile,
} from './contracts';
import type { DataAgentRegistry } from './registry';

export type DataAgentCapabilitySelectionSource = 'manual' | 'default' | 'inferred';

export interface DataAgentResolvedApplication {
  profile: DataAgentProfile;
  deliveryPack: DataAgentDeliveryPackDescriptor;
  domainPacks: DataAgentDomainPack[];
  capability: DataAgentCapabilityDescriptor;
  composition: DataAgentCompositionLock;
}

export interface DataAgentProjectProvisionInput {
  projectPath: string;
  projectId: string;
  projectName: string;
  preferredCli: 'moagent';
  selectedModel: string;
  capabilitySelectionSource: DataAgentCapabilitySelectionSource;
}

export interface DataAgentProjectProvisionResult {
  settings: Record<string, unknown>;
}

export interface DataAgentApplicationAdapter {
  profileId: string;
  provisionProject(
    input: DataAgentProjectProvisionInput,
    application: DataAgentResolvedApplication,
  ): Promise<DataAgentProjectProvisionResult>;
}

/**
 * Application composition root. The generic project lifecycle depends on this
 * interface; concrete finance, sales or operations packs register adapters.
 */
export class DataAgentApplicationCatalog {
  private readonly adapters = new Map<string, DataAgentApplicationAdapter>();

  constructor(readonly registry: DataAgentRegistry) {}

  register(adapter: DataAgentApplicationAdapter): this {
    const profile = this.registry.resolveProfile(adapter.profileId).profile;
    if (this.adapters.has(profile.id)) {
      throw new Error(`Duplicate Data Agent application adapter: ${profile.id}`);
    }
    this.adapters.set(profile.id, Object.freeze(adapter));
    return this;
  }

  resolve(
    profileId: string,
    capabilityId?: string | null,
  ): DataAgentResolvedApplication & { adapter: DataAgentApplicationAdapter } {
    const application = this.registry.resolveCapability(profileId, capabilityId);
    const adapter = this.adapters.get(application.profile.id);
    if (!adapter) {
      throw new Error(
        `No Data Agent application adapter is registered for ${application.profile.id}.`,
      );
    }
    return { ...application, adapter };
  }
}
