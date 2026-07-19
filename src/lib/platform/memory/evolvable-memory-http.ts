import type { MemoryIntegrationConfig } from './config';
import { ExternalMemoryHttpError } from './errors';
import type { PersonalMemoryPort } from './port';
import {
  createMemoryAccessTokenProvider,
  type MemoryAccessTokenProvider,
  type MemoryTokenScope,
} from './token-provider';
import {
  type CorrectPreferenceInput,
  type MemoryContext,
  type MemoryOutcomeResult,
  type MemoryPreferenceSummary,
  type MemoryProjectionResult,
  type MemoryRecallResult,
  type MemoryRevision,
  type MemoryServiceInfo,
  type MemoryWriteResult,
  type ProjectMemoryInput,
  type RecallMemoryInput,
  type RecordMemoryOutcomeInput,
  type RememberPreferenceInput,
} from './types';

type Fetcher = typeof fetch;
type JsonRecord = Record<string, unknown>;

const MAX_RESPONSE_CHARACTERS = 1_500_000;

function record(value: unknown, label: string): JsonRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ExternalMemoryHttpError(`Invalid ${label} response.`, null, 'INVALID_RESPONSE', null);
  }
  return value as JsonRecord;
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value) {
    throw new ExternalMemoryHttpError(`Invalid ${label} response.`, null, 'INVALID_RESPONSE', null);
  }
  return value;
}

function numberValue(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ExternalMemoryHttpError(`Invalid ${label} response.`, null, 'INVALID_RESPONSE', null);
  }
  return value;
}

function integer(value: unknown, label: string): number {
  const parsed = numberValue(value, label);
  if (!Number.isInteger(parsed)) {
    throw new ExternalMemoryHttpError(`Invalid ${label} response.`, null, 'INVALID_RESPONSE', null);
  }
  return parsed;
}

function booleanValue(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') {
    throw new ExternalMemoryHttpError(`Invalid ${label} response.`, null, 'INVALID_RESPONSE', null);
  }
  return value;
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    throw new ExternalMemoryHttpError(`Invalid ${label} response.`, null, 'INVALID_RESPONSE', null);
  }
  return [...value];
}

function context(value: unknown): MemoryContext {
  const source = record(value, 'context');
  if (!Object.values(source).every((item) => typeof item === 'string')) {
    throw new ExternalMemoryHttpError('Invalid context response.', null, 'INVALID_RESPONSE', null);
  }
  return source as MemoryContext;
}

function optionalText(value: unknown): string | null {
  return value === null || value === undefined ? null : text(value, 'optional text');
}

function requestHeader(value: string | undefined): string | null {
  if (!value) return null;
  const normalized = value.replace(/[^A-Za-z0-9._:-]/g, '-').slice(0, 64);
  return normalized || null;
}

function mapWrite(value: unknown): MemoryWriteResult {
  const data = record(value, 'memory write');
  return {
    observationId: text(data.observation_id, 'observation_id'),
    candidateId: text(data.candidate_id, 'candidate_id'),
    recordId: text(data.record_id, 'record_id'),
    revisionId: text(data.revision_id, 'revision_id'),
    sequence: integer(data.sequence, 'sequence'),
    idempotentReplay: booleanValue(data.idempotent_replay, 'idempotent_replay'),
  };
}

function mapSummary(value: unknown): MemoryPreferenceSummary {
  const data = record(value, 'preference summary');
  return {
    recordId: text(data.record_id, 'record_id'),
    revisionId: text(data.revision_id, 'revision_id'),
    sequence: integer(data.sequence, 'sequence'),
    key: text(data.key, 'key'),
    value: text(data.value, 'value'),
    context: context(data.context),
    confidence: numberValue(data.confidence, 'confidence'),
    supportCount: integer(data.support_count, 'support_count'),
    evidenceCount: integer(data.evidence_count, 'evidence_count'),
    validFrom: text(data.valid_from, 'valid_from'),
    recordedAt: text(data.recorded_at, 'recorded_at'),
  };
}

