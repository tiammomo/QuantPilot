import { MEMORY_HTTP_CONTRACT } from './types';

export interface MemoryIntegrationConfig {
  enabled: boolean;
  required: boolean;
  requireProductionReady: boolean;
  apiUrl: string;
  tenantId: string;
  purpose: 'personalization';
  timeoutMs: number;
  recallLimit: number;
  maxProjectionCharacters: number;
  bearerToken: string | null;
  tokenBroker: {
    url: string;
    clientId: string;
    clientSecret: string;
    audience: string;
  } | null;
  expectedContract: typeof MEMORY_HTTP_CONTRACT;
}

type Environment = Readonly<Record<string, string | undefined>>;

const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on', 'enabled']);
const FALSE_VALUES = new Set(['0', 'false', 'no', 'off', 'disabled']);

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

function httpBaseUrl(value: string): string {
  const parsed = new URL(value);
  if (
    !['http:', 'https:'].includes(parsed.protocol)
    || parsed.username
    || parsed.password
    || parsed.search
    || parsed.hash
  ) {
    throw new Error('QUANTPILOT_MEMORY_API_URL must be an HTTP(S) base URL without credentials.');
  }
  return parsed.toString().replace(/\/$/, '');
}

function scopeId(value: string | undefined, fallback: string): string {
  const normalized = value?.trim() || fallback;
  if (normalized.length > 128) {
    throw new Error('QUANTPILOT_MEMORY_TENANT_ID must be at most 128 characters.');
  }
  return normalized;
}

function tokenBroker(
  environment: Environment,
  enabled: boolean,
): MemoryIntegrationConfig['tokenBroker'] {
  const url = environment.QUANTPILOT_MEMORY_TOKEN_BROKER_URL?.trim();
  const clientId = environment.QUANTPILOT_MEMORY_TOKEN_BROKER_CLIENT_ID?.trim();
  const clientSecret = environment.QUANTPILOT_MEMORY_TOKEN_BROKER_CLIENT_SECRET?.trim();
  const audience = environment.QUANTPILOT_MEMORY_TOKEN_AUDIENCE?.trim()
    || 'evolvable-memory-api';
  const configured = Boolean(url || clientId || clientSecret);
  if (!configured) {
    if (enabled && environment.NODE_ENV === 'production') {
      throw new Error('Production personal memory requires a scoped token broker.');
    }
    return null;
  }
  if (!url || !clientId || !clientSecret) {
    throw new Error('Personal memory token broker URL, client ID and client secret are all required.');
  }
  const normalizedUrl = httpBaseUrl(url);
  if (environment.NODE_ENV === 'production' && !normalizedUrl.startsWith('https://')) {
    throw new Error('Production personal memory token broker must use HTTPS.');
  }
  if (
    clientId.length > 256
    || clientId.includes(':')
    || clientSecret.length < 16
    || clientSecret.length > 4_096
  ) {
    throw new Error('Invalid personal memory token broker credentials.');
  }
  if (!audience || audience.length > 512) {
    throw new Error('Invalid personal memory token audience.');
  }
  return { url: normalizedUrl, clientId, clientSecret, audience };
}

export function getMemoryIntegrationConfig(
  environment: Environment = process.env,
): MemoryIntegrationConfig {
  const offline = environment.QUANTPILOT_DEGRADATION_MODE?.trim().toLowerCase() === 'offline';
  const defaultEnabled = environment.NODE_ENV !== 'test';
  const enabled = !offline && flag(environment.QUANTPILOT_MEMORY_ENABLED, defaultEnabled);
  const required = enabled && flag(environment.QUANTPILOT_MEMORY_REQUIRED, false);
  const requireProductionReady = enabled && flag(
    environment.QUANTPILOT_MEMORY_REQUIRE_PRODUCTION_READY,
    environment.NODE_ENV === 'production',
  );
  const bearerToken = environment.QUANTPILOT_MEMORY_BEARER_TOKEN?.trim() || null;
  if (environment.NODE_ENV === 'production' && bearerToken) {
    throw new Error('Static personal memory bearer tokens are forbidden in production.');
  }

  return {
    enabled,
    required,
    requireProductionReady,
    apiUrl: httpBaseUrl(
      environment.QUANTPILOT_MEMORY_API_URL?.trim() || 'http://127.0.0.1:38089',
    ),
    tenantId: scopeId(environment.QUANTPILOT_MEMORY_TENANT_ID, 'quantpilot-local'),
    purpose: 'personalization',
    timeoutMs: boundedInteger(environment.QUANTPILOT_MEMORY_TIMEOUT_MS, 5_000, 100, 30_000),
    recallLimit: boundedInteger(environment.QUANTPILOT_MEMORY_RECALL_LIMIT, 6, 1, 100),
    maxProjectionCharacters: boundedInteger(
      environment.QUANTPILOT_MEMORY_MAX_CONTEXT_CHARACTERS,
      2_000,
      64,
      100_000,
    ),
    bearerToken,
    tokenBroker: tokenBroker(environment, enabled),
    expectedContract: MEMORY_HTTP_CONTRACT,
  };
}
