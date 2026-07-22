import type { ChatMessage } from '@/types/chat';
import type { MessageMetadata } from '@/types/backend';

const pickFirstString = (value: unknown): string | undefined => {
  if (typeof value === 'string' && value.trim().length > 0) {
    return value.trim();
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return undefined;
};

const stableHash = (input: string): string => {
  let hash = 0;
  for (let i = 0; i < input.length; i += 1) {
    hash = (hash * 31 + input.charCodeAt(i)) | 0;
  }
  return (hash >>> 0).toString(16);
};

const sanitizeChatContent = (content: string): string =>
  content
    .replace(/^\s*\/?<\/?tool_call>\s*$/gim, '')
    .replace(/\/?<\/?tool_call>/gi, '')
    .trim();

const deriveMessageId = (raw: any): string => {
  const explicitIdCandidates = [
    raw?.id,
    raw?.messageId,
    raw?.uuid,
    raw?.messageUuid,
  ];

  for (const candidate of explicitIdCandidates) {
    const value = pickFirstString(candidate);
    if (value) {
      return value;
    }
  }

  const project = pickFirstString(raw?.projectId) ?? '';
  const role = pickFirstString(raw?.role) ?? 'assistant';
  const type = pickFirstString(raw?.messageType) ?? 'chat';
  const created =
    pickFirstString(raw?.createdAt) ??
    pickFirstString(raw?.timestamp) ??
    '';

  let content = '';
  if (typeof raw?.content === 'string') {
    content = raw.content;
  } else if (raw?.content != null) {
    try {
      content = JSON.stringify(raw.content);
    } catch {
      content = String(raw.content);
    }
  }

  const base = [project, role, type, created, content].join('|');

  if (base.trim().length === 0) {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
    return `msg_${Math.random().toString(36).slice(2)}`;
  }

  return `msg_${stableHash(base)}`;
};

const normalizeMetadata = (raw: unknown): MessageMetadata | null => {
  if (raw == null) {
    return null;
  }
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return normalizeMetadata(parsed);
    } catch (error) {
      console.error('[normalizeMetadata] Failed to parse JSON string:', error);
      return null;
    }
  }
  if (typeof raw === 'object') {
    return raw as MessageMetadata;
  }
  return null;
};

export const normalizeChatContent = (value: unknown): string => {
  if (value == null) {
    return '';
  }

  if (typeof value === 'string') {
    return sanitizeChatContent(value);
  }

  if (Array.isArray(value)) {
    return sanitizeChatContent(value
      .map((entry) => {
        if (typeof entry === 'string') {
          return entry;
        }
        if (entry && typeof entry === 'object') {
          const candidate = entry as { text?: unknown; content?: unknown; value?: unknown };
          if (typeof candidate.text === 'string') {
            return candidate.text;
          }
          if (typeof candidate.content === 'string') {
            return candidate.content;
          }
          if (typeof candidate.value === 'string') {
            return candidate.value;
          }
        }
        return '';
      })
      .join(''));
  }

  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const candidateKeys = ['text', 'content', 'value', 'message'];
    for (const key of candidateKeys) {
      const candidate = record[key];
      if (typeof candidate === 'string') {
        return sanitizeChatContent(candidate);
      }
    }

    if (Array.isArray(record.parts)) {
      return normalizeChatContent(record.parts);
    }
  }

  try {
    return sanitizeChatContent(JSON.stringify(value));
  } catch {
    return sanitizeChatContent(String(value));
  }
};

export const toChatMessage = (raw: any): ChatMessage => {
  const createdAt = raw?.createdAt ?? new Date().toISOString();
  const updatedAt = raw?.updatedAt ?? createdAt;
  const metadata = normalizeMetadata(raw?.metadata ?? raw?.metadataJson);

  return {
    id: deriveMessageId(raw),
    projectId: raw?.projectId ?? '',
    role: raw?.role ?? 'assistant',
    messageType: raw?.messageType ?? 'chat',
    content: normalizeChatContent(raw?.content),
    metadata,
    parentMessageId: raw?.parentMessageId ?? null,
    conversationId: raw?.conversationId ?? null,
    cliSource: raw?.cliSource ?? null,
    requestId: raw?.requestId ?? undefined,
    createdAt,
    updatedAt,
    isStreaming: raw?.isStreaming ?? false,
    isFinal: raw?.isFinal ?? false,
    isOptimistic: raw?.isOptimistic ?? false,
  } satisfies ChatMessage;
};
