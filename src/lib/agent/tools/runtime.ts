import type { PiAgentToolResult } from '@/lib/agent/types';
import { PiAgentToolError, throwIfAborted } from './errors';

export const DEFAULT_TOOL_TIMEOUT_MS = 15_000;
export const DEFAULT_TOOL_OUTPUT_CHARS = 12_000;

function truncationMarker(omitted: number, original: number): string {
  return `\n\n[PI Agent output truncated: omitted ${omitted} characters from ${original}.]\n\n`;
}

export interface TruncatedText {
  text: string;
  truncated: boolean;
  originalChars: number;
}

/**
 * Bound model-visible output while preserving the beginning and diagnostic tail.
 */
export function truncateToolOutput(
  value: string,
  limit = DEFAULT_TOOL_OUTPUT_CHARS,
): TruncatedText {
  if (!Number.isSafeInteger(limit) || limit < 0) {
    throw new PiAgentToolError('INVALID_LIMIT', 'Tool output limit must be a non-negative integer.');
  }
  if (value.length <= limit) {
    return { text: value, truncated: false, originalChars: value.length };
  }
  if (limit === 0) {
    return { text: '', truncated: true, originalChars: value.length };
  }

  let marker = truncationMarker(value.length, value.length);
  let preserved = Math.max(0, limit - marker.length);
  for (let pass = 0; pass < 4; pass += 1) {
    const nextMarker = truncationMarker(value.length - preserved, value.length);
    const nextPreserved = Math.max(0, limit - nextMarker.length);
    marker = nextMarker;
    if (nextPreserved === preserved) break;
    preserved = nextPreserved;
  }

  if (marker.length >= limit) {
    return { text: marker.slice(0, limit), truncated: true, originalChars: value.length };
  }
  const tailChars = Math.min(Math.floor(preserved / 3), 4_000);
  const headChars = preserved - tailChars;
  return {
    text: `${value.slice(0, headChars)}${marker}${tailChars ? value.slice(-tailChars) : ''}`,
    truncated: true,
    originalChars: value.length,
  };
}

export async function withPiAgentTimeout<T>(
  parentSignal: AbortSignal,
  timeoutMs: number,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new PiAgentToolError('INVALID_TIMEOUT', 'PI Agent tool timeout must be a positive integer.');
  }
  throwIfAborted(parentSignal);

  const controller = new AbortController();
  let timedOut = false;
  let rejectCancellation: ((reason: unknown) => void) | undefined;
  const cancellation = new Promise<never>((_resolve, reject) => {
    rejectCancellation = reject;
  });
  const abortFromParent = () => {
    controller.abort(parentSignal.reason);
    rejectCancellation?.(new PiAgentToolError('ABORTED', 'PI Agent tool execution was aborted.'));
  };
  parentSignal.addEventListener('abort', abortFromParent, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error(`PI Agent tool timed out after ${timeoutMs}ms.`));
    rejectCancellation?.(new PiAgentToolError('TOOL_TIMEOUT', `PI Agent tool timed out after ${timeoutMs}ms.`));
  }, timeoutMs);

  try {
    return await Promise.race([operation(controller.signal), cancellation]);
  } catch (error) {
    if (timedOut) {
      throw new PiAgentToolError('TOOL_TIMEOUT', `PI Agent tool timed out after ${timeoutMs}ms.`);
    }
    if (parentSignal.aborted || controller.signal.aborted) {
      throw new PiAgentToolError('ABORTED', 'PI Agent tool execution was aborted.');
    }
    throw error;
  } finally {
    clearTimeout(timer);
    parentSignal.removeEventListener('abort', abortFromParent);
  }
}

export async function executePiAgentTool<T>(
  signal: AbortSignal,
  timeoutMs: number,
  operation: (operationSignal: AbortSignal) => Promise<PiAgentToolResult<T>>,
): Promise<PiAgentToolResult<T>> {
  try {
    return await withPiAgentTimeout(signal, timeoutMs, operation);
  } catch (error) {
    if (error instanceof PiAgentToolError) {
      return {
        ok: false,
        error: { code: error.code, message: error.message, details: error.details },
        content: error.message,
      };
    }
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      error: { code: 'TOOL_EXECUTION_FAILED', message },
      content: message,
    };
  }
}
