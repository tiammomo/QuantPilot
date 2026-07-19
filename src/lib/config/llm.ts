import llmConfigFile from '../../../config/llm.json';
import {
  DEEPSEEK_MODEL_ID,
  DEEPSEEK_OFFICIAL_BASE_URL,
  LOCAL_OPENAI_BASE_URL,
  LOCAL_QWEN_MODEL_ID,
  MODELPORT_DEEPSEEK_MODEL_ID,
  MOAGENT_DEFAULT_MODEL,
  normalizeMoAgentModelId,
  type MoAgentModelId,
} from '@/lib/constants/models';

export interface ProjectLlmConfig {
  schemaVersion: 1;
  profileId: string;
  provider: 'deepseek' | 'openai';
  model: MoAgentModelId;
  baseUrl: typeof DEEPSEEK_OFFICIAL_BASE_URL | typeof LOCAL_OPENAI_BASE_URL;
  credentialEnv: 'DEEPSEEK_API_KEY' | 'MODELPORT_API_KEY';
  agent: {
    enabled: boolean;
  };
  queryRewrite: {
    enabled: boolean;
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

const LOCKED_PROFILES = {
  [DEEPSEEK_MODEL_ID]: {
    provider: 'deepseek',
    model: DEEPSEEK_MODEL_ID,
    baseUrl: DEEPSEEK_OFFICIAL_BASE_URL,
    credentialEnv: 'DEEPSEEK_API_KEY',
  },
  [LOCAL_QWEN_MODEL_ID]: {
    provider: 'openai',
    model: LOCAL_QWEN_MODEL_ID,
    baseUrl: LOCAL_OPENAI_BASE_URL,
    credentialEnv: 'MODELPORT_API_KEY',
  },
  [MODELPORT_DEEPSEEK_MODEL_ID]: {
    provider: 'openai',
    model: MODELPORT_DEEPSEEK_MODEL_ID,
    baseUrl: LOCAL_OPENAI_BASE_URL,
    credentialEnv: 'MODELPORT_API_KEY',
  },
} as const;

function configuredProfile(requestedModel?: string | null): JsonRecord {
  const root = asRecord(llmConfigFile);
  const configuredDefault = typeof root?.defaultProfileId === 'string'
    ? root.defaultProfileId
    : MOAGENT_DEFAULT_MODEL;
  const profileId = requestedModel
    ? normalizeMoAgentModelId(requestedModel)
    : normalizeMoAgentModelId(configuredDefault);
  const profiles = asRecord(root?.profiles);
  const profile = asRecord(profiles?.[profileId]);
  if (!profile) throw new Error(`LLM profile is missing: ${profileId}`);
  const locked = LOCKED_PROFILES[profileId];
  if (
    profile.provider !== locked.provider ||
    profile.model !== locked.model ||
    profile.baseUrl !== locked.baseUrl ||
    profile.credentialEnv !== locked.credentialEnv
  ) {
    throw new Error(`LLM profile must use the locked provider boundary: ${profileId}.`);
  }
  return { ...profile, profileId };
}

export function getProjectLlmConfig(requestedModel?: string | null): ProjectLlmConfig {
  const profile = configuredProfile(requestedModel);
  const agent = asRecord(profile.agent);
  const rewrite = asRecord(profile.queryRewrite);
  const defaultTimeoutMs = typeof rewrite?.timeoutMs === 'number'
    ? rewrite.timeoutMs
    : 4_000;
  const defaultMaxRetries = typeof rewrite?.maxRetries === 'number'
    ? rewrite.maxRetries
    : 0;

  return {
    schemaVersion: 1,
    profileId: String(profile.profileId),
    provider: profile.provider as ProjectLlmConfig['provider'],
    model: profile.model as MoAgentModelId,
    baseUrl: profile.baseUrl as ProjectLlmConfig['baseUrl'],
    credentialEnv: profile.credentialEnv as ProjectLlmConfig['credentialEnv'],
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
