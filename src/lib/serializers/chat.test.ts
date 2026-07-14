import { describe, expect, it } from 'vitest';
import type { Message } from '@/types/backend';
import { serializeMessage } from './chat';
import { compactToolOutputPreview, TOOL_OUTPUT_PREVIEW_LIMIT } from '@/lib/utils/tool-output';

function messageWith(content: string, metadata: Record<string, unknown>): Message {
  const now = new Date('2026-07-14T00:00:00.000Z');
  return {
    id: 'message-1',
    projectId: 'project-1',
    conversationId: null,
    sessionId: null,
    role: 'tool',
    content,
    messageType: 'tool_result',
    metadataJson: JSON.stringify(metadata),
    parentMessageId: null,
    cliSource: 'claude',
    createdAt: now,
    updatedAt: now,
  };
}

describe('tool output serialization', () => {
  it('keeps a persisted preview unchanged and preserves truncation metadata', () => {
    const raw = `HEAD:${'a'.repeat(25_000)}:TAIL_DIAGNOSTIC`;
    const preview = compactToolOutputPreview(raw);
    const serialized = serializeMessage(messageWith(preview, {
      toolOutput: preview,
      toolOutputTruncated: true,
      toolOutputOriginalChars: raw.length,
    }));

    expect(preview.length).toBeLessThanOrEqual(TOOL_OUTPUT_PREVIEW_LIMIT);
    expect(serialized.content).toBe(preview);
    expect(serialized.metadata?.toolOutput).toBe(preview);
    expect(serialized.metadata?.toolOutputTruncated).toBe(true);
    expect(serialized.metadata?.toolOutputOriginalChars).toBe(raw.length);
    expect(preview).toContain('HEAD:');
    expect(preview).toContain(':TAIL_DIAGNOSTIC');
  });

  it('compacts a legacy oversized tool result once with both head and tail', () => {
    const raw = `BEGIN:${'b'.repeat(25_000)}:END_STACK`;
    const serialized = serializeMessage(messageWith(raw, { toolOutput: raw }));

    expect(serialized.content.length).toBeLessThanOrEqual(TOOL_OUTPUT_PREVIEW_LIMIT);
    expect(serialized.metadata?.toolOutput).toBe(serialized.content);
    expect(serialized.metadata?.toolOutputTruncated).toBe(true);
    expect(serialized.metadata?.toolOutputOriginalChars).toBe(raw.length);
    expect(serialized.content).toContain('BEGIN:');
    expect(serialized.content).toContain(':END_STACK');
    expect(serialized.content.match(/QuantPilot 已截断/g)).toHaveLength(1);
  });
});
