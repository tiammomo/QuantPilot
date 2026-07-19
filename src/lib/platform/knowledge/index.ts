export { AkepHttpAdapter, knowledgeCompatibilityIssues } from './akep-http';
export { getKnowledgeIntegrationConfig, type KnowledgeIntegrationConfig } from './config';
export { ExternalKnowledgeHttpError, KnowledgeIntegrationError } from './errors';
export type { GovernedKnowledgePort } from './port';
export {
  inspectGovernedKnowledge,
  prepareGovernedKnowledge,
  recordGovernedKnowledgeUsage,
  writeGovernedKnowledgeEvidence,
} from './service';
export {
  AKEP_PROTOCOL,
  AKEP_VERSION,
  type GovernedKnowledgeCapsule,
  type GovernedKnowledgePreparation,
  type KnowledgeUsageResult,
} from './types';
