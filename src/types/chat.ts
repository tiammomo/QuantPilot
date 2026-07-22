import type { RealtimeMessage } from './realtime';

export type ChatMessage = RealtimeMessage;

export interface UserRequest {
  id: string;
  projectId: string;
  userMessageId: string;
  instruction: string;
  requestType: 'act' | 'chat';
  isCompleted: boolean;
  isSuccessful?: boolean;
  startedAt?: string;
  completedAt?: string;
  cliTypeUsed?: string;
  modelUsed?: string;
  errorMessage?: string;
  resultMetadata?: Record<string, unknown>;
  createdAt: string;
}

export interface WebSocketEventData {
  type: string;
  data: {
    requestId?: string;
    [key: string]: unknown;
  };
  timestamp?: string;
}

export type ChatMode = 'chat' | 'act';
