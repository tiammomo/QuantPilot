import type { MoAgentSkillCapabilityDescriptor } from '@/lib/agent/skills';
import type {
  DataAgentCapabilityDescriptor,
  DataAgentDomainPack,
  DataAgentProfile,
} from '@/lib/data-agent';
import {
  DEFAULT_QUANT_CAPABILITY_ID,
  getQuantCapability,
  QUANT_CAPABILITIES,
} from './capabilities';

export const FINANCE_DOMAIN_PACK_ID = 'finance.quant';
export const QUANTPILOT_AGENT_PROFILE_ID = 'quantpilot.finance-research';

function operationId(endpoint: string): string {
  const normalized = endpoint
    .toLowerCase()
    .replace(/^get\s+/, '')
    .replace(/\{[^}]+\}/g, 'entity')
    .replace(/[^a-z0-9]+/g, '.')
    .replace(/^\.|\.$/g, '');
  return `finance.market-data.${normalized}`;
}

function capabilityDescriptor(
  capability: (typeof QUANT_CAPABILITIES)[number],
): DataAgentCapabilityDescriptor {
  return {
    id: capability.id,
    name: capability.name,
    description: capability.description,
    status: capability.status,
    domainPackId: FINANCE_DOMAIN_PACK_ID,
    requiredSkillIds: [...capability.requiredSkills],
    requiredConnectorOperationIds: capability.dataEndpoints.map(operationId),
    supportedOutputs: ['answer', 'dashboard', 'report'],
  };
}

const connectorOperations = Array.from(new Set(
  QUANT_CAPABILITIES.flatMap((capability) => capability.dataEndpoints),
)).map((endpoint) => ({
  id: operationId(endpoint),
  title: endpoint,
  description: `QuantPilot market-data operation ${endpoint}`,
  effect: 'read' as const,
  inputSchema: { type: 'object', additionalProperties: false },
}));

export const FINANCE_DOMAIN_PACK: DataAgentDomainPack = {
  id: FINANCE_DOMAIN_PACK_ID,
  version: '1.0.0',
  name: 'Quant Finance',
  description: '证券解析、行情、财务、指标、回测、组合风险和金融可视化能力。',
  capabilities: QUANT_CAPABILITIES.map(capabilityDescriptor),
  resolverIds: ['finance.security-resolver'],
  connectors: [{
    id: 'finance.market-data',
    version: '1.0.0',
    domain: FINANCE_DOMAIN_PACK_ID,
    operations: connectorOperations,
  }],
  skillIds: Array.from(new Set(
    QUANT_CAPABILITIES.flatMap((capability) => capability.requiredSkills),
  )),
  toolNames: [
    'quant_api_get',
    'quant_extract_uploaded_image',
    'inspect_dashboard_contract',
    'apply_dashboard_spec',
  ],
  validatorIds: [
    'finance.symbol-consistency',
    'finance.market-proxy',
    'finance.reporting-period-consistency',
    'finance.investment-safety',
  ],
  visualizationProfileIds: [
    'single-stock-diagnosis',
    'technical-timing',
    'fundamental-research',
    'stock-selection',
    'sector-rotation',
    'strategy-research',
    'backtest-review',
    'holding-analysis',
  ],
};

export const QUANTPILOT_AGENT_PROFILE: DataAgentProfile = {
  id: QUANTPILOT_AGENT_PROFILE_ID,
  version: '1.0.0',
  name: 'QuantPilot Finance Research',
  domainPackIds: [FINANCE_DOMAIN_PACK_ID],
  defaultCapabilityId: DEFAULT_QUANT_CAPABILITY_ID,
  deliveryPackId: 'workspace.next-dashboard',
  memoryPolicyId: 'quantpilot.personalization',
  knowledgePolicyId: 'quantpilot.governed-knowledge',
};

export function getFinanceSkillCapabilityDescriptor(
  capabilityId?: string | null,
): MoAgentSkillCapabilityDescriptor {
  const capability = getQuantCapability(capabilityId);
  return {
    id: capability.id,
    status: capability.status,
    requiredSkillIds: [...capability.requiredSkills],
  };
}
