export type MoAgentExecutionProfile = 'generation' | 'repair';

export type MoAgentPreparedExecutionIntent = 'standard' | 'custom' | null;

export type MoAgentExecutionLane =
  | 'deterministic_standard'
  | 'model_custom'
  | 'model_repair'
  | 'model_data_preparation';

export type MoAgentExecutionPhase =
  | 'deterministic-prepare'
  | 'inspect-edit-submit'
  | 'failure-scoped-repair'
  | 'data-prepare-edit-submit';

export interface MoAgentPhaseGraphInput {
  profile: MoAgentExecutionProfile;
  platformPrepared: boolean;
  preparedIntent: MoAgentPreparedExecutionIntent;
  hasAttachments: boolean;
  dashboardSpecReady: boolean;
}

export interface MoAgentPhaseGraph {
  schemaVersion: 1;
  lane: MoAgentExecutionLane;
  phase: MoAgentExecutionPhase;
  providerMode: 'deterministic' | 'model';
  reasoningEffort: 'low' | 'medium' | 'high';
  budgets: {
    maxTurns: number;
    maxToolCalls: number;
    maxOutputTokens: number;
    maxCacheMissInputTokens: number;
    /** Hard cap over one fully prepared provider request. */
    maxPreparedInputTokens: number;
    /** Hard cumulative reservation over all estimated full provider inputs. */
    maxCumulativePreparedInputTokens: number;
    /**
     * No-progress tool turns before soft next-turn convergence guidance.
     * The executor's generic hard read gate still requires at least two
     * consecutive no-progress turns (or an independent repeated-read gate).
     */
    progressStallTurns: number;
  };
  invariants: {
    stableToolSchema: true;
    singleWriter: true;
    terminalSubmissionRequired: true;
    platformVerificationRequired: true;
  };
}

const INVARIANTS = Object.freeze({
  stableToolSchema: true as const,
  singleWriter: true as const,
  terminalSubmissionRequired: true as const,
  platformVerificationRequired: true as const,
});

function graph(
  lane: MoAgentExecutionLane,
  phase: MoAgentExecutionPhase,
  providerMode: MoAgentPhaseGraph['providerMode'],
  reasoningEffort: MoAgentPhaseGraph['reasoningEffort'],
  budgets: MoAgentPhaseGraph['budgets'],
): MoAgentPhaseGraph {
  return Object.freeze({
    schemaVersion: 1 as const,
    lane,
    phase,
    providerMode,
    reasoningEffort,
    budgets: Object.freeze({ ...budgets }),
    invariants: INVARIANTS,
  });
}

/**
 * Selects the smallest safe execution lane before a provider is contacted.
 * The graph is deliberately deterministic: trusted platform preparation and
 * validation decide the lane, never model-authored text.
 */
export function createMoAgentPhaseGraph(
  input: MoAgentPhaseGraphInput,
): MoAgentPhaseGraph {
  if (input.profile === 'repair') {
    return graph(
      'model_repair',
      'failure-scoped-repair',
      'model',
      'medium',
      {
        maxTurns: 3,
        maxToolCalls: 8,
        maxOutputTokens: 6_000,
        maxCacheMissInputTokens: 20_000,
        maxPreparedInputTokens: 20_000,
        maxCumulativePreparedInputTokens: 60_000,
        progressStallTurns: 1,
      },
    );
  }

  if (
    input.platformPrepared &&
    !input.hasAttachments &&
    input.preparedIntent === 'standard' &&
    input.dashboardSpecReady
  ) {
    return graph(
      'deterministic_standard',
      'deterministic-prepare',
      'deterministic',
      'low',
      {
        maxTurns: 2,
        maxToolCalls: 2,
        maxOutputTokens: 1,
        maxCacheMissInputTokens: 1,
        maxPreparedInputTokens: 1,
        maxCumulativePreparedInputTokens: 1,
        progressStallTurns: 1,
      },
    );
  }

  if (
    input.platformPrepared &&
    !input.hasAttachments &&
    input.preparedIntent === 'custom'
  ) {
    return graph(
      'model_custom',
      'inspect-edit-submit',
      'model',
      'medium',
      {
        maxTurns: 3,
        maxToolCalls: 8,
        maxOutputTokens: 8_000,
        maxCacheMissInputTokens: 24_000,
        maxPreparedInputTokens: 24_000,
        maxCumulativePreparedInputTokens: 72_000,
        progressStallTurns: 1,
      },
    );
  }

  return graph(
    'model_data_preparation',
    'data-prepare-edit-submit',
    'model',
    'high',
    {
      maxTurns: 8,
      maxToolCalls: 20,
      maxOutputTokens: 16_000,
      maxCacheMissInputTokens: 60_000,
      maxPreparedInputTokens: 60_000,
      maxCumulativePreparedInputTokens: 480_000,
      progressStallTurns: 2,
    },
  );
}
