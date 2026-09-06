/** A single prepared input measurement, never a cumulative usage or billing total. */
export interface PiAgentContextSnapshot {
  schemaVersion: 1;
  runId: string;
  model: string;
  turn: number;
  observedAt: number;
  source: 'estimated';
  inputTokens: number;
  inputBudgetTokens: number;
  contextWindowTokens: number;
  reservedOutputTokens: number;
  compacted: boolean;
}

export function parsePiAgentContextSnapshot(value: unknown): PiAgentContextSnapshot | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const data = value as Record<string, unknown>;
  if (data.schemaVersion !== 1 || data.source !== 'estimated' || typeof data.compacted !== 'boolean') return null;
  for (const key of ['runId', 'model']) {
    if (
      typeof data[key] !== 'string' ||
      !(data[key] as string).trim() ||
      (data[key] as string).length > 256 ||
      /[\u0000-\u001f\u007f]/.test(data[key] as string)
    )
      return null;
  }
  for (const key of [
    'turn',
    'observedAt',
    'inputTokens',
    'inputBudgetTokens',
    'contextWindowTokens',
    'reservedOutputTokens',
  ]) {
    if (!Number.isSafeInteger(data[key]) || (data[key] as number) < 0) return null;
  }
  const { turn, observedAt, inputTokens, inputBudgetTokens, contextWindowTokens, reservedOutputTokens } =
    data as unknown as PiAgentContextSnapshot;
  if (
    turn < 1 ||
    observedAt > 8_640_000_000_000_000 ||
    inputBudgetTokens < 1 ||
    contextWindowTokens < 1 ||
    inputTokens > inputBudgetTokens ||
    inputBudgetTokens > contextWindowTokens - reservedOutputTokens
  )
    return null;
  return {
    schemaVersion: 1,
    runId: data.runId as string,
    model: data.model as string,
    turn,
    observedAt,
    source: 'estimated',
    inputTokens,
    inputBudgetTokens,
    contextWindowTokens,
    reservedOutputTokens,
    compacted: data.compacted,
  };
}
