export class PiAgentToolError extends Error {
  readonly code: string;
  readonly details?: unknown;

  constructor(code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'PiAgentToolError';
    this.code = code;
    this.details = details;
  }
}

export function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  throw new PiAgentToolError('ABORTED', 'PI Agent tool execution was aborted.');
}
