import type { ChatMessage } from '@/types';

const COLLAPSIBLE_READ_TOOLS = new Set([
  'inspect_dashboard_contract',
  'list_files',
  'query_json',
  'query_text_file',
  'read_file',
  'read_file_range',
  'search_files',
]);

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function activityIdentity(message: ChatMessage): {
  key: string;
  toolName: string;
  target: string;
  metadata: Record<string, unknown>;
} | null {
  if (message.messageType !== 'tool_use' || !message.requestId) return null;
  const metadata = record(message.metadata);
  if (!metadata) return null;
  const toolName = text(metadata.toolName) ?? text(metadata.tool_name);
  if (!toolName || !COLLAPSIBLE_READ_TOOLS.has(toolName)) return null;
  const input = record(metadata.toolInput ?? metadata.tool_input ?? metadata.input);
  const target = text(metadata.target) ?? text(metadata.filePath) ?? text(metadata.path) ??
    text(input?.path) ?? toolName;
  return {
    key: `${message.requestId}\0${toolName}\0${target}`,
    toolName,
    target,
    metadata,
  };
}

function completedSummary(toolName: string, target: string, attempts: number): string | undefined {
  if (attempts <= 1) return undefined;
  if (toolName === 'query_json') return `已汇总 ${target} 的 ${attempts} 组数据字段。`;
  if (toolName === 'query_text_file') return `已汇总 ${target} 的 ${attempts} 组源码定位结果。`;
  if (toolName === 'read_file' || toolName === 'read_file_range') {
    return `已完成 ${target} 的定向读取。`;
  }
  return `已合并完成 ${attempts} 次同目标读取。`;
}

/**
 * Turn low-level read attempts into one stable activity row per request/tool/
 * target. A later success absorbs earlier parameter failures, while an
 * unrecovered final failure remains visible and inspectable.
 */
export function collapseToolReadActivities(messages: ChatMessage[]): ChatMessage[] {
  const output: ChatMessage[] = [];
  const indexByIdentity = new Map<string, number>();

  for (const message of messages) {
    const identity = activityIdentity(message);
    if (!identity) {
      output.push(message);
      continue;
    }
    const existingIndex = indexByIdentity.get(identity.key);
    if (existingIndex === undefined) {
      indexByIdentity.set(identity.key, output.length);
      output.push({
        ...message,
        metadata: {
          ...identity.metadata,
          activityAttemptCount: 1,
          activityFailureCount: identity.metadata.success === false ? 1 : 0,
        },
      });
      continue;
    }

    const existing = output[existingIndex];
    const existingMetadata = record(existing.metadata) ?? {};
    const attempts = Number(existingMetadata.activityAttemptCount ?? 1) + 1;
    const failures = Number(existingMetadata.activityFailureCount ?? 0) +
      (identity.metadata.success === false ? 1 : 0);
    const summary = identity.metadata.success === true
      ? completedSummary(identity.toolName, identity.target, attempts)
      : text(identity.metadata.summary) ?? text(existingMetadata.summary) ?? undefined;

    output[existingIndex] = {
      ...existing,
      updatedAt: message.updatedAt ?? message.createdAt,
      isStreaming: message.isStreaming,
      isFinal: message.isFinal,
      metadata: {
        ...existingMetadata,
        ...identity.metadata,
        ...(summary ? { summary } : {}),
        activityAttemptCount: attempts,
        activityFailureCount: failures,
        recoveredFailureCount: identity.metadata.success === true ? failures : 0,
      },
    };
  }

  return output;
}
