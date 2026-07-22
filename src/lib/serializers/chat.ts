import { randomUUID } from 'crypto';
import type { Message, MessageMetadata } from '@/types/backend';
import type { RealtimeMessage } from '@/types';
import {
  compactToolOutputPreview,
  TOOL_OUTPUT_PREVIEW_LIMIT,
} from '@/lib/utils/tool-output';

function parseMetadata(metadataJson?: string | null): MessageMetadata | null {
  if (!metadataJson) {
    return null;
  }

  try {
    const parsed = JSON.parse(metadataJson) as MessageMetadata;
    return parsed;
  } catch (error) {
    console.warn('[chat-serializer] Failed to parse metadata JSON:', error);
    return null;
  }
}

function compactMetadataForClient(metadata: MessageMetadata | null): MessageMetadata | null {
  if (!metadata) {
    return null;
  }

  const compacted: MessageMetadata = { ...metadata };
  const keys = ['toolOutput', 'tool_output', 'output', 'result', 'content', 'diff', 'diffInfo', 'diff_info'];
  let truncatedOriginalChars =
    typeof compacted.toolOutputOriginalChars === 'number'
      ? compacted.toolOutputOriginalChars
      : 0;

  keys.forEach((key) => {
    const value = compacted[key];
    if (typeof value === 'string') {
      compacted[key] = compactToolOutputPreview(value);
      if ((compacted[key] as string).length !== value.length) {
        truncatedOriginalChars = Math.max(truncatedOriginalChars, value.length);
      }
    }
  });
  if (truncatedOriginalChars > 0) {
    compacted.toolOutputTruncated = true;
    compacted.toolOutputOriginalChars = truncatedOriginalChars;
  }

  return compacted;
}

export function serializeMessage(
  message: Message,
  overrides: Partial<RealtimeMessage> = {}
): RealtimeMessage {
  let metadata = compactMetadataForClient(parseMetadata(message.metadataJson));
  const content =
    message.messageType === 'tool_result'
      ? compactToolOutputPreview(message.content, TOOL_OUTPUT_PREVIEW_LIMIT)
      : message.content;
  if (message.messageType === 'tool_result' && content.length !== message.content.length) {
    metadata = {
      ...(metadata ?? {}),
      toolOutputTruncated: true,
      toolOutputOriginalChars: Math.max(
        message.content.length,
        typeof metadata?.toolOutputOriginalChars === 'number' ? metadata.toolOutputOriginalChars : 0,
      ),
    };
  }

  return {
    id: message.id,
    projectId: message.projectId,
    role: message.role,
    messageType: message.messageType,
    content,
    metadata,
    parentMessageId: message.parentMessageId ?? null,
    conversationId: message.conversationId ?? null,
    cliSource: message.cliSource ?? null,
    requestId: message.requestId ?? undefined,
    createdAt: message.createdAt.toISOString(),
    updatedAt: message.updatedAt.toISOString(),
    ...overrides,
  };
}

export function serializeMessages(messages: Message[]): RealtimeMessage[] {
  return messages.map((message) => serializeMessage(message));
}

export function createRealtimeMessage(
  payload: Partial<RealtimeMessage> & Pick<RealtimeMessage, 'projectId' | 'role' | 'messageType' | 'content'>
): RealtimeMessage {
  const createdAt = payload.createdAt ?? new Date().toISOString();
  const updatedAt =
    payload.updatedAt ??
    createdAt;

  return {
    id: payload.id ?? randomUUID(),
    projectId: payload.projectId,
    role: payload.role,
    messageType: payload.messageType,
    content: payload.content,
    metadata: payload.metadata ?? null,
    parentMessageId: payload.parentMessageId ?? null,
    conversationId: payload.conversationId ?? null,
    cliSource: payload.cliSource ?? null,
    requestId: payload.requestId ?? undefined,
    createdAt,
    updatedAt,
    isStreaming: payload.isStreaming,
    isFinal: payload.isFinal,
    isOptimistic: payload.isOptimistic,
  };
}
