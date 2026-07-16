import { describe, expect, it } from 'vitest';

import {
  formatMoAgentDuration,
  formatMoAgentTokens,
  parseMoAgentTurnMetrics,
  type MoAgentTurnMetrics,
} from './turn-metrics';

function metrics(overrides: Partial<MoAgentTurnMetrics> = {}): MoAgentTurnMetrics {
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

describe('MoAgent turn metrics', () => {
  it('accepts a consistent versioned metric projection', () => {
    expect(parseMoAgentTurnMetrics(metrics())).toEqual(metrics());
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
    expect(parseMoAgentTurnMetrics(value)).toBeNull();
  });

  it('formats durations without false precision', () => {
    expect(formatMoAgentDuration(450)).toBe('<1 秒');
    expect(formatMoAgentDuration(12_000)).toBe('12 秒');
    expect(formatMoAgentDuration(138_000)).toBe('2 分 18 秒');
    expect(formatMoAgentDuration(3_660_000)).toBe('1 小时 1 分');
  });

  it('formats token counts with locale grouping', () => {
    expect(formatMoAgentTokens(36_420)).toBe('36,420');
    expect(formatMoAgentTokens(0)).toBe('0');
  });
});
