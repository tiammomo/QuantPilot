import type { KnowledgeIntegrationConfig } from './config';
import { ExternalKnowledgeHttpError } from './errors';
import type {
  GovernedKnowledgePort,
  KnowledgeContextInput,
  KnowledgeFeedbackInput,
  KnowledgeUsageInput,
} from './port';
import {
  createKnowledgeAccessTokenProvider,
  type KnowledgeAccessTokenProvider,
} from './token-provider';
import {
  AKEP_CONTEXT_EXTENSION_SUFFIX,
  AKEP_PROTOCOL,
  type KnowledgeCitation,
  type KnowledgeContextPack,
  type KnowledgeFeedbackReceipt,
  type KnowledgePassage,
  type KnowledgeServiceInfo,
  type KnowledgeUsageReceipt,
} from './types';

type Fetcher = typeof fetch;
type JsonRecord = Record<string, unknown>;

const MAX_RESPONSE_CHARACTERS = 1_500_000;
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

function record(value: unknown, label: string): JsonRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ExternalKnowledgeHttpError(`Invalid ${label} response.`, null, 'INVALID_RESPONSE', null);
  }
  return value as JsonRecord;
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new ExternalKnowledgeHttpError(`Invalid ${label} response.`, null, 'INVALID_RESPONSE', null);
  }
  return value;
}

function numberValue(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ExternalKnowledgeHttpError(`Invalid ${label} response.`, null, 'INVALID_RESPONSE', null);
  }
  return value;
}

function booleanValue(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') {
    throw new ExternalKnowledgeHttpError(`Invalid ${label} response.`, null, 'INVALID_RESPONSE', null);
  }
  return value;
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    throw new ExternalKnowledgeHttpError(`Invalid ${label} response.`, null, 'INVALID_RESPONSE', null);
  }
  return [...value];
}

function requestHeader(value: string | undefined): string | null {
  if (!value) return null;
  const normalized = value.replace(/[^A-Za-z0-9._:-]/g, '-').slice(0, 64);
  return normalized || null;
}

function sameAuthority(configured: URL, advertised: URL): boolean {
  if (configured.protocol !== advertised.protocol || configured.port !== advertised.port) return false;
  if (configured.hostname === advertised.hostname) return true;
  return LOOPBACK_HOSTS.has(configured.hostname) && LOOPBACK_HOSTS.has(advertised.hostname);
}

function citation(value: unknown): KnowledgeCitation {
  const data = record(value, 'citation');
  return {
    citationId: text(data.citationId, 'citationId'),
    chunkId: text(data.chunkId, 'chunkId'),
    payloadDigest: text(data.payloadDigest, 'payloadDigest'),
    locator: record(data.locator, 'locator'),
    quote: typeof data.quote === 'string' ? data.quote : '',
    recordId: text(data.recordId, 'recordId'),
    revisionId: text(data.revisionId, 'revisionId'),
    spaceId: text(data.spaceId, 'spaceId'),
  };
}

function passage(value: unknown): KnowledgePassage {
  const data = record(value, 'passage');
  return {
    citationId: text(data.citationId, 'citationId'),
    chunkId: text(data.chunkId, 'chunkId'),
    rank: numberValue(data.rank, 'rank'),
    recordId: text(data.recordId, 'recordId'),
    revisionId: text(data.revisionId, 'revisionId'),
    score: numberValue(data.score, 'score'),
    spaceId: text(data.spaceId, 'spaceId'),
    text: typeof data.text === 'string' ? data.text : '',
    title: text(data.title, 'title'),
  };
}

function contextPack(value: unknown): KnowledgeContextPack {
  const data = record(value, 'context pack');
  const quality = record(data.quality, 'context quality');
  const decision = text(quality.decision, 'quality decision');
  if (!['suitable', 'suitable_with_warning', 'insufficient'].includes(decision)) {
    throw new ExternalKnowledgeHttpError('Invalid context quality decision.', null, 'INVALID_RESPONSE', null);
  }
  const citations = Array.isArray(data.citations) ? data.citations.map(citation) : [];
  const passages = Array.isArray(data.passages) ? data.passages.map(passage) : [];
  const citationIds = new Set(citations.map((item) => item.citationId));
  if (!passages.every((item) => citationIds.has(item.citationId))) {
    throw new ExternalKnowledgeHttpError(
      'Context passages are not covered by citations.',
      null,
      'INVALID_RESPONSE',
      null,
    );
  }
  return {
    contextPackId: text(data.contextPackId, 'contextPackId'),
    contextDigest: text(data.contextDigest, 'contextDigest'),
    createdAt: text(data.createdAt, 'createdAt'),
    exposureReceiptId: text(data.exposureReceiptId, 'exposureReceiptId'),
    policyEpoch: text(data.policyEpoch, 'policyEpoch'),
    purpose: text(data.purpose, 'purpose'),
    passages,
    citations,
    obligations: Array.isArray(data.obligations) ? [...data.obligations] : [],
    quality: {
      decision: decision as KnowledgeContextPack['quality']['decision'],
      reasons: stringArray(quality.reasons, 'quality reasons'),
      citationCoverage: numberValue(quality.citationCoverage, 'citation coverage'),
      lexicalCoverage: numberValue(quality.lexicalCoverage, 'lexical coverage'),
    },
    warnings: Array.isArray(data.warnings)
      ? data.warnings.map((value) => {
          const warning = record(value, 'warning');
          return {
            code: text(warning.code, 'warning code'),
            message: text(warning.message, 'warning message'),
            revisionIds: warning.revisionIds === undefined
              ? []
              : stringArray(warning.revisionIds, 'warning revisionIds'),
          };
        })
      : [],
  };
}

