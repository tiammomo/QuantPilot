import { MoAgentToolError } from './errors';

export function inputRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new MoAgentToolError('INVALID_TOOL_INPUT', 'Tool input must be a JSON object.');
  }
  return value as Record<string, unknown>;
}

export function requiredString(
  record: Record<string, unknown>,
  key: string,
  options: { allowEmpty?: boolean; maxLength?: number } = {},
): string {
  const value = record[key];
  if (typeof value !== 'string' || (!options.allowEmpty && value.length === 0)) {
    throw new MoAgentToolError('INVALID_TOOL_INPUT', `${key} must be a${options.allowEmpty ? '' : ' non-empty'} string.`);
  }
  if (options.maxLength !== undefined && value.length > options.maxLength) {
    throw new MoAgentToolError('INVALID_TOOL_INPUT', `${key} exceeds ${options.maxLength} characters.`);
  }
  return value;
}

export function optionalString(
  record: Record<string, unknown>,
  key: string,
  fallback: string,
  options: { allowEmpty?: boolean; maxLength?: number } = {},
): string {
  if (record[key] === undefined) return fallback;
  return requiredString(record, key, options);
}

export function optionalBoolean(record: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const value = record[key];
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') {
    throw new MoAgentToolError('INVALID_TOOL_INPUT', `${key} must be a boolean.`);
  }
  return value;
}

export function optionalInteger(
  record: Record<string, unknown>,
  key: string,
  fallback: number,
  options: { min: number; max: number },
): number {
  const value = record[key];
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || (value as number) < options.min || (value as number) > options.max) {
    throw new MoAgentToolError(
      'INVALID_TOOL_INPUT',
      `${key} must be an integer between ${options.min} and ${options.max}.`,
    );
  }
  return value as number;
}
