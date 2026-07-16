import llmConfigFile from '../../../config/llm.json';
import {
  DEEPSEEK_MODEL_ID,
  DEEPSEEK_OFFICIAL_BASE_URL,
} from '@/lib/constants/models';

export type QueryRewriteLlmMode = 'off' | 'auto' | 'always';

export interface ProjectLlmConfig {
  schemaVersion: 1;
  profileId: string;
  provider: 'deepseek';
  model: typeof DEEPSEEK_MODEL_ID;
  baseUrl: typeof DEEPSEEK_OFFICIAL_BASE_URL;
  credentialEnv: 'DEEPSEEK_API_KEY';
  agent: {
    enabled: boolean;
  };
  queryRewrite: {
    enabled: boolean;
    mode: QueryRewriteLlmMode;
    timeoutMs: number;
    maxRetries: number;
  };
}

type JsonRecord = Record<string, unknown>;

const FALSE_VALUES = new Set(['0', 'false', 'no', 'off', 'disabled']);
const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on', 'enabled']);

function asRecord(value: unknown): JsonRecord | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

function envFlag(name: string, fallback: boolean): boolean {
  const value = process.env[name]?.trim().toLowerCase();
  if (!value) return fallback;
  if (FALSE_VALUES.has(value)) return false;
  if (TRUE_VALUES.has(value)) return true;
  return fallback;
}

function boundedInteger(
  value: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (!value?.trim()) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed >= min && parsed <= max
    ? parsed
    : fallback;
}

function queryRewriteMode(value: string | undefined, fallback: QueryRewriteLlmMode): QueryRewriteLlmMode {
  const normalized = value?.trim().toLowerCase();
  return normalized === 'off' || normalized === 'always' || normalized === 'auto'
    ? normalized
    : fallback;
}

function configuredProfile(): JsonRecord {
  const root = asRecord(llmConfigFile);
  const profileId = typeof root?.defaultProfileId === 'string'
    ? root.defaultProfileId
    : DEEPSEEK_MODEL_ID;
  const profiles = asRecord(root?.profiles);
  const profile = asRecord(profiles?.[profileId]);
  if (!profile) throw new Error(`LLM profile is missing: ${profileId}`);
  if (
    profileId !== DEEPSEEK_MODEL_ID ||
    profile.provider !== 'deepseek' ||
    profile.model !== DEEPSEEK_MODEL_ID ||
    profile.baseUrl !== DEEPSEEK_OFFICIAL_BASE_URL ||
    profile.credentialEnv !== 'DEEPSEEK_API_KEY'
  ) {
    throw new Error('LLM profile must use the locked DeepSeek official provider boundary.');
  }
  return { ...profile, profileId };
}

export function getProjectLlmConfig(): ProjectLlmConfig {
  const profile = configuredProfile();
  const agent = asRecord(profile.agent);
  const rewrite = asRecord(profile.queryRewrite);
  const defaultRewriteMode = queryRewriteMode(
    typeof rewrite?.mode === 'string' ? rewrite.mode : undefined,
    'auto',
  );
  const defaultTimeoutMs = typeof rewrite?.timeoutMs === 'number'
    ? rewrite.timeoutMs
    : 4_000;
  const defaultMaxRetries = typeof rewrite?.maxRetries === 'number'
    ? rewrite.maxRetries
    : 0;

  return {
    schemaVersion: 1,
    profileId: String(profile.profileId),
    provider: 'deepseek',
    model: DEEPSEEK_MODEL_ID,
    baseUrl: DEEPSEEK_OFFICIAL_BASE_URL,
    credentialEnv: 'DEEPSEEK_API_KEY',
    agent: {
      enabled: envFlag(
        'QUANTPILOT_LLM_AGENT_ENABLED',
        typeof agent?.enabled === 'boolean' ? agent.enabled : true,
      ),
    },
    queryRewrite: {
      enabled: envFlag(
        'QUANTPILOT_LLM_QUERY_REWRITE_ENABLED',
        typeof rewrite?.enabled === 'boolean' ? rewrite.enabled : true,
      ),
      mode: queryRewriteMode(
        process.env.QUANTPILOT_QUERY_REWRITE_LLM_MODE,
        defaultRewriteMode,
      ),
      timeoutMs: boundedInteger(
        process.env.QUANTPILOT_QUERY_REWRITE_LLM_TIMEOUT_MS,
        defaultTimeoutMs,
        500,
        15_000,
      ),
      maxRetries: boundedInteger(
        process.env.QUANTPILOT_QUERY_REWRITE_LLM_MAX_RETRIES,
        defaultMaxRetries,
        0,
        1,
      ),
    },
  };
}
