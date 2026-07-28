import {
  PI_AGENT_MODEL_DEFINITIONS,
} from '@/lib/constants/models';

/**
 * Frontend Agent Runtime Type Definitions.
 */

export type CLIType = 'pi';

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
  selectedModel?: string;
}

export const CLI_OPTIONS: CLIOption[] = [
  {
    id: 'pi',
    name: 'PI Agent',
    description: '基于开源 PI Agent 框架，支持 DeepSeek 与本地 OpenAI-compatible 模型',
    icon: '/QuantPilot_Icon.png',
    available: true,
    configured: true,
    enabled: true,
    color: 'from-blue-600 to-indigo-600',
    brandColor: '#2563EB',
    downloadUrl: 'https://github.com/earendil-works/pi',
    features: ['PI 开源 Agent 内核', '多 Provider 模型选择', '受控工具执行'],
    models: PI_AGENT_MODEL_DEFINITIONS.map(({ id, name, description, supportsImages, provider, runtime, external }) => ({
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