export class AkepHttpAdapter implements GovernedKnowledgePort {
  private protocolBaseUrl: string | null = null;

  constructor(
    private readonly config: KnowledgeIntegrationConfig,
    private readonly fetcher: Fetcher = fetch,
    private readonly tokens: KnowledgeAccessTokenProvider = createKnowledgeAccessTokenProvider(config, fetcher),
  ) {}

  private async request(
    url: URL,
    options: {
      method?: 'GET' | 'POST';
      body?: unknown;
      requestId?: string;
      authenticated?: boolean;
      idempotencyKey?: string;
    } = {},
  ): Promise<unknown> {
    const headers = new Headers({ Accept: 'application/json' });
    const correlationId = requestHeader(options.requestId);
    if (correlationId) headers.set('X-Request-ID', correlationId);
    if (options.authenticated !== false) {
      const token = await this.tokens.tokenFor(options.requestId);
      if (token) headers.set('Authorization', `Bearer ${token}`);
    }
    if (url.pathname.includes('/akep/')) headers.set('AKEP-Version', this.config.expectedVersion);
    if (options.idempotencyKey) headers.set('Idempotency-Key', options.idempotencyKey);
    if (options.body !== undefined) headers.set('Content-Type', 'application/json');

    let response: Response;
    try {
      response = await this.fetcher(url, {
        method: options.method ?? 'GET',
        headers,
        cache: 'no-store',
        signal: AbortSignal.timeout(this.config.timeoutMs),
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      });
    } catch (error) {
      throw new ExternalKnowledgeHttpError(
        'Governed knowledge service is unavailable.',
        null,
        error instanceof DOMException && error.name === 'TimeoutError' ? 'TIMEOUT' : 'NETWORK_ERROR',
        correlationId,
      );
    }
    const responseRequestId = response.headers.get('x-request-id') || correlationId;
    const raw = await response.text();
    if (raw.length > MAX_RESPONSE_CHARACTERS) {
      throw new ExternalKnowledgeHttpError(
        'Governed knowledge response exceeded the client limit.',
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
        throw new ExternalKnowledgeHttpError(
          'Governed knowledge service returned invalid JSON.',
          response.status,
          'INVALID_JSON',
          responseRequestId,
        );
      }
    }
    if (!response.ok) {
      const problem = payload && typeof payload === 'object' && !Array.isArray(payload)
        ? payload as JsonRecord
        : {};
      throw new ExternalKnowledgeHttpError(
        'Governed knowledge request was rejected.',
        response.status,
        typeof problem.code === 'string' ? problem.code : 'HTTP_ERROR',
        responseRequestId,
        typeof problem.traceId === 'string' ? problem.traceId : null,
      );
    }
    return payload;
  }

  async discover(requestId?: string): Promise<KnowledgeServiceInfo> {
    const configured = new URL(this.config.apiUrl);
    const url = new URL('/.well-known/akep', `${this.config.apiUrl}/`);
    const data = record(await this.request(url, { requestId, authenticated: false }), 'AKEP discovery');
    const protocol = text(data.protocol, 'protocol');
    if (protocol !== AKEP_PROTOCOL) {
      throw new ExternalKnowledgeHttpError('AKEP protocol is incompatible.', 200, 'INCOMPATIBLE_PROTOCOL', requestHeader(requestId));
    }
    const advertised = new URL(text(data.baseUrl, 'baseUrl'));
    if (!sameAuthority(configured, advertised) || !advertised.pathname.endsWith(`/akep/${this.config.expectedVersion}`)) {
      throw new ExternalKnowledgeHttpError(
        'AKEP discovery advertised an unexpected protocol endpoint.',
        200,
        'UNTRUSTED_DISCOVERY_ENDPOINT',
        requestHeader(requestId),
      );
    }
    const extensions = Array.isArray(data.supportedExtensions)
      ? data.supportedExtensions.map((value) => text(record(value, 'extension').uri, 'extension uri'))
      : [];
    this.protocolBaseUrl = advertised.toString().replace(/\/$/, '');
    return {
      protocol: AKEP_PROTOCOL,
      versions: stringArray(data.versions, 'versions'),
      operations: stringArray(data.operations, 'operations'),
      profiles: stringArray(data.profiles, 'profiles'),
      supportedExtensions: extensions,
      baseUrl: this.protocolBaseUrl,
      expiresAt: text(data.expiresAt, 'expiresAt'),
    };
  }

