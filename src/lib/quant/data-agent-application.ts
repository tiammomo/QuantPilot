import fs from 'node:fs/promises';
import path from 'node:path';

import {
  DATA_AGENT_EVENTS_RELATIVE_PATH,
  DATA_AGENT_PROFILE_RELATIVE_PATH,
  DATA_AGENT_WORKSPACE_RELATIVE_PATH,
  DataAgentApplicationCatalog,
  type DataAgentApplicationAdapter,
  type DataAgentProfileSelection,
  type DataAgentWorkspaceDescriptor,
  writeWorkspaceFileAtomic,
  writeWorkspaceJsonAtomic,
} from '@/lib/data-agent';
import { installMoAgentSkillsForWorkspace } from '@/lib/agent/skills';
import { getProjectLlmConfig } from '@/lib/config/llm';
import {
  buildQuantProjectSettings,
  getQuantCapability,
} from '@/lib/domains/finance/capabilities';
import {
  createQuantPilotDataAgentRegistry,
  getFinanceSkillCapabilityDescriptor,
  QUANTPILOT_AGENT_PROFILE_ID,
} from '@/lib/domains/finance';
import { serializeQuantVisualizationTemplate } from '@/lib/domains/finance/visualization-templates';
import { FINANCE_RUN_PLAN_RELATIVE_PATH } from '@/lib/domains/finance/workspace-artifacts';

const financeAdapter: DataAgentApplicationAdapter = {
  profileId: QUANTPILOT_AGENT_PROFILE_ID,
  async provisionProject(input, application) {
    const capability = getQuantCapability(application.capability.id);
    const visualizationTemplate = serializeQuantVisualizationTemplate(capability.id);
    const llm = getProjectLlmConfig(input.selectedModel);
    const now = new Date().toISOString();
    await Promise.all(application.deliveryPack.workspaceDirectories.map((directory) => (
      fs.mkdir(path.join(input.projectPath, directory), { recursive: true })
    )));
    const workspace: DataAgentWorkspaceDescriptor = {
      schemaVersion: 1,
      workspaceId: input.projectId,
      projectId: input.projectId,
      projectName: input.projectName,
      platform: 'QuantPilot',
      composition: application.composition,
      createdAt: now,
      updatedAt: now,
      runtime: {
        framework: 'MoAgent',
        executorId: input.preferredCli,
        modelId: input.selectedModel,
        modelProfileId: llm.profileId,
      },
    };
    const profileSelection: DataAgentProfileSelection = {
      schemaVersion: 1,
      profile: application.profile,
      selectedCapabilityId: capability.id,
      composition: application.composition,
      selectionSource: input.capabilitySelectionSource,
      updatedAt: now,
    };
    await Promise.all([
      writeWorkspaceJsonAtomic(
        input.projectPath,
        DATA_AGENT_WORKSPACE_RELATIVE_PATH,
        workspace,
      ),
      writeWorkspaceJsonAtomic(
        input.projectPath,
        FINANCE_RUN_PLAN_RELATIVE_PATH,
        {
          schemaVersion: 1,
          runId: null,
          status: 'pending',
          capabilityId: capability.id,
          composition: application.composition,
          llm,
          question: '',
          symbols: [],
          timeRange: null,
          dataRequirements: capability.dataEndpoints,
          analysisSteps: [],
          visualization: {
            required: false,
            templateId: visualizationTemplate.templateId,
            name: visualizationTemplate.name,
            scenario: visualizationTemplate.scenario,
            variantId: visualizationTemplate.variantId,
            variantName: visualizationTemplate.variantName,
            variantScenario: visualizationTemplate.variantScenario,
            layout: visualizationTemplate.layout,
            density: visualizationTemplate.density,
            firstViewport: visualizationTemplate.firstViewport,
            variantGuidance: visualizationTemplate.variantGuidance,
            matchReasons: visualizationTemplate.matchReasons,
            panels: visualizationTemplate.requiredComponents,
            painPoints: visualizationTemplate.painPoints,
            optionalPanels: visualizationTemplate.optionalComponents,
            dataSignals: visualizationTemplate.dataSignals,
            finalDataContract: visualizationTemplate.finalDataContract,
          },
          expectedArtifacts: capability.expectedArtifacts,
          validationRules: capability.validationRules,
          createdAt: now,
          updatedAt: now,
        },
      ),
      writeWorkspaceJsonAtomic(
        input.projectPath,
        DATA_AGENT_PROFILE_RELATIVE_PATH,
        profileSelection,
      ),
      writeWorkspaceFileAtomic(
        input.projectPath,
        DATA_AGENT_EVENTS_RELATIVE_PATH,
        '',
      ),
    ]);
    await installMoAgentSkillsForWorkspace(input.projectPath, {
      capabilityId: capability.id,
      capability: getFinanceSkillCapabilityDescriptor(capability.id),
      additionalSkillIds: ['platform-ui-product-design'],
    });
    return {
      settings: {
        llm,
        quant: buildQuantProjectSettings(capability.id),
        dataAgent: {
          profileId: application.profile.id,
          profileVersion: application.profile.version,
          capabilityId: capability.id,
          compositionSha256: application.composition.sha256,
        },
      },
    };
  },
};

const applicationCatalog = new DataAgentApplicationCatalog(
  createQuantPilotDataAgentRegistry(),
).register(financeAdapter);

export function getApplicationDataAgentCatalog(): DataAgentApplicationCatalog {
  return applicationCatalog;
}
