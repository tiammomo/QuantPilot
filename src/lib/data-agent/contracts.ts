import type { MoAgentMissionDefinition } from '@/lib/agent/mission';
import type { MoAgentSkillCapabilityDescriptor } from '@/lib/agent/skills';
import type { MoAgentTool } from '@/lib/agent/types';

export type DataAgentOutputKind =
  | 'answer'
  | 'table'
  | 'chart'
  | 'dashboard'
  | 'report'
  | 'dataset';

export interface DataAgentScopeEnvelope {
  schemaVersion: 1;
  consumerId: string;
  tenantId: string;
  projectId: string;
  workspaceId: string;
  requestId: string;
  agentProfileId: string;
  domainPackIds: string[];
  integrationScopeSha256: string;
}

export interface DataAgentEntityMention {
  text: string;
  typeHint?: string;
  evidence?: string;
}

export interface DataAgentResolvedEntity {
  mention: string;
  entityType: string;
  canonicalId: string;
  displayName: string;
  attributes?: Record<string, string | number | boolean | null>;
  resolverId: string;
  confidence: number;
}

export interface DataAgentTimeRange {
  start?: string;
  end?: string;
  label?: string;
  granularity?: string;
  timezone?: string;
}

export interface DataAgentMetricRequest {
  id?: string;
  name: string;
  aggregation?: string;
  evidence?: string;
}

export interface DataAgentDimensionRequest {
  id?: string;
  name: string;
  evidence?: string;
}

export interface DataAgentFilter {
  field: string;
  operator: string;
  value: unknown;
}

/**
 * Provider-neutral semantic contract produced by LLM-first query rewrite.
 * Domain resolvers verify entity identity after rewrite; they do not replace
 * semantic understanding with keyword or regular-expression routing.
 */
export interface DataAgentTask {
  schemaVersion: 1;
  originalQuery: string;
  objective: string;
  entities: DataAgentEntityMention[];
  resolvedEntities: DataAgentResolvedEntity[];
  metrics: DataAgentMetricRequest[];
  dimensions: DataAgentDimensionRequest[];
  filters: DataAgentFilter[];
  timeRange: DataAgentTimeRange | null;
  output: DataAgentOutputKind;
  domainHints: string[];
  status: 'ready' | 'partial' | 'needs_clarification' | 'refused';
  issues: Array<{
    code: string;
    message: string;
    retryable: boolean;
  }>;
  extensions?: Record<string, unknown>;
}

export interface DataAgentSourceReceipt {
  sourceId: string;
  operationId: string;
  observedAt: string;
  asOf?: string;
  fetchedAt: string;
  querySha256: string;
  responseSha256?: string;
}

export interface DataAgentDatasetManifest {
  schemaVersion: 1;
  datasetId: string;
  schemaRef: string;
  grain: string;
  rowCount: number;
  columns: string[];
  sources: DataAgentSourceReceipt[];
  quality: {
    status: 'passed' | 'warning' | 'failed';
    missingFields: string[];
    warnings: string[];
  };
  createdAt: string;
}

export interface DataAgentExecutionPlan {
  schemaVersion: 1;
  runId: string;
  status: 'planned' | 'needs_clarification' | 'refused';
  profile: {
    id: string;
    version: string;
    domainPacks: Array<{ id: string; version: string }>;
    deliveryPack: { id: string; version: string };
    compositionSha256: string;
  };
  capabilityId: string;
  taskArtifact: string;
  domainPlanArtifact: string;
  expectedArtifacts: string[];
  validationRuleIds: string[];
  createdAt: string;
  updatedAt: string;
}

export interface DataAgentConnectorOperation {
  id: string;
  title: string;
  description: string;
  effect: 'read' | 'external_write';
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  requiredScopes?: string[];
}

export interface DataAgentConnectorDescriptor {
  id: string;
  version: string;
  domain: string;
  operations: DataAgentConnectorOperation[];
}

export interface DataAgentCapabilityDescriptor {
  id: string;
  name: string;
  description: string;
  status: 'ready' | 'planned' | 'deprecated';
  domainPackId: string;
  requiredSkillIds: string[];
  requiredConnectorOperationIds: string[];
  supportedOutputs: DataAgentOutputKind[];
}

export interface DataAgentDomainPack {
  id: string;
  version: string;
  name: string;
  description: string;
  capabilities: DataAgentCapabilityDescriptor[];
  resolverIds: string[];
  connectors: DataAgentConnectorDescriptor[];
  skillIds: string[];
  toolNames: string[];
  validatorIds: string[];
  visualizationProfileIds: string[];
}

export interface DataAgentProfile {
  id: string;
  version: string;
  name: string;
  domainPackIds: string[];
  defaultCapabilityId: string;
  deliveryPackId: string;
  memoryPolicyId?: string;
  knowledgePolicyId?: string;
}

/**
 * Immutable identity of the exact application composition selected for a run.
 * The digest is persisted with projects and dispatch envelopes so a worker
 * never silently executes a newer Profile, Domain Pack or Delivery Pack.
 */
export interface DataAgentCompositionLock {
  schemaVersion: 1;
  profile: {
    id: string;
    version: string;
  };
  domainPacks: Array<{
    id: string;
    version: string;
  }>;
  deliveryPack: {
    id: string;
    version: string;
  };
  capability: {
    id: string;
  };
  sha256: string;
}

/**
 * Product-neutral delivery contract. Domain packs decide what the analysis
 * means; delivery packs decide how validated artifacts are laid out and served.
 */
export interface DataAgentDeliveryPackDescriptor {
  id: string;
  version: string;
  name: string;
  description: string;
  supportedOutputs: DataAgentOutputKind[];
  workspaceDirectories: string[];
  artifactPaths: string[];
  validatorIds: string[];
}

export interface DataAgentProfileSelection {
  schemaVersion: 1;
  profile: DataAgentProfile;
  selectedCapabilityId: string;
  composition: DataAgentCompositionLock;
  selectionSource: 'manual' | 'default' | 'inferred';
  updatedAt: string;
  extensions?: Record<string, unknown>;
}

export interface DataAgentWorkspaceDescriptor {
  schemaVersion: 1;
  workspaceId: string;
  projectId: string;
  projectName: string;
  platform: string;
  composition: DataAgentCompositionLock;
  runtime: {
    framework: 'MoAgent';
    executorId: string;
    modelId: string;
    modelProfileId: string;
  };
  createdAt: string;
  updatedAt: string;
}

/** Runtime composition owned by an application/domain adapter, never by MoAgent core. */
export interface DataAgentRuntimeComposition {
  profile: DataAgentProfile;
  deliveryPack: DataAgentDeliveryPackDescriptor;
  domainPacks: DataAgentDomainPack[];
  capability: DataAgentCapabilityDescriptor;
  skillCapability: MoAgentSkillCapabilityDescriptor;
  missionDefinition: MoAgentMissionDefinition;
  tools: MoAgentTool[];
}
