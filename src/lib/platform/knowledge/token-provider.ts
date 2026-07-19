import type { KnowledgeIntegrationConfig } from './config';
import { ExternalKnowledgeHttpError } from './errors';

type Fetcher = typeof fetch;

export interface KnowledgeAccessTokenProvider {
  tokenFor(requestId?: string): Promise<string | null>;
}

export class StaticKnowledgeAccessTokenProvider implements KnowledgeAccessTokenProvider {
  constructor(private readonly token: string | null) {}

  async tokenFor(): Promise<string | null> {
    return this.token;
  }
}

function correlationId(value: string | undefined): string | null {
  if (!value) return null;
  const normalized = value.replace(/[^A-Za-z0-9._:-]/g, '-').slice(0, 64);
  return normalized || null;
}

export class OAuthClientCredentialsTokenProvider implements KnowledgeAccessTokenProvider {
  private cached: { token: string; expiresAt: number } | null = null;

  constructor(
    private readonly oauth: NonNullable<KnowledgeIntegrationConfig['oauth']>,
    private readonly timeoutMs: number,
    private readonly fetcher: Fetcher = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  async tokenFor(requestId?: string): Promise<string> {
    if (this.cached && this.cached.expiresAt - 30_000 > this.now()) return this.cached.token;
    const id = correlationId(requestId);
    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      resource: this.oauth.resource,
      scope: this.oauth.scope,
    });
    let response: Response;
    try {
      response = await this.fetcher(this.oauth.tokenUrl, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          Authorization: `Basic ${Buffer.from(`${this.oauth.clientId}:${this.oauth.clientSecret}`).toString('base64')}`,
          'Content-Type': 'application/x-www-form-urlencoded',
          ...(id ? { 'X-Request-ID': id } : {}),
        },
        body,
        cache: 'no-store',
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new ExternalKnowledgeHttpError(
        'Knowledge OAuth token endpoint is unavailable.',
        null,
        error instanceof DOMException && error.name === 'TimeoutError'
          ? 'TOKEN_TIMEOUT'
          : 'TOKEN_NETWORK_ERROR',
        id,
      );
    }
    const raw = await response.text();
    if (raw.length > 65_536) {
      throw new ExternalKnowledgeHttpError(
        'Knowledge OAuth token response exceeded the client limit.',
        response.status,
        'TOKEN_INVALID_RESPONSE',
        response.headers.get('x-request-id') || id,
      );
    }
    let payload: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        payload = parsed as Record<string, unknown>;
      }
    } catch {
      throw new ExternalKnowledgeHttpError(
        'Knowledge OAuth token endpoint returned invalid JSON.',
        response.status,
        'TOKEN_INVALID_RESPONSE',
        response.headers.get('x-request-id') || id,
      );
    }
    if (!response.ok) {
      throw new ExternalKnowledgeHttpError(
        'Knowledge OAuth token request was rejected.',
        response.status,
        'TOKEN_REJECTED',
        response.headers.get('x-request-id') || id,
      );
    }
    const token = typeof payload.access_token === 'string' ? payload.access_token.trim() : '';
    const tokenType = typeof payload.token_type === 'string' ? payload.token_type.toLowerCase() : '';
    const expiresIn = typeof payload.expires_in === 'number' ? payload.expires_in : 0;
    if (!token || token.length > 16_384 || tokenType !== 'bearer' || expiresIn < 60 || expiresIn > 3_600) {
      throw new ExternalKnowledgeHttpError(
        'Knowledge OAuth token endpoint returned an invalid token.',
        response.status,
        'TOKEN_INVALID_RESPONSE',
        response.headers.get('x-request-id') || id,
      );
    }
    this.cached = { token, expiresAt: this.now() + expiresIn * 1_000 };
    return token;
  }
}

export function createKnowledgeAccessTokenProvider(
  config: KnowledgeIntegrationConfig,
  fetcher: Fetcher = fetch,
): KnowledgeAccessTokenProvider {
  return config.oauth
    ? new OAuthClientCredentialsTokenProvider(config.oauth, config.timeoutMs, fetcher)
    : new StaticKnowledgeAccessTokenProvider(config.bearerToken);
}
