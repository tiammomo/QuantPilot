/**
 * AI CLI-related types
 */

export type CLIType = 'moagent';

export type SessionType = 'chat' | 'code_gen' | 'error_fix';

export type SessionStatus = 'active' | 'ended' | 'error';

export interface Session {
  id: string;
  projectId: string;
  sessionType: SessionType;
  cliType: CLIType;
  sessionId: string; // QuantPilot conversation/session record, not a provider session
  modelName?: string;
  contextTokens?: number;
  status: SessionStatus;
  createdAt: Date;
  endedAt?: Date;
}

export interface CLIModel {
  id: string;
  name: string;
  description?: string;
  contextWindow?: number;
  supportsVision?: boolean;
  provider?: string;
  runtime?: string;
  external?: boolean;
}

export interface CLIOption {
  id: CLIType;
  name: string;
  icon?: string;
  description?: string;
  installed?: boolean;
  version?: string;
}

export interface CLIStatus {
  [key: string]: {
    installed: boolean;
    version?: string;
    checking: boolean;
    error?: string;
    available?: boolean;
    configured?: boolean;
    models?: string[];
  };
}

export interface GlobalSettings {
  defaultCli?: CLIType;
  cliSettings?: {
    [key in CLIType]?: {
      model?: string;
      [key: string]: any;
    };
  };
}

export interface MoAgentSession {
  id: string;
  projectPath: string;
  model: string;
  createdAt: Date;
}

export interface MoAgentResponse {
  role: 'assistant';
  content: string;
  thinking?: string;
  toolUses?: ToolUse[];
}

export interface ToolUse {
  id: string;
  name: string;
  input: any;
  output?: string;
  error?: string;
}
