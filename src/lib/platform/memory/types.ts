export const MEMORY_HTTP_CONTRACT = 'evolvable-memory-http/v1' as const;
export const MEMORY_PROVIDER_ID = 'evolvable-memory-http-v1' as const;
export const MEMORY_CAPABILITY = {
  preferenceWrite: 'preference.write',
  preferenceList: 'preference.list',
  preferenceCorrect: 'preference.correct',
  preferenceHistory: 'preference.history',
  recallTrace: 'recall.trace',
  recallBitemporal: 'recall.bitemporal',
  recallContextProjection: 'recall.context-projection',
  experienceUsageReceipt: 'experience.usage-receipt',
  experienceOutcome: 'experience.outcome',
} as const;
export type MemoryCapability = (typeof MEMORY_CAPABILITY)[keyof typeof MEMORY_CAPABILITY];
export const MEMORY_INTEGRATION_CAPABILITIES = Object.freeze(
  Object.values(MEMORY_CAPABILITY),
) as readonly MemoryCapability[];
export const MEMORY_CHAT_CAPABILITIES = Object.freeze([
  MEMORY_CAPABILITY.recallTrace,
  MEMORY_CAPABILITY.recallBitemporal,
  MEMORY_CAPABILITY.recallContextProjection,
  MEMORY_CAPABILITY.experienceUsageReceipt,
]) as readonly MemoryCapability[];

export type MemoryContext = Record<string, string>;
export type MemoryOutcomeKind = 'helpful' | 'accepted' | 'harmful' | 'rejected' | 'corrected';

export interface MemoryServiceInfo {
  name: string;
  version: string;
  apiContract: typeof MEMORY_HTTP_CONTRACT;
  capabilities: string[];
  authMode: string;
  scopeSource: string;
  productionReady: boolean;
  productionBlockers: string[];
}

export interface MemoryPreferenceSummary {
  recordId: string;
  revisionId: string;
  sequence: number;
  key: string;
  value: string;
  context: MemoryContext;
  confidence: number;
  supportCount: number;
  evidenceCount: number;
  validFrom: string;
  recordedAt: string;
}

export interface MemoryRevision {
  id: string;
  sequence: number;
  value: string;
  confidence: number;
  supportCount: number;
  contradictionCount: number;
  evidenceIds: string[];
  validFrom: string;
  recordedAt: string;
  supersedesRevisionId: string | null;
}

export interface MemoryWriteResult {
  observationId: string;
  candidateId: string;
  recordId: string;
  revisionId: string;
  sequence: number;
  idempotentReplay: boolean;
}

export interface MemoryRecallItem {
  recordId: string;
  revisionId: string;
  key: string;
  value: string;
  context: MemoryContext;
  rank: number;
  score: number;
}

export interface MemoryRecallResult {
  traceId: string;
  policyId: string;
  policyVersion: number;
  validAt: string;
  knownAt: string;
  createdAt: string;
  items: MemoryRecallItem[];
}

export interface MemoryProjectionSource {
  recordId: string;
  revisionId: string;
  rank: number;
  score: number;
}

export interface MemoryProjectionSegment {
  content: string;
  sources: MemoryProjectionSource[];
}

export interface MemoryProjectionResult {
  traceId: string;
  policyId: string;
  policyVersion: number;
  content: string;
  segments: MemoryProjectionSegment[];
  sourceRevisionIds: string[];
  projectionSha256: string;
}

export interface PersonalizationCapsule {
  content: string;
  traceId: string;
  revisionIds: string[];
  sourceProjectionSha256: string;
  contentSha256: string;
  usageId?: string;
}

export type PersonalizationRecallStatus =
  | 'disabled'
  | 'opted_out'
  | 'unavailable'
  | 'empty'
  | 'prepared';

export interface PreparedPersonalizationUse {
  tenantId: string;
  subjectId: string;
  traceId: string;
  policyId: string;
  policyVersion: number;
  validAt: string;
  knownAt: string;
  algorithm: ProjectMemoryInput['algorithm'];
  maxCharacters: number;
  sourceProjectionSha256: string;
  deliveredContextSha256: string;
  exposedRevisionIds: string[];
}

export interface RecordMemoryUsageInput {
  tenantId: string;
  subjectId: string;
  traceId: string;
  algorithm: ProjectMemoryInput['algorithm'];
  maxCharacters: number;
  sourceProjectionSha256: string;
  deliveredContextSha256: string;
  revisionIds: string[];
  idempotencyKey: string;
  purpose: string;
  occurredAt?: string;
}

export interface MemoryUsageResult {
  usageId: string;
  traceId: string;
  algorithm: ProjectMemoryInput['algorithm'];
  maxCharacters: number;
  sourceProjectionSha256: string;
  deliveredContextSha256: string;
  revisionIds: string[];
  occurredAt: string;
  recordedAt: string;
  idempotentReplay: boolean;
}

export interface PersonalizationRecallResult {
  status: PersonalizationRecallStatus;
  capsule: PersonalizationCapsule | null;
  exposedMemoryCount: number;
  preparedUse: PreparedPersonalizationUse | null;
}

export interface RememberPreferenceInput {
  tenantId: string;
  subjectId: string;
  source: string;
  idempotencyKey: string;
  key: string;
  value: string;
  context: MemoryContext;
  evidenceText: string;
  confidence: number;
  purpose: string;
  occurredAt?: string;
}

export interface CorrectPreferenceInput {
  tenantId: string;
  subjectId: string;
  recordId: string;
  source: string;
  idempotencyKey: string;
  value: string;
  evidenceText: string;
  reason: string;
  purpose: string;
  occurredAt?: string;
  expectedRevisionId?: string;
}

export interface RecallMemoryInput {
  tenantId: string;
  subjectId: string;
  query: string;
  context: MemoryContext;
  limit: number;
  purpose: string;
}

export interface ProjectMemoryInput {
  tenantId: string;
  subjectId: string;
  traceId: string;
  algorithm: 'ranked-extractive-v1' | 'exact-deduplicated-v1';
  maxCharacters: number;
  purpose: string;
}

export interface RecordMemoryOutcomeInput {
  tenantId: string;
  subjectId: string;
  traceId: string;
  revisionId: string;
  usageId?: string;
  kind: MemoryOutcomeKind;
  idempotencyKey: string;
  weight: number;
  purpose: string;
  note?: string;
  occurredAt?: string;
}

export interface MemoryOutcomeResult {
  outcomeId: string;
  idempotentReplay: boolean;
}
