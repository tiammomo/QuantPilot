import { collectTrustedContextTargetReferences } from '../context';
import type {
  MoAgentRunRequest,
  MoAgentTool,
  MoAgentToolCall,
  MoAgentToolContextReceipt,
  MoAgentToolResult,
} from '../types';
import { parseMoAgentToolArguments } from './tool-arguments';

export interface MoAgentToolExecution {
  result: MoAgentToolResult;
  terminal: boolean;
  durationMs: number;
  targetReferences: string[];
  contextReceipt?: MoAgentToolContextReceipt;
}

function failure(code: string, message: string, details?: unknown): MoAgentToolResult {
  return {
    ok: false,
    error: { code, message, ...(details === undefined ? {} : { details }) },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isToolResult(value: unknown): value is MoAgentToolResult {
  if (!isRecord(value) || typeof value.ok !== 'boolean') return false;
  return value.ok
    ? Object.prototype.hasOwnProperty.call(value, 'data')
    : isRecord(value.error) &&
        typeof value.error.code === 'string' &&
        typeof value.error.message === 'string';
}

async function abortable<T>(operation: PromiseLike<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    throw signal.reason ?? new DOMException('The operation was aborted.', 'AbortError');
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(
      signal.reason ?? new DOMException('The operation was aborted.', 'AbortError'),
    );
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(operation).then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

function projectContextReceipt(
  tool: MoAgentTool,
  input: unknown,
  result: MoAgentToolResult,
): MoAgentToolContextReceipt | undefined {
  if (!tool.projectContextReceipt) return undefined;
  try {
    const projected = tool.projectContextReceipt(input, result);
    if (!projected) return undefined;
    const targetReferences = collectTrustedContextTargetReferences({
      paths: projected.targetReferences,
    });
    const artifactSha256 =
      typeof projected.artifactSha256 === 'string' &&
      /^[a-f0-9]{64}$/.test(projected.artifactSha256)
        ? projected.artifactSha256
        : undefined;
    const bytes =
      typeof projected.bytes === 'number' &&
      Number.isSafeInteger(projected.bytes) &&
      projected.bytes >= 0
        ? projected.bytes
        : undefined;
    return {
      targetReferences,
      ...(artifactSha256 ? { artifactSha256 } : {}),
      ...(bytes === undefined ? {} : { bytes }),
    };
  } catch {
    // Receipt projection is a compression optimisation, never correctness.
    return undefined;
  }
}

function emptyFailure(
  result: MoAgentToolResult,
  startedAt: number,
  now: () => number,
): MoAgentToolExecution {
  return {
    result,
    terminal: false,
    durationMs: now() - startedAt,
    targetReferences: [],
  };
}

export async function executeMoAgentTool(options: {
  tool: MoAgentTool | undefined;
  toolCall: MoAgentToolCall;
  turn: number;
  runId: string;
  operationId: string;
  signal: AbortSignal;
  now: () => number;
  commitWorkspaceMutation: MoAgentRunRequest['commitWorkspaceMutation'];
}): Promise<MoAgentToolExecution> {
  const startedAt = options.now();
  const { tool, toolCall, signal } = options;
  if (!tool) {
    return emptyFailure(
      failure('UNKNOWN_TOOL', `The tool "${toolCall.name || '(empty name)'}" is not registered.`),
      startedAt,
      options.now,
    );
  }

  let parsed: unknown;
  try {
    parsed = parseMoAgentToolArguments(toolCall.arguments).value;
  } catch (error) {
    return emptyFailure(
      failure('INVALID_TOOL_ARGUMENTS', 'Tool arguments must be valid JSON.', {
        parseError: errorMessage(error),
      }),
      startedAt,
      options.now,
    );
  }
  if (!isRecord(parsed)) {
    return emptyFailure(
      failure('INVALID_TOOL_ARGUMENTS', 'Tool arguments must be a JSON object.'),
      startedAt,
      options.now,
    );
  }

  let input: unknown = parsed;
  if (tool.parseInput) {
    try {
      input = tool.parseInput(parsed);
    } catch (error) {
      return emptyFailure(
        failure('INVALID_TOOL_INPUT', errorMessage(error)),
        startedAt,
        options.now,
      );
    }
  }

  try {
    // The durable tool_started event is consumed before this function runs.
    if (signal.aborted) {
      return emptyFailure(
        failure(
          'TOOL_EXECUTION_ABORTED',
          'Tool execution was aborted before its outcome could be confirmed.',
        ),
        startedAt,
        options.now,
      );
    }
    const candidate = await abortable(
      Promise.resolve(
        tool.execute(input, {
          runId: options.runId,
          turn: options.turn,
          toolCallId: toolCall.id,
          operationId: options.operationId,
          signal,
          ...(options.commitWorkspaceMutation
            ? {
                commitWorkspaceMutation: <T>(commit: () => Promise<T>) =>
                  options.commitWorkspaceMutation!(options.operationId, commit),
              }
            : {}),
        }),
      ),
      signal,
    );
    if (!isToolResult(candidate)) {
      return emptyFailure(
        failure(
          'INVALID_TOOL_RESULT',
          `Tool "${tool.name}" returned an invalid result envelope.`,
        ),
        startedAt,
        options.now,
      );
    }
    const contextReceipt = projectContextReceipt(tool, input, candidate);
    return {
      result: candidate,
      terminal: candidate.ok && tool.terminal === true,
      durationMs: options.now() - startedAt,
      targetReferences: contextReceipt ? [...contextReceipt.targetReferences] : [],
      ...(contextReceipt ? { contextReceipt } : {}),
    };
  } catch (error) {
    return emptyFailure(
      signal.aborted
        ? failure(
            'TOOL_EXECUTION_ABORTED',
            'Tool execution was aborted before its outcome could be confirmed.',
          )
        : failure('TOOL_EXECUTION_FAILED', errorMessage(error)),
      startedAt,
      options.now,
    );
  }
}
