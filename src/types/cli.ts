import {
  MOAGENT_MODEL_DEFINITIONS,
} from '@/lib/constants/cliModels';

/**
 * Frontend Agent Runtime Type Definitions.
 */

export type CLIType = 'moagent';

export interface CLIModel {
  id: string;
  name: string;
  description?: string;
  supportsImages?: boolean;
  provider?: string;
  runtime?: string;
  external?: boolean;
}

export interface CLIOption {
  id: CLIType;
  name: string;
  description: string;
  icon?: string;
  available: boolean;
  configured: boolean;
  enabled?: boolean;
  models?: CLIModel[];
  color?: string;
  brandColor?: string;
  downloadUrl?: string;
  installCommand?: string;
  features?: string[];
}

export type CLIStatusEntry = {
  installed: boolean;
  checking: boolean;
  version?: string;
  error?: string;
  available?: boolean;
  configured?: boolean;
  models?: string[];
};

export type CLIStatus = Record<string, CLIStatusEntry>;

export interface CLIPreference {
  preferredCli: CLIType;
  fallbackEnabled: boolean;
  selectedModel?: string;
}

export const CLI_OPTIONS: CLIOption[] = [
  {
    id: 'moagent',
    name: 'MoAgent',
    description: 'QuantPilot 自研 Agent 框架，直连 DeepSeek 官方 API',
    icon: '/QuantPilot_Icon.png',
    available: true,
    configured: true,
    enabled: true,
    color: 'from-blue-600 to-indigo-600',
    brandColor: '#2563EB',
    downloadUrl: 'https://api-docs.deepseek.com/guides/coding_agents',
    features: ['MoAgent 自研内核', 'DeepSeek 官方 API', '受控工具执行'],
    models: MOAGENT_MODEL_DEFINITIONS.map(({ id, name, description, supportsImages, provider, runtime, external }) => ({
      id,
      name,
      description,
      supportsImages,
      provider,
      runtime,
      external,
    })),
  },
];
