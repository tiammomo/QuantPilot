import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

import { AkepHttpAdapter, knowledgeCompatibilityIssues } from './akep-http';
import type { KnowledgeIntegrationConfig } from './config';
import { getKnowledgeIntegrationConfig } from './config';
import { ExternalKnowledgeHttpError, KnowledgeIntegrationError } from './errors';
import type { GovernedKnowledgePort } from './port';
import type { ProjectIntegrationScope } from '@/lib/platform/context/integration-scope';
import type {
  GovernedKnowledgeCapsule,
  GovernedKnowledgePreparation,
  KnowledgeFeedbackCitation,
  KnowledgeFeedbackResult,
  KnowledgeUsageResult,
} from './types';

const BUSINESS_OUTCOME_EVALUATOR_URI = 'urn:quantpilot:evaluator:human-business-outcome:v1';
const BUSINESS_OUTCOME_EVALUATOR_DIGEST = `sha256:${createHash('sha256')
  .update('quantpilot-human-business-outcome-v1', 'utf8')
  .digest('hex')}`;

interface KnowledgeDependencies {
  config: KnowledgeIntegrationConfig;
  port: GovernedKnowledgePort;
}

function dependencies(overrides: Partial<KnowledgeDependencies> = {}): KnowledgeDependencies {
  const config = overrides.config ?? getKnowledgeIntegrationConfig();
  return {
    config,
    port: overrides.port ?? new AkepHttpAdapter(config),
  };
}

function boundedTask(value: string): string {
  const normalized = value.trim();
  if (!normalized) throw new KnowledgeIntegrationError('INVALID_KNOWLEDGE_TASK', 400, 'Knowledge task is empty.');
  return normalized.slice(0, 4_000);
}

function stableSuffix(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 16);
}

function failureCode(error: unknown): string {
  return error instanceof ExternalKnowledgeHttpError || error instanceof KnowledgeIntegrationError
    ? error.code
    : 'INTEGRATION_ERROR';
}

async function negotiate(
  runtime: KnowledgeDependencies,
  requestId?: string,
): Promise<Awaited<ReturnType<GovernedKnowledgePort['discover']>>> {
  const info = await runtime.port.discover(requestId);
  const issues = knowledgeCompatibilityIssues(info, runtime.config);
  if (issues.length > 0) {
    throw new KnowledgeIntegrationError(
      'KNOWLEDGE_INCOMPATIBLE',
      503,
      `Governed knowledge service is incompatible: ${issues.join(', ')}.`,
    );
  }
  return info;
}

function taskCategory(value: string): string {
  return value.slice(0, 255) || 'quant-research';
}

function capsuleContent(pack: Awaited<ReturnType<GovernedKnowledgePort['createContextPack']>>): string {
  return JSON.stringify({
    schemaVersion: 1,
    provider: 'akep-http-v0.1',
    contextPackId: pack.contextPackId,
    contextDigest: pack.contextDigest,
    policyEpoch: pack.policyEpoch,
    purpose: pack.purpose,
    quality: pack.quality,
    warnings: pack.warnings,
    passages: pack.passages.map((item) => ({
      citationId: item.citationId,
      title: item.title,
      text: item.text,
      rank: item.rank,
      score: item.score,
      revisionId: item.revisionId,
      spaceId: item.spaceId,
    })),
    citations: pack.citations,
    obligations: pack.obligations,
  });
}

export async function inspectGovernedKnowledge(
  requestId?: string,
  overrides: Partial<KnowledgeDependencies> = {},
): Promise<void> {
  const runtime = dependencies(overrides);
  if (!runtime.config.enabled) return;
  await negotiate(runtime, requestId);
  await runtime.port.checkReady(requestId);
}