function mapRevision(value: unknown): MemoryRevision {
  const data = record(value, 'revision');
  return {
    id: text(data.id, 'id'),
    sequence: integer(data.sequence, 'sequence'),
    value: text(data.value, 'value'),
    confidence: numberValue(data.confidence, 'confidence'),
    supportCount: integer(data.support_count, 'support_count'),
    contradictionCount: integer(data.contradiction_count, 'contradiction_count'),
    evidenceIds: stringArray(data.evidence_ids, 'evidence_ids'),
    validFrom: text(data.valid_from, 'valid_from'),
    recordedAt: text(data.recorded_at, 'recorded_at'),
    supersedesRevisionId: optionalText(data.supersedes_revision_id),
  };
}

export class EvolvableMemoryHttpAdapter implements PersonalMemoryPort {
  constructor(
    private readonly config: MemoryIntegrationConfig,
    private readonly fetcher: Fetcher = fetch,
    private readonly tokens: MemoryAccessTokenProvider = createMemoryAccessTokenProvider(
      config,
      fetcher,
    ),
  ) {}

  private accessToken(scope: MemoryTokenScope, requestId?: string): Promise<string | null> {
    return this.tokens.tokenFor(scope, requestId);
  }

  private async request(
    path: string,
    options: {
      method?: 'GET' | 'POST';
      body?: unknown;
      query?: URLSearchParams;
      requestId?: string;
      accessToken?: string | null;
    } = {},
  ): Promise<unknown> {
    const relativePath = path === '/' ? '' : path.replace(/^\/+/, '');
    const url = new URL(relativePath, `${this.config.apiUrl}/`);
    if (options.query) url.search = options.query.toString();
    const headers = new Headers({ Accept: 'application/json' });
    const correlationId = requestHeader(options.requestId);
    if (correlationId) headers.set('X-Request-ID', correlationId);
    if (options.accessToken) {
      headers.set('Authorization', `Bearer ${options.accessToken}`);
    }
    if (options.body !== undefined) headers.set('Content-Type', 'application/json');

    let response: Response;
    try {
      response = await this.fetcher(url, {
        method: options.method ?? 'GET',
        headers,
        cache: 'no-store',
        signal: AbortSignal.timeout(this.config.timeoutMs),
        ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
      });
    } catch (error) {
      throw new ExternalMemoryHttpError(
        'External memory service is unavailable.',
        null,
        error instanceof DOMException && error.name === 'TimeoutError' ? 'TIMEOUT' : 'NETWORK_ERROR',
        correlationId,
      );
    }

    const responseRequestId = response.headers.get('x-request-id') || correlationId;
    const raw = await response.text();
    if (raw.length > MAX_RESPONSE_CHARACTERS) {
      throw new ExternalMemoryHttpError(
        'External memory response exceeded the client limit.',
        response.status,
        'RESPONSE_TOO_LARGE',
        responseRequestId,
      );
    }
    let payload: unknown = null;
    if (raw) {
      try {
        payload = JSON.parse(raw) as unknown;
      } catch {
        throw new ExternalMemoryHttpError(
          'External memory returned invalid JSON.',
          response.status,
          'INVALID_JSON',
          responseRequestId,
        );
      }
    }
    if (!response.ok) {
      const errorPayload = payload !== null && typeof payload === 'object' && !Array.isArray(payload)
        ? payload as JsonRecord
        : {};
      throw new ExternalMemoryHttpError(
        'External memory request was rejected.',
        response.status,
        typeof errorPayload.error === 'string' ? errorPayload.error : 'HTTP_ERROR',
        responseRequestId,
      );
    }
    return payload;
  }

