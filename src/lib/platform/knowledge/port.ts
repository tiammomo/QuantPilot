import type {
  KnowledgeContextPack,
  KnowledgeFeedbackReceipt,
  KnowledgeServiceInfo,
  KnowledgeUsageReceipt,
} from './types';

export interface KnowledgeContextInput {
  task: string;
  purpose: string;
  spaces: string[];
  maxCharacters: number;
  supportedObligations: unknown[];
}

export interface KnowledgeUsageInput {
  clientUsageId: string;
  exposureReceiptId: string;
  spaceId: string;
  citations: Array<{
    citationId: string;
    revisionId: string;
    payloadDigest: string;
    locator: Record<string, unknown>;
    influence: 'primary' | 'supporting' | 'seen';
  }>;
  taskCategory: string;
  purpose: string;
  contextDigest: string;
  occurredAt: string;
}

export interface KnowledgeFeedbackInput {
  feedbackId: string;
  usageId: string;
  citations: Array<{
    citationId: string;
    revisionId: string;
    payloadDigest: string;
    locator: Record<string, unknown>;
  }>;
  taskCategory: string;
  outcome: 'helped' | 'neutral' | 'harmed' | 'unknown';
  metrics: Array<{ name: string; value: number; unit?: string }>;
  evaluatorVersion: { uri: string; digest: string };
  contextDigest: string;
  evidenceRefs: string[];
  observedAt: string;
  privacy: {
    rawTaskStored: boolean;
    aggregation: 'none' | 'pseudonymized' | 'aggregated';
  };
}

export interface GovernedKnowledgePort {
  discover(requestId?: string): Promise<KnowledgeServiceInfo>;
  checkReady(requestId?: string): Promise<void>;
  createContextPack(input: KnowledgeContextInput, requestId?: string): Promise<KnowledgeContextPack>;
  recordUsage(
    input: KnowledgeUsageInput,
    idempotencyKey: string,
    requestId?: string,
  ): Promise<KnowledgeUsageReceipt>;
  recordFeedback(
    input: KnowledgeFeedbackInput,
    idempotencyKey: string,
    requestId?: string,
  ): Promise<KnowledgeFeedbackReceipt>;
}