export async function prepareGovernedKnowledge(input: {
  task: string;
  requestId: string;
  scope: ProjectIntegrationScope;
}, overrides: Partial<KnowledgeDependencies> = {}): Promise<GovernedKnowledgePreparation> {
  const runtime = dependencies(overrides);
  if (!runtime.config.enabled) {
    return { status: 'disabled', capsule: null, passageCount: 0, citationCount: 0 };
  }
  try {
    await negotiate(runtime, input.requestId);
    const pack = await runtime.port.createContextPack({
      task: boundedTask(input.task),
      purpose: runtime.config.purpose,
      spaces: input.scope.knowledge.requestedSpaceIds,
      maxCharacters: runtime.config.maxContextCharacters,
      supportedObligations: [...runtime.config.supportedObligations],
    }, input.requestId);
    if (pack.purpose !== runtime.config.purpose) {
      throw new KnowledgeIntegrationError('KNOWLEDGE_PURPOSE_MISMATCH', 502, 'AKEP returned a mismatched purpose.');
    }
    const unexpectedSpace = [...pack.passages, ...pack.citations].find(
      (item) => !input.scope.knowledge.requestedSpaceIds.includes(item.spaceId),
    );
    if (unexpectedSpace) {
      throw new KnowledgeIntegrationError(
        'KNOWLEDGE_SCOPE_MISMATCH',
        502,
        'AKEP returned content outside the requested project knowledge scope.',
      );
    }
    if (pack.passages.length === 0 || pack.citations.length === 0) {
      return {
        status: 'empty',
        capsule: null,
        passageCount: pack.passages.length,
        citationCount: pack.citations.length,
      };
    }
    const content = capsuleContent(pack);
    const capsule: GovernedKnowledgeCapsule = {
      content,
      contextPackId: pack.contextPackId,
      contextDigest: pack.contextDigest,
      exposureReceiptId: pack.exposureReceiptId,
      policyEpoch: pack.policyEpoch,
      purpose: pack.purpose,
      citations: pack.citations,
      obligations: pack.obligations,
      qualityDecision: pack.quality.decision,
      warningCodes: pack.warnings.map((warning) => warning.code),
      integrationScopeSha256: input.scope.scopeSha256,
      consumerId: input.scope.consumerId,
      requestedSpaceIds: input.scope.knowledge.requestedSpaceIds,
      projectSpaceId: input.scope.knowledge.projectSpaceId,
    };
    return {
      status: 'prepared',
      capsule,
      passageCount: pack.passages.length,
      citationCount: pack.citations.length,
    };
  } catch (error) {
    if (runtime.config.required) {
      throw new KnowledgeIntegrationError(
        'KNOWLEDGE_REQUIRED_UNAVAILABLE',
        503,
        'Required governed knowledge is unavailable.',
      );
    }
    const code = failureCode(error);
    console.warn('[GovernedKnowledge] Optional integration degraded.', { code });
    return { status: 'unavailable', capsule: null, passageCount: 0, citationCount: 0, failureCode: code };
  }
}

export async function recordGovernedKnowledgeUsage(input: {
  capsule: GovernedKnowledgeCapsule | null;
  requestId: string;
  taskCategory: string;
  occurredAt?: string;
}, overrides: Partial<KnowledgeDependencies> = {}): Promise<KnowledgeUsageResult> {
  const runtime = dependencies(overrides);
  if (!runtime.config.enabled) return { status: 'disabled', usageReceipts: [] };
  if (!input.capsule || input.capsule.citations.length === 0) {
    return { status: 'not_applicable', usageReceipts: [] };
  }
  try {
    await negotiate(runtime, input.requestId);
    const bySpace = new Map<string, typeof input.capsule.citations>();
    for (const citation of input.capsule.citations) {
      const current = bySpace.get(citation.spaceId) ?? [];
      bySpace.set(citation.spaceId, [...current, citation]);
    }
    const occurredAt = input.occurredAt ?? new Date().toISOString();
    const usageReceipts = [];
    for (const [spaceId, citations] of bySpace) {
      const suffix = stableSuffix(spaceId);
      const receipt = await runtime.port.recordUsage({
        clientUsageId: `quantpilot:${input.requestId}:${suffix}`,
        exposureReceiptId: input.capsule.exposureReceiptId,
        spaceId,
        citations: citations.map((citation) => ({
          citationId: citation.citationId,
          revisionId: citation.revisionId,
          payloadDigest: citation.payloadDigest,
          locator: citation.locator,
          influence: 'seen' as const,
        })),
        taskCategory: taskCategory(input.taskCategory),
        purpose: input.capsule.purpose,
        contextDigest: input.capsule.contextDigest,
        occurredAt,
      }, `quantpilot-knowledge-usage-${input.requestId}-${suffix}`, input.requestId);
      if (
        receipt.exposureReceiptId !== input.capsule.exposureReceiptId
        || receipt.spaceId !== spaceId
        || receipt.policyEpoch !== input.capsule.policyEpoch
      ) {
        throw new KnowledgeIntegrationError(
          'KNOWLEDGE_USAGE_MISMATCH',
          502,
          'Knowledge usage receipt does not match the delivered context.',
        );
      }
      usageReceipts.push(receipt);
    }
    return { status: 'recorded', usageReceipts };
  } catch (error) {
    const code = failureCode(error);
    console.warn('[GovernedKnowledge] Usage evidence could not be recorded.', { code });
    return { status: 'unavailable', usageReceipts: [], failureCode: code };
  }
}

