import type {
  DataAgentExecutionPlan,
  DataAgentProfileSelection,
  DataAgentTask,
} from '@/lib/data-agent';
import { DATA_AGENT_TASK_RELATIVE_PATH } from '@/lib/data-agent';
import {
  createQuantPilotDataAgentRegistry,
  QUANTPILOT_AGENT_PROFILE,
} from './agent-profile';
import { FINANCE_RUN_PLAN_RELATIVE_PATH } from './workspace-artifacts';
import type { QuantQueryRewriteResult } from './query-rewrite';
import type { QuantRunPlan } from './workspace';

/** Projects the Finance Domain contract into the provider-neutral Data Agent task. */
export function projectFinanceRewriteToDataAgentTask(
  rewrite: QuantQueryRewriteResult,
): DataAgentTask {
  return {
    schemaVersion: 1,
    originalQuery: rewrite.originalQuery,
    objective: rewrite.rewrittenQuery,
    entities: rewrite.targetCandidates.map((text) => ({ text, evidence: text })),
    resolvedEntities: rewrite.resolvedSymbols.map((entity) => ({
      mention: entity.query,
      entityType: 'finance.security',
      canonicalId: entity.symbol,
      displayName: entity.name,
      attributes: {
        market: entity.market,
        assetType: entity.assetType,
        secid: entity.secid,
      },
      resolverId: 'finance.security-resolver',
      confidence: entity.confidence,
    })),
    metrics: [{ id: rewrite.analysisFocus.id, name: rewrite.analysisFocus.label }],
    dimensions: [],
    filters: [],
    timeRange: rewrite.timeRange
      ? { label: rewrite.timeRange.label, granularity: rewrite.timeRange.unit }
      : null,
    output: rewrite.outputIntent,
    domainHints: ['finance.quant', rewrite.capabilityHint],
    status: rewrite.status,
    issues: rewrite.issues.map((issue) => ({
      code: issue.code,
      message: issue.message,
      retryable: issue.retryable,
    })),
    extensions: {
      finance: {
        broadUniverse: rewrite.broadUniverse,
        safety: rewrite.safety,
        execution: rewrite.execution,
      },
    },
  };
}

export function projectFinancePlanToDataAgentPlan(plan: QuantRunPlan): DataAgentExecutionPlan {
  const composition = createQuantPilotDataAgentRegistry().resolveCapability(
    QUANTPILOT_AGENT_PROFILE.id,
    plan.requestedCapabilityId ?? plan.capabilityId,
  ).composition;
  return {
    schemaVersion: 1,
    runId: plan.runId,
    status: plan.status === 'planned'
      ? 'planned'
      : plan.status === 'refused'
        ? 'refused'
        : 'needs_clarification',
    profile: {
      id: composition.profile.id,
      version: composition.profile.version,
      domainPacks: composition.domainPacks,
      deliveryPack: composition.deliveryPack,
      compositionSha256: composition.sha256,
    },
    capabilityId: plan.requestedCapabilityId ?? plan.capabilityId,
    taskArtifact: DATA_AGENT_TASK_RELATIVE_PATH,
    domainPlanArtifact: FINANCE_RUN_PLAN_RELATIVE_PATH,
    expectedArtifacts: [...plan.expectedArtifacts],
    validationRuleIds: plan.validationRules.map((_rule, index) =>
      `finance.rule.${String(index + 1).padStart(3, '0')}`),
    createdAt: plan.createdAt,
    updatedAt: plan.updatedAt,
  };
}

export function projectFinanceProfileSelection(
  capabilityId: string,
  updatedAt: string,
  selectionSource: DataAgentProfileSelection['selectionSource'] = 'inferred',
): DataAgentProfileSelection {
  const composition = createQuantPilotDataAgentRegistry().resolveCapability(
    QUANTPILOT_AGENT_PROFILE.id,
    capabilityId,
  ).composition;
  return {
    schemaVersion: 1,
    profile: { ...QUANTPILOT_AGENT_PROFILE },
    selectedCapabilityId: capabilityId,
    composition,
    selectionSource,
    updatedAt,
  };
}
