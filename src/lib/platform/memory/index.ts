export { getMemoryIntegrationConfig, type MemoryIntegrationConfig } from './config';
export { EvolvableMemoryHttpAdapter } from './evolvable-memory-http';
export { ExternalMemoryHttpError } from './errors';
export { memoryCompatibilityIssues } from './compatibility';
export type { PersonalMemoryPort } from './port';
export {
  PERSONAL_MEMORY_CONTROL_POLICY,
  PrismaPersonalMemoryControlRepository,
  type PersonalMemoryControlState,
  type PersonalMemoryControlUpdate,
} from './control';
export {
  correctPersonalPreference,
  exposePersonalization,
  getPersonalMemoryUseAttribution,
  getPersonalMemoryControl,
  getPersonalMemoryValueSummary,
  getPersonalPreferenceRevisions,
  inspectPersonalMemory,
  listPersonalPreferences,
  MemoryIntegrationError,
  recallPersonalization,
  recordPersonalMemoryFeedback,
  rememberPersonalPreference,
  setPersonalMemoryEnabled,
  type PersonalMemoryValueSummary,
} from './service';
export {
  PersonalMemoryFeedbackConflictError,
  PrismaPersonalMemoryFeedbackRepository,
  type PersonalMemoryFeedbackReceipt,
  type PersonalMemoryFeedbackRepository,
  type PersonalMemoryFeedbackSummary,
} from './feedback-repository';
export {
  MEMORY_HTTP_CONTRACT,
  MEMORY_PROVIDER_ID,
  MEMORY_CAPABILITY,
  MEMORY_CHAT_CAPABILITIES,
  MEMORY_INTEGRATION_CAPABILITIES,
  type MemoryCapability,
  type MemoryOutcomeKind,
  type PersonalizationCapsule,
  type PersonalizationRecallResult,
  type PreparedPersonalizationUse,
} from './types';
