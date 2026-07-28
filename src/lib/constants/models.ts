export const DEEPSEEK_MODEL_ID = 'deepseek-v4-flash' as const;
export const DEEPSEEK_OFFICIAL_BASE_URL = 'https://api.deepseek.com' as const;
export const MODELPORT_DEEPSEEK_MODEL_ID = 'deepseek:deepseek-v4-flash' as const;
export const LOCAL_QWEN_MODEL_ID = 'local_qwen:qwen3.5-9b-q5km' as const;
export const LOCAL_OPENAI_BASE_URL = 'http://127.0.0.1:38082/v1' as const;

export type PiAgentModelId =
  | typeof DEEPSEEK_MODEL_ID
  | typeof MODELPORT_DEEPSEEK_MODEL_ID
  | typeof LOCAL_QWEN_MODEL_ID;

export interface PiAgentModelDefinition {
  id: PiAgentModelId;
  name: string;
  description: string;
  supportsImages: boolean;
  provider: 'deepseek' | 'openai';
  runtime: 'deepseek-official' | 'modelport';
  external: false;
  aliases: string[];
}

export const PI_AGENT_MODEL_DEFINITIONS: PiAgentModelDefinition[] = [
  {
    id: LOCAL_QWEN_MODEL_ID,
    name: 'Qwen 3.5 9B (Local Q5_K_M)',
    description: '通过本机 OpenAI-compatible API 接入的默认 Qwen 3.5 9B 量化模型',
    supportsImages: false,
    provider: 'openai',
    runtime: 'modelport',
    external: false,
    aliases: [
      LOCAL_QWEN_MODEL_ID,
      'qwen3.5-9b-q5km',
      'qwen 3.5 9b',
      'local qwen',
    ],
  },
  {
    id: MODELPORT_DEEPSEEK_MODEL_ID,
    name: 'DeepSeek V4 Flash (ModelPort)',
    description: '通过本机 ModelPort 转发到 DeepSeek 官方 Anthropic 协议的日常接入',
    supportsImages: false,
    provider: 'openai',
    runtime: 'modelport',
    external: false,
    aliases: [
      MODELPORT_DEEPSEEK_MODEL_ID,
      'modelport deepseek',
      'deepseek via modelport',
      'deepseek',
    ],
  },
  {
    id: DEEPSEEK_MODEL_ID,
    name: 'DeepSeek V4 Flash (Official Direct)',
    description: '可选的 DeepSeek 官方 API 直连；仅在显式提供官方凭据时启用',
    supportsImages: false,
    provider: 'deepseek',
    runtime: 'deepseek-official',
    external: false,
    aliases: [
      DEEPSEEK_MODEL_ID,
      'deepseek direct',
      'deepseek official',
      'deepseek-official',
    ],
  },
];

export const PI_AGENT_DEFAULT_MODEL: PiAgentModelId = LOCAL_QWEN_MODEL_ID;

export function normalizePiAgentModelId(model?: string | null): PiAgentModelId {
  const normalized = model?.trim().toLowerCase();
  if (!normalized) return PI_AGENT_DEFAULT_MODEL;
  const match = PI_AGENT_MODEL_DEFINITIONS.find((definition) =>
    definition.id.toLowerCase() === normalized ||
    definition.aliases.some((alias) => alias.toLowerCase() === normalized),
  );
  return match?.id ?? PI_AGENT_DEFAULT_MODEL;
}

export function getPiAgentModelDefinition(id?: string | null): PiAgentModelDefinition {
  const normalized = normalizePiAgentModelId(id);
  return PI_AGENT_MODEL_DEFINITIONS.find((definition) => definition.id === normalized) ??
    PI_AGENT_MODEL_DEFINITIONS[0];
}

export function getPiAgentModelDisplayName(id?: string | null): string {
  return getPiAgentModelDefinition(id).name;
}

export function getDefaultModelForCli(_cli?: string | null): PiAgentModelId {
  return PI_AGENT_DEFAULT_MODEL;
}

export function normalizeModelId(_cli?: string | null, model?: string | null): PiAgentModelId {
  return normalizePiAgentModelId(model);
}

export function getModelDisplayName(_cli?: string | null, modelId?: string | null): string {
  return getPiAgentModelDisplayName(modelId);
}

export function getModelDefinitionsForCli(_cli?: string | null): PiAgentModelDefinition[] {
  return PI_AGENT_MODEL_DEFINITIONS;
}
