export { AkepHttpAdapter, knowledgeCompatibilityIssues } from './akep-http';
export { getKnowledgeIntegrationConfig, type KnowledgeIntegrationConfig } from './config';
export { ExternalKnowledgeHttpError, KnowledgeIntegrationError } from './errors';
export {
  getGovernedKnowledgeAttribution,
  persistAcceptedGovernedKnowledgeUse,
  recordGovernedKnowledgeBusinessFeedback,
  GovernedKnowledgeFeedbackConflictError,
  GovernedKnowledgeGrowthInputError,
  GovernedKnowledgeGrowthUnavailableError,
  GovernedKnowledgeUseNotFoundError,
  type GovernedKnowledgeAttribution,
} from './growth';
export type { GovernedKnowledgePort } from './port';
export {
  inspectGovernedKnowledge,
  prepareGovernedKnowledge,
  recordGovernedKnowledgeFeedback,
  recordGovernedKnowledgeUsage,
  writeGovernedKnowledgeEvidence,
} from './service';
export {
  AKEP_PROTOCOL,
  AKEP_VERSION,
  type GovernedKnowledgeCapsule,
  type GovernedKnowledgePreparation,
  type KnowledgeFeedbackCitation,
  type KnowledgeFeedbackOutcome,
  type KnowledgeFeedbackResult,
  type KnowledgeUsageResult,
} from './types';