export async function recordGovernedKnowledgeFeedback(input: {
  citations: KnowledgeFeedbackCitation[];
  contextDigest: string;
  usage: KnowledgeUsageResult;
  requestId: string;
  taskCategory: string;
  eventId: string;
  outcome: KnowledgeFeedbackResult['outcome'];
  acceptedReceiptId: string;
  acceptedReceiptSha256: string;
  observedAt?: string;
}, overrides: Partial<KnowledgeDependencies> = {}): Promise<KnowledgeFeedbackResult> {
  if (input.usage.status !== 'recorded' || input.citations.length === 0) {
    return { status: 'not_applicable', outcome: input.outcome, feedbackReceipts: [] };
  }
  const runtime = dependencies(overrides);
  if (!runtime.config.enabled) {
    return { status: 'not_applicable', outcome: input.outcome, feedbackReceipts: [] };
  }
  try {
    const info = await negotiate(runtime, input.requestId);
    if (!info.operations.includes('feedback')) {
      throw new KnowledgeIntegrationError(
        'KNOWLEDGE_FEEDBACK_INCOMPATIBLE',
        503,
        'Governed knowledge service does not advertise feedback.',
      );
    }
    const feedbackReceipts = [];
    for (const usage of input.usage.usageReceipts) {
      const citations = input.citations.filter(
        (citation) => citation.spaceId === usage.spaceId,
      );
      if (citations.length === 0) {
        throw new KnowledgeIntegrationError(
          'KNOWLEDGE_FEEDBACK_MISMATCH',
          502,
          'Knowledge usage receipt has no matching delivered citations.',
        );
      }
      const suffix = stableSuffix(`${input.requestId}:${usage.usageId}`);
      const feedbackId = `urn:quantpilot:knowledge-feedback:${suffix}`;
      const receipt = await runtime.port.recordFeedback({
        feedbackId,
        usageId: usage.usageId,
        citations: citations.map((citation) => ({
          citationId: citation.citationId,
          revisionId: citation.revisionId,
          payloadDigest: citation.payloadDigest,
          locator: citation.locator,
        })),
        taskCategory: taskCategory(input.taskCategory),
        outcome: input.outcome,
        metrics: [{
          name: 'business.user_outcome',
          value: input.outcome === 'helped' ? 1 : input.outcome === 'harmed' ? -1 : 0,
          unit: 'score',
        }],
        evaluatorVersion: {
          uri: BUSINESS_OUTCOME_EVALUATOR_URI,
          digest: BUSINESS_OUTCOME_EVALUATOR_DIGEST,
        },
        contextDigest: input.contextDigest,
        evidenceRefs: [
          `urn:quantpilot:mission-receipt:${stableSuffix(
            `${input.acceptedReceiptId}:${input.acceptedReceiptSha256}`,
          )}`,
          `urn:quantpilot:business-feedback:${stableSuffix(input.eventId)}`,
        ],
        observedAt: input.observedAt ?? new Date().toISOString(),
        privacy: { rawTaskStored: false, aggregation: 'pseudonymized' },
      }, `quantpilot-knowledge-feedback-${input.requestId}-${suffix}`, input.requestId);
      if (
        receipt.feedbackId !== feedbackId
        || receipt.usageId !== usage.usageId
        || receipt.evaluatorVersion.uri !== BUSINESS_OUTCOME_EVALUATOR_URI
        || receipt.evaluatorVersion.digest !== BUSINESS_OUTCOME_EVALUATOR_DIGEST
      ) {
        throw new KnowledgeIntegrationError(
          'KNOWLEDGE_FEEDBACK_MISMATCH',
          502,
          'Knowledge feedback receipt does not match the submitted Mission evidence.',
        );
      }
      feedbackReceipts.push(receipt);
    }
    return { status: 'recorded', outcome: input.outcome, feedbackReceipts };
  } catch (error) {
    const code = failureCode(error);
    console.warn('[GovernedKnowledge] Business outcome evidence could not be recorded.', { code });
    return {
      status: 'unavailable',
      outcome: input.outcome,
      feedbackReceipts: [],
      failureCode: code,
    };
  }
}

export async function writeGovernedKnowledgeEvidence(input: {
  projectPath: string;
  requestId: string;
  preparation: GovernedKnowledgePreparation;
  usage?: KnowledgeUsageResult;
}): Promise<void> {
  const evidenceDir = path.join(input.projectPath, 'evidence');
  const target = path.join(evidenceDir, 'knowledge-sources.json');
  const temporary = `${target}.${process.pid}.tmp`;
  const capsule = input.preparation.capsule;
  const document = {
    schemaVersion: 1,
    provider: 'akep-http-v0.1',
    requestId: input.requestId,
    status: input.preparation.status,
    passageCount: input.preparation.passageCount,
    citationCount: input.preparation.citationCount,
    ...(input.preparation.failureCode ? { failureCode: input.preparation.failureCode } : {}),
    ...(capsule
      ? {
          contextPackId: capsule.contextPackId,
          contextDigest: capsule.contextDigest,
          exposureReceiptId: capsule.exposureReceiptId,
          policyEpoch: capsule.policyEpoch,
          purpose: capsule.purpose,
          qualityDecision: capsule.qualityDecision,
          obligations: capsule.obligations,
          warningCodes: capsule.warningCodes,
          citations: capsule.citations,
        }
      : { citations: [] }),
    ...(input.usage ? { usage: input.usage } : {}),
    recordedAt: new Date().toISOString(),
  };
  await fs.mkdir(evidenceDir, { recursive: true });
  await fs.writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await fs.rename(temporary, target);
}
