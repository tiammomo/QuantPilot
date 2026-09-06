import { describe, expect, it } from 'vitest';
import { parsePiAgentContextSnapshot } from './usage-snapshot';

const snapshot = {
  schemaVersion: 1,
  runId: 'run-a',
  model: 'test-model',
  turn: 2,
  observedAt: 1_780_000_000_000,
  source: 'estimated',
  inputTokens: 600,
  inputBudgetTokens: 800,
  contextWindowTokens: 1000,
  reservedOutputTokens: 100,
  compacted: true,
};

describe('context measurement contract', () => {
  it('accepts a bounded estimate and discards extra prompt or tool payloads', () => {
    expect(parsePiAgentContextSnapshot({ ...snapshot, prompt: 'private input', tools: ['private'] })).toEqual(snapshot);
  });
  it.each([
    { schemaVersion: 2 },
    { source: 'provider' },
    { turn: 0 },
    { observedAt: Infinity },
    { observedAt: 9_000_000_000_000_000 },
    { inputTokens: -1 },
    { inputTokens: 801 },
    { inputBudgetTokens: 0 },
    { inputBudgetTokens: 901 },
    { reservedOutputTokens: 201 },
    { model: '' },
    { model: 'invalid\nmodel' },
    { compacted: 'yes' },
  ])('rejects inconsistent or unsafe measurements: %j', (patch) => {
    expect(parsePiAgentContextSnapshot({ ...snapshot, ...patch })).toBeNull();
  });
});
