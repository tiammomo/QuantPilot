import { AKEP_VERSION } from './types';

export interface KnowledgeIntegrationConfig {
  enabled: boolean;
  required: boolean;
  apiUrl: string;
  purpose: string;
  spaces: string[];
  timeoutMs: number;
  maxContextCharacters: number;
  supportedObligations: readonly ['cite', 'no-train'];
  bearerToken: string | null;
  oauth: {
    tokenUrl: string;
    clientId: string;
    clientSecret: string;
    resource: string;
    scope: string;
  } | null;
  expectedVersion: typeof AKEP_VERSION;
}

type Environment = Readonly<Record<string, string | undefined>>;

const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on', 'enabled']);
const FALSE_VALUES = new Set(['0', 'false', 'no', 'off', 'disabled']);
const PURPOSE_PATTERN = /^[a-z][a-z0-9._:-]{0,127}$/;

function flag(value: string | undefined, fallback: boolean): boolean {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return fallback;
  if (TRUE_VALUES.has(normalized)) return true;
  if (FALSE_VALUES.has(normalized)) return false;
  return fallback;
}

function boundedInteger(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum
    ? parsed
    : fallback;
}

function httpBaseUrl(value: string, label: string): string {
  const parsed = new URL(value);
  if (
    !['http:', 'https:'].includes(parsed.protocol)
    || parsed.username
    || parsed.password
    || parsed.search
    || parsed.hash
  ) {
    throw new Error(`${label} must be an HTTP(S) URL without credentials, query, or fragment.`);
  }
  return parsed.toString().replace(/\/$/, '');
}

function purpose(value: string | undefined): string {
  const normalized = value?.trim() || 'quant-research';
  if (!PURPOSE_PATTERN.test(normalized)) {
    throw new Error('QUANTPILOT_KNOWLEDGE_PURPOSE is invalid.');
  }
  return normalized;
}

function spaces(value: string | undefined): string[] {
  const items = (value?.trim() || 'https://knowledge.local/spaces/default')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  if (items.length === 0 || items.length > 50) {
    throw new Error('QUANTPILOT_KNOWLEDGE_SPACES must contain between 1 and 50 URI values.');
  }
  for (const item of items) {
    const parsed = new URL(item);
    if (!parsed.protocol || parsed.username || parsed.password) {
      throw new Error('QUANTPILOT_KNOWLEDGE_SPACES contains an invalid URI.');
    }
  }
  return [...new Set(items)];
}

function oauthConfig(
  environment: Environment,
  enabled: boolean,
  apiUrl: string,
): KnowledgeIntegrationConfig['oauth'] {
  const tokenUrl = environment.QUANTPILOT_KNOWLEDGE_OAUTH_TOKEN_URL?.trim();
  const clientId = environment.QUANTPILOT_KNOWLEDGE_OAUTH_CLIENT_ID?.trim();
  const clientSecret = environment.QUANTPILOT_KNOWLEDGE_OAUTH_CLIENT_SECRET?.trim();
  const configured = Boolean(tokenUrl || clientId || clientSecret);
  if (!configured) {
    if (enabled && environment.NODE_ENV === 'production') {
      throw new Error('Production governed knowledge requires OAuth client credentials.');
    }
    return null;
  }
  if (!tokenUrl || !clientId || !clientSecret) {
    throw new Error('Knowledge OAuth token URL, client ID, and client secret are all required.');
  }
  const normalizedTokenUrl = httpBaseUrl(tokenUrl, 'QUANTPILOT_KNOWLEDGE_OAUTH_TOKEN_URL');
  if (environment.NODE_ENV === 'production' && !normalizedTokenUrl.startsWith('https://')) {
    throw new Error('Production knowledge OAuth token endpoint must use HTTPS.');
  }
  if (clientId.length > 256 || clientId.includes(':') || clientSecret.length < 16 || clientSecret.length > 4_096) {
    throw new Error('Invalid knowledge OAuth client credentials.');
  }
  const resource = environment.QUANTPILOT_KNOWLEDGE_OAUTH_RESOURCE?.trim()
    || new URL('/akep/0.1', `${apiUrl}/`).toString();
  const scope = environment.QUANTPILOT_KNOWLEDGE_OAUTH_SCOPE?.trim()
    || 'akep:query akep:read akep:feedback';
  if (resource.length > 2_048 || scope.length > 2_048) {
    throw new Error('Knowledge OAuth resource or scope is too long.');
  }
  return {
    tokenUrl: normalizedTokenUrl,
    clientId,
    clientSecret,
    resource,
    scope,
  };
}

export function getKnowledgeIntegrationConfig(
  environment: Environment = process.env,
): KnowledgeIntegrationConfig {
  const offline = environment.QUANTPILOT_DEGRADATION_MODE?.trim().toLowerCase() === 'offline';
  const enabled = !offline && flag(
    environment.QUANTPILOT_KNOWLEDGE_ENABLED,
    environment.NODE_ENV !== 'test',
  );
  const required = enabled && flag(environment.QUANTPILOT_KNOWLEDGE_REQUIRED, false);
  const apiUrl = httpBaseUrl(
    environment.QUANTPILOT_KNOWLEDGE_API_URL?.trim() || 'http://localhost:8080',
    'QUANTPILOT_KNOWLEDGE_API_URL',
  );
  if (environment.NODE_ENV === 'production' && !apiUrl.startsWith('https://')) {
    throw new Error('Production governed knowledge endpoint must use HTTPS.');
  }
  const bearerToken = environment.QUANTPILOT_KNOWLEDGE_BEARER_TOKEN?.trim() || null;
  if (environment.NODE_ENV === 'production' && bearerToken) {
    throw new Error('Static governed knowledge bearer tokens are forbidden in production.');
  }

  return {
    enabled,
    required,
    apiUrl,
    purpose: purpose(environment.QUANTPILOT_KNOWLEDGE_PURPOSE),
    spaces: spaces(environment.QUANTPILOT_KNOWLEDGE_SPACES),
    timeoutMs: boundedInteger(environment.QUANTPILOT_KNOWLEDGE_TIMEOUT_MS, 2_000, 100, 30_000),
    maxContextCharacters: boundedInteger(
      environment.QUANTPILOT_KNOWLEDGE_MAX_CONTEXT_CHARACTERS,
      8_000,
      256,
      100_000,
    ),
    supportedObligations: ['cite', 'no-train'],
    bearerToken,
    oauth: oauthConfig(environment, enabled, apiUrl),
    expectedVersion: AKEP_VERSION,
  };
}
