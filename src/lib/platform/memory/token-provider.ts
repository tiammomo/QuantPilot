import type { MemoryIntegrationConfig } from './config';
import { ExternalMemoryHttpError } from './errors';

type Fetcher = typeof fetch;

export interface MemoryTokenScope {
  tenantId: string;
  subjectId: string;
  purpose: string;
}

export interface MemoryAccessTokenProvider {
  tokenFor(scope: MemoryTokenScope, requestId?: string): Promise<string | null>;
}

export class StaticMemoryAccessTokenProvider implements MemoryAccessTokenProvider {
  constructor(private readonly token: string | null) {}

  async tokenFor(_scope: MemoryTokenScope, _requestId?: string): Promise<string | null> {
    return this.token;
  }
}

interface CachedToken {
  token: string;
  expiresAt: number;
}

function cacheKey(scope: MemoryTokenScope): string {
  return `${scope.tenantId}\u0000${scope.subjectId}\u0000${scope.purpose}`;
}

function correlationId(value: string | undefined): string | null {
  if (!value) return null;
  const normalized = value.replace(/[^A-Za-z0-9._:-]/g, '-').slice(0, 64);
  return normalized || null;
}

export class HttpMemoryAccessTokenBroker implements MemoryAccessTokenProvider {
  private readonly cache = new Map<string, CachedToken>();

  constructor(
    private readonly broker: NonNullable<MemoryIntegrationConfig['tokenBroker']>,
    private readonly timeoutMs: number,
    private readonly fetcher: Fetcher = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  async tokenFor(scope: MemoryTokenScope, requestId?: string): Promise<string> {
    const key = cacheKey(scope);
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt - 30_000 > this.now()) return cached.token;

    const requestCorrelationId = correlationId(requestId);
    let response: Response;
    try {
      response = await this.fetcher(this.broker.url, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          Authorization: `Basic ${Buffer.from(`${this.broker.clientId}:${this.broker.clientSecret}`).toString('base64')}`,
          'Content-Type': 'application/json',
          ...(requestCorrelationId ? { 'X-Request-ID': requestCorrelationId } : {}),
        },
        body: JSON.stringify({
          audience: this.broker.audience,
          tenant_id: scope.tenantId,
          subject_id: scope.subjectId,
          purpose: scope.purpose,
          requested_role: 'subject_self',
        }),
        cache: 'no-store',
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new ExternalMemoryHttpError(
        'Personal memory token broker is unavailable.',
        null,
        error instanceof DOMException && error.name === 'TimeoutError'
          ? 'TOKEN_BROKER_TIMEOUT'
          : 'TOKEN_BROKER_NETWORK_ERROR',
        requestCorrelationId,
      );
    }
    const raw = await response.text();
    if (raw.length > 65_536) {
      throw new ExternalMemoryHttpError(
        'Personal memory token broker response exceeded the client limit.',
        response.status,
        'TOKEN_BROKER_INVALID_RESPONSE',
        response.headers.get('x-request-id') || requestCorrelationId,
      );
    }
    let payload: unknown;
    try {
      payload = JSON.parse(raw) as unknown;
    } catch {
      throw new ExternalMemoryHttpError(
        'Personal memory token broker returned invalid JSON.',
        response.status,
        'TOKEN_BROKER_INVALID_RESPONSE',
        response.headers.get('x-request-id') || requestCorrelationId,
      );
    }
    const body = payload !== null && typeof payload === 'object' && !Array.isArray(payload)
      ? payload as Record<string, unknown>
      : {};
    if (!response.ok) {
      throw new ExternalMemoryHttpError(
        'Personal memory token broker rejected the request.',
        response.status,
        'TOKEN_BROKER_REJECTED',
        response.headers.get('x-request-id') || requestCorrelationId,
      );
    }
    const token = typeof body.access_token === 'string' ? body.access_token.trim() : '';
    const tokenType = typeof body.token_type === 'string' ? body.token_type.toLowerCase() : '';
    const expiresIn = typeof body.expires_in === 'number' ? body.expires_in : 0;
    if (
      !token
      || token.length > 16_384
      || tokenType !== 'bearer'
      || !Number.isFinite(expiresIn)
      || expiresIn < 60
      || expiresIn > 3_600
    ) {
      throw new ExternalMemoryHttpError(
        'Personal memory token broker returned an invalid token.',
        response.status,
        'TOKEN_BROKER_INVALID_RESPONSE',
        response.headers.get('x-request-id') || requestCorrelationId,
      );
    }
    if (this.cache.size >= 1_000) this.cache.delete(this.cache.keys().next().value as string);
    this.cache.set(key, { token, expiresAt: this.now() + (expiresIn * 1_000) });
    return token;
  }
}

export function createMemoryAccessTokenProvider(
  config: MemoryIntegrationConfig,
  fetcher: Fetcher = fetch,
): MemoryAccessTokenProvider {
  return config.tokenBroker
    ? new HttpMemoryAccessTokenBroker(config.tokenBroker, config.timeoutMs, fetcher)
    : new StaticMemoryAccessTokenProvider(config.bearerToken);
}
