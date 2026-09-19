import { describe, expect, it } from 'vitest';

import {
  formatPiAgentDuration,
  formatPiAgentTokens,
  parsePiAgentTurnMetrics,
  type PiAgentTurnMetrics,
} from './agent-turn-metrics';

function metrics(overrides: Partial<PiAgentTurnMetrics> = {}): PiAgentTurnMetrics {
  return {
    schemaVersion: 1,
    elapsedMs: 138_000,
    agentRunCount: 2,
    modelTurnCount: 7,
    inputTokens: 32_810,
    outputTokens: 3_610,
    totalTokens: 36_420,
    cachedInputTokens: 25_000,
    cacheMissInputTokens: 7_810,
    reasoningTokens: 1_200,
    tokenAccounting: 'provider',
    ...overrides,
  };
}

describe('PI Agent turn metrics', () => {
  it('accepts a consistent versioned metric projection', () => {
    expect(parsePiAgentTurnMetrics(metrics())).toEqual(metrics());
  });

  it.each([
    metrics({ totalTokens: 36_421 }),
    metrics({ cacheMissInputTokens: 7_811 }),
    metrics({ reasoningTokens: 3_611 }),
    { ...metrics(), elapsedMs: -1 },
    { ...metrics(), totalTokens: Number.NaN },
    { ...metrics(), tokenAccounting: 'exact' },
    { ...metrics(), schemaVersion: 2 },
  ])('rejects malformed or arithmetically inconsistent metadata', (value) => {
    expect(parsePiAgentTurnMetrics(value)).toBeNull();
  });

  it('formats durations without false precision', () => {
    expect(formatPiAgentDuration(450)).toBe('<1 秒');
    expect(formatPiAgentDuration(12_000)).toBe('12 秒');
    expect(formatPiAgentDuration(138_000)).toBe('2 分 18 秒');
    expect(formatPiAgentDuration(3_660_000)).toBe('1 小时 1 分');
  });

  it('retains valid cumulative accounting when an optional context measurement is malformed', () => {
    expect(parsePiAgentTurnMetrics({ ...metrics(), contextSnapshot: { inputTokens: -1 } })).toEqual(metrics());
  });

  it('formats token counts with locale grouping', () => {
    expect(formatPiAgentTokens(36_420)).toBe('36,420');
    expect(formatPiAgentTokens(0)).toBe('0');
  });
});
