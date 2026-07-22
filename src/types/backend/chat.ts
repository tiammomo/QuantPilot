import type { MoAgentTurnMetrics } from '@/lib/chat/turn-metrics';

/**
 * Chat-related types
 */

export interface MessageMetadata {
  toolName?: string;
  summary?: string;
  description?: string;
  filePath?: string;
  turnMetrics?: MoAgentTurnMetrics;
  [key: string]: unknown;
}

export interface Message {
  id: string;
  projectId: string;
  conversationId: string | null;
  role: 'assistant' | 'user' | 'system' | 'tool';
  content: string;
  messageType: 'chat' | 'tool_use' | 'tool_result' | 'error' | 'info' | 'system';
  metadataJson: string | null;
  parentMessageId: string | null;
  cliSource: string | null;
  createdAt: Date;
  updatedAt: Date;
  requestId?: string | null;
}

export interface CreateMessageInput {
  id?: string;
  projectId: string;
  role: 'assistant' | 'user' | 'system' | 'tool';
  messageType: 'chat' | 'tool_use' | 'tool_result' | 'error' | 'info' | 'system';
  content: string;
  metadata?: MessageMetadata | null;
  conversationId?: string | null;
  cliSource?: string | null;
  requestId?: string | null;
}
