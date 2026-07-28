type ErrorLike = {
  code?: unknown;
  message?: unknown;
  cause?: unknown;
  repairableByValidation?: unknown;
};

const REPAIRABLE_BY_VALIDATION_CODES = new Set([
  'MAX_TOKENS',
  'MAX_TURNS',
  'MAX_TOTAL_TOOL_CALLS',
  'MODEL_STOPPED',
  'TERMINAL_TOOL_REQUIRED',
]);

function errorLike(value: unknown): ErrorLike | null {
  return typeof value === 'object' && value !== null ? value as ErrorLike : null;
}

function errorCode(value: ErrorLike): string | null {
  return typeof value.code === 'string' && value.code.trim()
    ? value.code.trim()
    : null;
}

function errorMessage(value: ErrorLike): string | null {
  return typeof value.message === 'string' && value.message.trim()
    ? value.message.trim()
    : null;
}

function isMissingPiAgentSchema(code: string | null, message: string | null): boolean {
  if (code === 'P2021' || code === 'P2022') return true;
  return Boolean(
    message &&
    /(?:agent_runs|agent_workspace_leases|agent_events|agent_checkpoints|agent_tool_executions)/i.test(message) &&
    /(?:does not exist|missing|unknown column|not found)/i.test(message)
  );
}

export class PiAgentExecutionError extends Error {
  readonly code: string;
  readonly repairableByValidation: boolean;

  constructor(
    code: string,
    message: string,
    options: ErrorOptions & { repairableByValidation?: boolean } = {},
  ) {
    super(message, options);
    this.name = 'PiAgentExecutionError';
    this.code = code;
    this.repairableByValidation =
      options.repairableByValidation ?? REPAIRABLE_BY_VALIDATION_CODES.has(code);
  }
}

/**
 * Walks a bounded Error.cause chain so product orchestration can distinguish
 * workspace-repairable model failures from infrastructure/runtime failures.
 */
export function classifyPiAgentExecutionError(error: unknown): PiAgentExecutionError | null {
  let current: unknown = error;
  const visited = new Set<unknown>();

  for (let depth = 0; depth < 8 && current !== undefined && current !== null; depth += 1) {
    if (visited.has(current)) break;
    visited.add(current);
    if (current instanceof PiAgentExecutionError) return current;

    const candidate = errorLike(current);
    if (!candidate) break;
    const code = errorCode(candidate);
    const message = errorMessage(candidate);

    if (code === 'PI_AGENT_SCHEMA_NOT_READY' || isMissingPiAgentSchema(code, message)) {
      return new PiAgentExecutionError(
        'PI_AGENT_SCHEMA_NOT_READY',
        'PI Agent 数据库结构未就绪，请先执行数据库迁移后再重试。',
        { cause: error, repairableByValidation: false },
      );
    }

    if (code) {
      return new PiAgentExecutionError(
        code,
        message ?? `PI Agent execution failed with ${code}.`,
        {
          cause: error,
          repairableByValidation:
            typeof candidate.repairableByValidation === 'boolean'
              ? candidate.repairableByValidation
              : REPAIRABLE_BY_VALIDATION_CODES.has(code),
        },
      );
    }
    current = candidate.cause;
  }

  return null;
}
