export class MoAgentToolError extends Error {
  readonly code: string;
  readonly details?: unknown;

  constructor(code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'MoAgentToolError';
    this.code = code;
    this.details = details;
  }
}

export function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  throw new MoAgentToolError('ABORTED', 'MoAgent tool execution was aborted.');
}