  async discover(requestId?: string): Promise<MemoryServiceInfo> {
    const data = record(await this.request('/', { requestId }), 'service discovery');
    const apiContract = text(data.api_contract, 'api_contract');
    if (apiContract !== this.config.expectedContract) {
      throw new ExternalMemoryHttpError(
        'External memory contract is incompatible.',
        200,
        'INCOMPATIBLE_CONTRACT',
        requestHeader(requestId),
      );
    }
    return {
      name: text(data.name, 'name'),
      version: text(data.version, 'version'),
      apiContract,
      capabilities: stringArray(data.capabilities, 'capabilities'),
      authMode: text(data.auth_mode, 'auth_mode'),
      scopeSource: text(data.scope_source, 'scope_source'),
      productionReady: booleanValue(data.production_ready, 'production_ready'),
      productionBlockers: stringArray(data.production_blockers, 'production_blockers'),
    };
  }

  async checkReady(requestId?: string): Promise<void> {
    const data = record(await this.request('/readyz', { requestId }), 'readiness');
    if (data.status !== 'ready') {
      throw new ExternalMemoryHttpError(
        'External memory service is not ready.',
        503,
        'NOT_READY',
        requestHeader(requestId),
      );
    }
  }

  async listPreferences(
    scope: { tenantId: string; subjectId: string; purpose: string },
    requestId?: string,
  ): Promise<MemoryPreferenceSummary[]> {
    const accessToken = await this.accessToken(scope, requestId);
    const query = new URLSearchParams({
      tenant_id: scope.tenantId,
      subject_id: scope.subjectId,
      purpose: scope.purpose,
    });
    const data = await this.request('/v1/preferences', { query, requestId, accessToken });
    if (!Array.isArray(data)) throw new ExternalMemoryHttpError('Invalid preference list.', null, 'INVALID_RESPONSE', null);
    return data.map(mapSummary);
  }

  async rememberPreference(input: RememberPreferenceInput, requestId?: string): Promise<MemoryWriteResult> {
    const accessToken = await this.accessToken(input, requestId);
    return mapWrite(await this.request('/v1/preferences', {
      method: 'POST',
      requestId,
      accessToken,
      body: {
        tenant_id: input.tenantId,
        subject_id: input.subjectId,
        source: input.source,
        idempotency_key: input.idempotencyKey,
        key: input.key,
        value: input.value,
        context: input.context,
        evidence_text: input.evidenceText,
        confidence: input.confidence,
        purpose: input.purpose,
        ...(input.occurredAt ? { occurred_at: input.occurredAt } : {}),
      },
    }));
  }

  async correctPreference(input: CorrectPreferenceInput, requestId?: string): Promise<MemoryWriteResult> {
    const accessToken = await this.accessToken(input, requestId);
    return mapWrite(await this.request(
      `/v1/preferences/${encodeURIComponent(input.recordId)}/corrections`,
      {
        method: 'POST',
        requestId,
        accessToken,
        body: {
          tenant_id: input.tenantId,
          subject_id: input.subjectId,
          source: input.source,
          idempotency_key: input.idempotencyKey,
          value: input.value,
          evidence_text: input.evidenceText,
          reason: input.reason,
          purpose: input.purpose,
          ...(input.occurredAt ? { occurred_at: input.occurredAt } : {}),
          ...(input.expectedRevisionId ? { expected_revision_id: input.expectedRevisionId } : {}),
        },
      },
    ));
  }

  async getRevisions(
    scope: { tenantId: string; subjectId: string; purpose: string; recordId: string },
    requestId?: string,
  ): Promise<MemoryRevision[]> {
    const accessToken = await this.accessToken(scope, requestId);
    const query = new URLSearchParams({
      tenant_id: scope.tenantId,
      subject_id: scope.subjectId,
      purpose: scope.purpose,
    });
    const data = await this.request(
      `/v1/preferences/${encodeURIComponent(scope.recordId)}/revisions`,
      { query, requestId, accessToken },
    );
    if (!Array.isArray(data)) throw new ExternalMemoryHttpError('Invalid revision list.', null, 'INVALID_RESPONSE', null);
    return data.map(mapRevision);
  }

