export const DEEPSEEK_MODEL_ID = 'deepseek-v4-flash' as const;
export const DEEPSEEK_OFFICIAL_ANTHROPIC_BASE_URL = 'https://api.deepseek.com/anthropic' as const;

export type ClaudeModelId = typeof DEEPSEEK_MODEL_ID;

export interface ClaudeModelDefinition {
  id: ClaudeModelId;
  name: string;
  description: string;
  supportsImages: boolean;
  provider: 'deepseek';
  runtime: 'deepseek-official';
  external: false;
  aliases: string[];
}

export const CLAUDE_MODEL_DEFINITIONS: ClaudeModelDefinition[] = [
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

// Claude Agent SDK remains an internal tool-execution engine. Product-level
// model selection is intentionally locked to the official DeepSeek model.
export const CLAUDE_DEFAULT_MODEL: ClaudeModelId = DEEPSEEK_MODEL_ID;

export function normalizeClaudeModelId(_model?: string | null): ClaudeModelId {
  return DEEPSEEK_MODEL_ID;
}

export function getClaudeModelDefinition(_id?: string | null): ClaudeModelDefinition {
  return CLAUDE_MODEL_DEFINITIONS[0];
}

export function getClaudeModelDisplayName(_id?: string | null): string {
  return CLAUDE_MODEL_DEFINITIONS[0].name;
}

export function getDefaultModelForCli(_cli?: string | null): ClaudeModelId {
  return DEEPSEEK_MODEL_ID;
}

export function normalizeModelId(_cli?: string | null, _model?: string | null): ClaudeModelId {
  return DEEPSEEK_MODEL_ID;
}

export function getModelDisplayName(_cli?: string | null, _modelId?: string | null): string {
  return CLAUDE_MODEL_DEFINITIONS[0].name;
}

export function getModelDefinitionsForCli(_cli?: string | null): ClaudeModelDefinition[] {
  return CLAUDE_MODEL_DEFINITIONS;
}
