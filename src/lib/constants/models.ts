export const DEEPSEEK_MODEL_ID = 'deepseek-v4-flash' as const;
export const DEEPSEEK_OFFICIAL_BASE_URL = 'https://api.deepseek.com' as const;

export type MoAgentModelId = typeof DEEPSEEK_MODEL_ID;

export interface MoAgentModelDefinition {
  id: MoAgentModelId;
  name: string;
  description: string;
  supportsImages: boolean;
  provider: 'deepseek';
  runtime: 'deepseek-official';
  external: false;
  aliases: string[];
}

export const MOAGENT_MODEL_DEFINITIONS: MoAgentModelDefinition[] = [
  {
    id: DEEPSEEK_MODEL_ID,
    name: 'DeepSeek V4 Flash',
    description: '通过 DeepSeek 官方 API 直连的唯一模型',
    supportsImages: false,
    provider: 'deepseek',
    runtime: 'deepseek-official',
    external: false,
    aliases: [DEEPSEEK_MODEL_ID, 'deepseek v4 flash', 'deepseek-v4', 'deepseek'],
  },
];

export const MOAGENT_DEFAULT_MODEL: MoAgentModelId = DEEPSEEK_MODEL_ID;

export function normalizeMoAgentModelId(_model?: string | null): MoAgentModelId {
  return DEEPSEEK_MODEL_ID;
}

export function getMoAgentModelDefinition(_id?: string | null): MoAgentModelDefinition {
  return MOAGENT_MODEL_DEFINITIONS[0];
}

export function getMoAgentModelDisplayName(_id?: string | null): string {
  return MOAGENT_MODEL_DEFINITIONS[0].name;
}

export function getDefaultModelForCli(_cli?: string | null): MoAgentModelId {
  return DEEPSEEK_MODEL_ID;
}

export function normalizeModelId(_cli?: string | null, _model?: string | null): MoAgentModelId {
  return DEEPSEEK_MODEL_ID;
}

export function getModelDisplayName(_cli?: string | null, _modelId?: string | null): string {
  return MOAGENT_MODEL_DEFINITIONS[0].name;
}

export function getModelDefinitionsForCli(_cli?: string | null): MoAgentModelDefinition[] {
  return MOAGENT_MODEL_DEFINITIONS;
}