  async recall(input: RecallMemoryInput, requestId?: string): Promise<MemoryRecallResult> {
    const accessToken = await this.accessToken(input, requestId);
    const data = record(await this.request('/v1/recall', {
      method: 'POST',
      requestId,
      accessToken,
      body: {
        tenant_id: input.tenantId,
        subject_id: input.subjectId,
        query: input.query,
        context: input.context,
        limit: input.limit,
        purpose: input.purpose,
      },
    }), 'recall');
    if (!Array.isArray(data.items)) throw new ExternalMemoryHttpError('Invalid recall items.', null, 'INVALID_RESPONSE', null);
    return {
      traceId: text(data.trace_id, 'trace_id'),
      policyId: text(data.policy_id, 'policy_id'),
      policyVersion: integer(data.policy_version, 'policy_version'),
      validAt: text(data.valid_at, 'valid_at'),
      knownAt: text(data.known_at, 'known_at'),
      createdAt: text(data.created_at, 'created_at'),
      items: data.items.map((item) => {
        const mapped = record(item, 'recall item');
        return {
          recordId: text(mapped.record_id, 'record_id'),
          revisionId: text(mapped.revision_id, 'revision_id'),
          key: text(mapped.key, 'key'),
          value: text(mapped.value, 'value'),
          context: context(mapped.context),
          rank: integer(mapped.rank, 'rank'),
          score: numberValue(mapped.score, 'score'),
        };
      }),
    };
  }

  async projectContext(input: ProjectMemoryInput, requestId?: string): Promise<MemoryProjectionResult> {
    const accessToken = await this.accessToken(input, requestId);
    const data = record(await this.request('/v1/recall-contexts', {
      method: 'POST',
      requestId,
      accessToken,
      body: {
        tenant_id: input.tenantId,
        subject_id: input.subjectId,
        trace_id: input.traceId,
        algorithm: input.algorithm,
        max_characters: input.maxCharacters,
        purpose: input.purpose,
      },
    }), 'context projection');
    if (!Array.isArray(data.segments)) throw new ExternalMemoryHttpError('Invalid projection segments.', null, 'INVALID_RESPONSE', null);
    return {
      traceId: text(data.trace_id, 'trace_id'),
      policyId: text(data.policy_id, 'policy_id'),
      policyVersion: integer(data.policy_version, 'policy_version'),
      content: text(data.content, 'content'),
      segments: data.segments.map((segment) => {
        const mapped = record(segment, 'projection segment');
        if (!Array.isArray(mapped.sources)) throw new ExternalMemoryHttpError('Invalid projection sources.', null, 'INVALID_RESPONSE', null);
        return {
          content: text(mapped.content, 'segment content'),
          sources: mapped.sources.map((source) => {
            const mappedSource = record(source, 'projection source');
            return {
              recordId: text(mappedSource.record_id, 'record_id'),
              revisionId: text(mappedSource.revision_id, 'revision_id'),
              rank: integer(mappedSource.rank, 'rank'),
              score: numberValue(mappedSource.score, 'score'),
            };
          }),
        };
      }),
      sourceRevisionIds: stringArray(data.source_revision_ids, 'source_revision_ids'),
      projectionSha256: text(data.projection_sha256, 'projection_sha256'),
    };
  }

  async recordOutcome(input: RecordMemoryOutcomeInput, requestId?: string): Promise<MemoryOutcomeResult> {
    const accessToken = await this.accessToken(input, requestId);
    const data = record(await this.request('/v1/outcomes', {
      method: 'POST',
      requestId,
      accessToken,
      body: {
        tenant_id: input.tenantId,
        subject_id: input.subjectId,
        trace_id: input.traceId,
        revision_id: input.revisionId,
        kind: input.kind,
        idempotency_key: input.idempotencyKey,
        weight: input.weight,
        purpose: input.purpose,
        ...(input.note !== undefined ? { note: input.note } : {}),
        ...(input.occurredAt ? { occurred_at: input.occurredAt } : {}),
      },
    }), 'outcome');
    return {
      outcomeId: text(data.outcome_id, 'outcome_id'),
      idempotentReplay: booleanValue(data.idempotent_replay, 'idempotent_replay'),
    };
  }
}