  async checkReady(requestId?: string): Promise<void> {
    const data = record(
      await this.request(new URL('/health/ready', `${this.config.apiUrl}/`), {
        requestId,
        authenticated: false,
      }),
      'AKEP readiness',
    );
    if (data.status !== 'ready') {
      throw new ExternalKnowledgeHttpError('Governed knowledge service is not ready.', 503, 'NOT_READY', requestHeader(requestId));
    }
  }

  async createContextPack(input: KnowledgeContextInput, requestId?: string): Promise<KnowledgeContextPack> {
    if (!this.protocolBaseUrl) await this.discover(requestId);
    const payload = await this.request(new URL(`${this.protocolBaseUrl}/context-packs`), {
      method: 'POST',
      requestId,
      body: {
        akepVersion: this.config.expectedVersion,
        budget: { maxCharacters: input.maxCharacters },
        critical: [],
        extensions: {},
        mode: 'lexical',
        purpose: input.purpose,
        spaces: input.spaces,
        supportedObligations: input.supportedObligations,
        task: input.task,
      },
    });
    return contextPack(payload);
  }

  async recordUsage(
    input: KnowledgeUsageInput,
    idempotencyKey: string,
    requestId?: string,
  ): Promise<KnowledgeUsageReceipt> {
    if (!this.protocolBaseUrl) await this.discover(requestId);
    const data = record(await this.request(new URL(`${this.protocolBaseUrl}/usages`), {
      method: 'POST',
      requestId,
      idempotencyKey,
      body: {
        akepVersion: this.config.expectedVersion,
        ...input,
        critical: [],
        extensions: {},
      },
    }), 'usage receipt');
    return {
      usageId: text(data.usageId, 'usageId'),
      exposureReceiptId: text(data.exposureReceiptId, 'exposureReceiptId'),
      spaceId: text(data.spaceId, 'spaceId'),
      policyEpoch: text(data.policyEpoch, 'policyEpoch'),
      createdAt: text(data.createdAt, 'createdAt'),
      feedbackUntil: text(data.feedbackUntil, 'feedbackUntil'),
    };
  }

  async recordFeedback(
    input: KnowledgeFeedbackInput,
    idempotencyKey: string,
    requestId?: string,
  ): Promise<KnowledgeFeedbackReceipt> {
    if (!this.protocolBaseUrl) await this.discover(requestId);
    const data = record(await this.request(new URL(`${this.protocolBaseUrl}/feedback`), {
      method: 'POST',
      requestId,
      idempotencyKey,
      body: {
        akepVersion: this.config.expectedVersion,
        ...input,
        critical: [],
        extensions: {},
      },
    }), 'feedback receipt');
    const evaluatorVersion = record(data.evaluatorVersion, 'evaluatorVersion');
    const status = text(data.status, 'status');
    if (status !== 'recorded') {
      throw new ExternalKnowledgeHttpError(
        'Invalid feedback status response.',
        null,
        'INVALID_RESPONSE',
        null,
      );
    }
    return {
      feedbackId: text(data.feedbackId, 'feedbackId'),
      usageId: text(data.usageId, 'usageId'),
      evidenceId: text(data.evidenceId, 'evidenceId'),
      policyEpoch: text(data.policyEpoch, 'policyEpoch'),
      receivedAt: text(data.receivedAt, 'receivedAt'),
      status,
      correlationClass: text(data.correlationClass, 'correlationClass'),
      eligibleForAggregation: booleanValue(data.eligibleForAggregation, 'eligibleForAggregation'),
      evaluatorVersion: {
        uri: text(evaluatorVersion.uri, 'evaluatorVersion.uri'),
        digest: text(evaluatorVersion.digest, 'evaluatorVersion.digest'),
      },
    };
  }
}

export function knowledgeCompatibilityIssues(
  info: KnowledgeServiceInfo,
  config: KnowledgeIntegrationConfig,
): string[] {
  const issues: string[] = [];
  if (!info.versions.includes(config.expectedVersion)) issues.push(`version:${config.expectedVersion}`);
  for (const operation of ['query', 'receipt', 'usage']) {
    if (!info.operations.includes(operation)) issues.push(`operation:${operation}`);
  }
  if (!info.supportedExtensions.some((uri) => uri.endsWith(AKEP_CONTEXT_EXTENSION_SUFFIX))) {
    issues.push('extension:context-pack');
  }
  if (Date.parse(info.expiresAt) <= Date.now()) issues.push('capability:expired');
  return issues;
}
