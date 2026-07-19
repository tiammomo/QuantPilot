import { describe, expect, it } from 'vitest';

import { createMoAgentPhaseGraph } from './phase-graph';

describe('MoAgent PhaseGraph', () => {
  it('routes a trusted prepared standard dashboard to zero-model execution', () => {
    expect(createMoAgentPhaseGraph({
      profile: 'generation',
      platformPrepared: true,
      preparedIntent: 'standard',
      hasAttachments: false,
      dashboardSpecReady: true,
    })).toMatchObject({
      lane: 'deterministic_standard',
      providerMode: 'deterministic',
      budgets: { maxTurns: 2, maxToolCalls: 2 },
    });
  });

  it.each([
    { hasAttachments: true, dashboardSpecReady: true },
    { hasAttachments: false, dashboardSpecReady: false },
  ])('fails closed to model preparation when deterministic prerequisites are absent', (override) => {
    expect(createMoAgentPhaseGraph({
      profile: 'generation',
      platformPrepared: true,
      preparedIntent: 'standard',
      ...override,
    }).lane).toBe('model_data_preparation');
  });

  it('gives custom edits enough inspect/write/submit turns while keeping repair tighter', () => {
    const custom = createMoAgentPhaseGraph({
      profile: 'generation',
      platformPrepared: true,
      preparedIntent: 'custom',
      hasAttachments: false,
      dashboardSpecReady: false,
    });
    const repair = createMoAgentPhaseGraph({
      profile: 'repair',
      platformPrepared: true,
      preparedIntent: null,
      hasAttachments: false,
      dashboardSpecReady: false,
    });

    expect(custom).toMatchObject({
      lane: 'model_custom',
      budgets: {
        maxTurns: 6,
        maxToolCalls: 12,
        maxPreparedInputTokens: 24_000,
        maxCumulativePreparedInputTokens: 144_000,
        progressStallTurns: 1,
      },
    });
    expect(repair).toMatchObject({
      lane: 'model_repair',
      budgets: {
        maxTurns: 3,
        maxPreparedInputTokens: 20_000,
        maxCumulativePreparedInputTokens: 60_000,
        progressStallTurns: 1,
      },
    });
  });

  it('keeps per-request, cumulative prepared-input, and cache-miss budgets independent', () => {
    const dataPreparation = createMoAgentPhaseGraph({
      profile: 'generation',
      platformPrepared: false,
      preparedIntent: null,
      hasAttachments: false,
      dashboardSpecReady: false,
    });

    expect(dataPreparation.budgets).toMatchObject({
      maxTurns: 8,
      maxPreparedInputTokens: 60_000,
      maxCumulativePreparedInputTokens: 480_000,
      maxCacheMissInputTokens: 60_000,
    });
  });

  it('returns immutable policy objects', () => {
    const selected = createMoAgentPhaseGraph({
      profile: 'generation',
      platformPrepared: false,
      preparedIntent: null,
      hasAttachments: false,
      dashboardSpecReady: false,
    });

    expect(Object.isFrozen(selected)).toBe(true);
    expect(Object.isFrozen(selected.budgets)).toBe(true);
    expect(Object.isFrozen(selected.invariants)).toBe(true);
  });
});
