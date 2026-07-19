export const AKEP_PROTOCOL = 'akep' as const;
export const AKEP_VERSION = '0.1' as const;
export const AKEP_CONTEXT_EXTENSION_SUFFIX = '/extensions/akep/context-pack/0.1' as const;

export type KnowledgeQualityDecision = 'suitable' | 'suitable_with_warning' | 'insufficient';

export interface KnowledgeServiceInfo {
  protocol: typeof AKEP_PROTOCOL;
  versions: string[];
  operations: string[];
  profiles: string[];
  supportedExtensions: string[];
  baseUrl: string;
  expiresAt: string;
}

export interface KnowledgeCitation {
  citationId: string;
  chunkId: string;
  payloadDigest: string;
  locator: Record<string, unknown>;
  quote: string;
  recordId: string;
  revisionId: string;
  spaceId: string;
}

export interface KnowledgePassage {
  citationId: string;
  chunkId: string;
  rank: number;
  recordId: string;
  revisionId: string;
  score: number;
  spaceId: string;
  text: string;
  title: string;
}

export interface KnowledgeContextPack {
  contextPackId: string;
  contextDigest: string;
  createdAt: string;
  exposureReceiptId: string;
  policyEpoch: string;
  purpose: string;
  passages: KnowledgePassage[];
  citations: KnowledgeCitation[];
  obligations: unknown[];
  quality: {
    decision: KnowledgeQualityDecision;
    reasons: string[];
    citationCoverage: number;
    lexicalCoverage: number;
  };
  warnings: Array<{ code: string; message: string; revisionIds: string[] }>;
}

export interface GovernedKnowledgeCapsule {
  content: string;
  contextPackId: string;
  contextDigest: string;
  exposureReceiptId: string;
  policyEpoch: string;
  purpose: string;
  citations: KnowledgeCitation[];
  obligations: unknown[];
  qualityDecision: KnowledgeQualityDecision;
  warningCodes: string[];
  integrationScopeSha256: string;
  consumerId: string;
  requestedSpaceIds: string[];
  projectSpaceId: string | null;
}

export type GovernedKnowledgeStatus =
  | 'disabled'
  | 'unavailable'
  | 'empty'
  | 'prepared';

export interface GovernedKnowledgePreparation {
  status: GovernedKnowledgeStatus;
  capsule: GovernedKnowledgeCapsule | null;
  passageCount: number;
  citationCount: number;
  failureCode?: string;
}

export interface KnowledgeUsageReceipt {
  usageId: string;
  exposureReceiptId: string;
  spaceId: string;
  policyEpoch: string;
  createdAt: string;
  feedbackUntil: string;
}

export interface KnowledgeFeedbackReceipt {
  feedbackId: string;
  usageId: string;
  evidenceId: string;
  policyEpoch: string;
  receivedAt: string;
  status: 'recorded';
  correlationClass: string;
  eligibleForAggregation: boolean;
  evaluatorVersion: { uri: string; digest: string };
}

export interface KnowledgeFeedbackCitation {
  citationId: string;
  payloadDigest: string;
  locator: Record<string, unknown>;
  revisionId: string;
  spaceId: string;
}

export type KnowledgeFeedbackOutcome = 'helped' | 'neutral' | 'harmed';

export interface KnowledgeFeedbackResult {
  status: 'not_applicable' | 'recorded' | 'unavailable';
  outcome: KnowledgeFeedbackOutcome;
  feedbackReceipts: KnowledgeFeedbackReceipt[];
  failureCode?: string;
}

export interface KnowledgeUsageResult {
  status: 'disabled' | 'not_applicable' | 'recorded' | 'unavailable';
  usageReceipts: KnowledgeUsageReceipt[];
  failureCode?: string;
}
