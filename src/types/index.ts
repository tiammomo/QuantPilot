export * from './project';
export * from './cli';
export * from './chat';
export * from './realtime';

export interface CLIConfig { enabled?: boolean; model?: string; }
export interface GlobalSettings {
  apiKeys?: { deepseek?: string; github?: string; vercel?: string; supabase?: string };
  preferences?: { theme?: 'light' | 'dark' | 'system'; autoSave?: boolean };
  cli_settings?: { [cliId: string]: CLIConfig };
  default_cli?: string;
}
