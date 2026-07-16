/**
 * A deterministic, provider-neutral progress oracle.
 *
 * The oracle deliberately distinguishes activity from verifiable progress:
 * tool calls and successful-write counters are diagnostic inputs only. Callers
 * must supply stable fingerprints for trusted facts, workspace snapshots, and
 * tool observations. Completion remains the responsibility of the Mission
 * evidence/terminal contract; this module can only report progress or stalling.
 */

export const PROGRESS_ORACLE_STATE_VERSION = 1 as const;
export const DEFAULT_PROGRESS_ORACLE_STALL_TURNS = 2;

export type ProgressOracleSignal =
  | 'trusted_fact_added'
  | 'workspace_advanced'
  | 'failed_checks_reduced';

export type ProgressOracleStallSignal =
  | 'no_verifiable_progress'
  | 'repeated_tool_observation'
  | 'workspace_revisited'
  | 'failed_checks_increased'
  | 'successful_write_without_verifiable_progress';

export interface ProgressOracleTurnObservation {
  /**
   * Stable identities for facts observed during this turn. Re-observing an
   * identity already seen by the oracle is not progress.
   */
  trustedFactFingerprints?: readonly string[];
  /**
   * Stable hash/generation identity for the workspace after this turn. The
   * first value establishes a baseline; revisiting an older value is not
   * progress even though it differs from the immediately preceding value.
   */
  workspaceFingerprint?: string;
  /** Number of currently failing deterministic validation checks. */
  failedCheckCount?: number;
  /**
   * Stable identities for tool observations (normally tool name + canonical
   * input + canonical result receipt). Novel tool activity is not itself
   * progress; repeats are surfaced as a stalling diagnostic.
   */
  toolObservationFingerprints?: readonly string[];
  /** Diagnostic only. A successful write is never completion evidence. */
  successfulWorkspaceWrites?: number;
}

export interface ProgressOracleState {
  version: typeof PROGRESS_ORACLE_STATE_VERSION;
  turnsObserved: number;
  consecutiveNoProgressTurns: number;
  seenTrustedFactFingerprints: readonly string[];
  seenWorkspaceFingerprints: readonly string[];
  lastWorkspaceFingerprint: string | null;
  lastFailedCheckCount: number | null;
  seenToolObservationFingerprints: readonly string[];
}

export interface ProgressOracleDecision {
  turn: number;
  progressed: boolean;
  stalled: boolean;
  consecutiveNoProgressTurns: number;
  stallAfterConsecutiveNoProgressTurns: number;
  progressSignals: readonly ProgressOracleSignal[];
  stallSignals: readonly ProgressOracleStallSignal[];
  newTrustedFactFingerprints: readonly string[];
  workspaceObserved: boolean;
  workspaceChanged: boolean;
  workspaceAdvanced: boolean;
  workspaceRevisited: boolean;
  previousFailedCheckCount: number | null;
  failedCheckCount: number | null;
  /** Current minus previous; a negative value means fewer failures. */
  failedCheckCountChange: number | null;
  novelToolObservationFingerprints: readonly string[];
  repeatedToolObservationFingerprints: readonly string[];
  successfulWorkspaceWrites: number;
}

export interface ProgressOracleEvaluation {
  state: ProgressOracleState;
  decision: ProgressOracleDecision;
}

export interface ProgressOracleOptions {
  stallAfterConsecutiveNoProgressTurns?: number;
  initialState?: ProgressOracleState;
}

function nonNegativeSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer.`);
  }
  return value;
}

function positiveSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive safe integer.`);
  }
  return value;
}

function fingerprint(value: string, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.trim().length === 0) {
    throw new Error(`${label} must contain a non-empty fingerprint.`);
  }
  return value;
}

function sortedUnique(values: readonly string[], label: string): string[] {
  if (!Array.isArray(values)) {
    throw new Error(`${label} must be an array of fingerprints.`);
  }
  return [...new Set(values.map((value) => fingerprint(value, label)))].sort();
}

function normalizedState(state: ProgressOracleState): ProgressOracleState {
  if (state.version !== PROGRESS_ORACLE_STATE_VERSION) {
    throw new Error(`Unsupported ProgressOracle state version: ${String(state.version)}.`);
  }
  const turnsObserved = nonNegativeSafeInteger(state.turnsObserved, 'turnsObserved');
  const consecutiveNoProgressTurns = nonNegativeSafeInteger(
    state.consecutiveNoProgressTurns,
    'consecutiveNoProgressTurns',
  );
  if (consecutiveNoProgressTurns > turnsObserved) {
    throw new Error('consecutiveNoProgressTurns cannot exceed turnsObserved.');
  }
  const seenWorkspaceFingerprints = sortedUnique(
    state.seenWorkspaceFingerprints,
    'seenWorkspaceFingerprints',
  );
  const lastWorkspaceFingerprint = state.lastWorkspaceFingerprint === null
    ? null
    : fingerprint(state.lastWorkspaceFingerprint, 'lastWorkspaceFingerprint');
  if (
    lastWorkspaceFingerprint !== null &&
    !seenWorkspaceFingerprints.includes(lastWorkspaceFingerprint)
  ) {
    seenWorkspaceFingerprints.push(lastWorkspaceFingerprint);
    seenWorkspaceFingerprints.sort();
  }
  const lastFailedCheckCount = state.lastFailedCheckCount === null
    ? null
    : nonNegativeSafeInteger(state.lastFailedCheckCount, 'lastFailedCheckCount');

  return {
    version: PROGRESS_ORACLE_STATE_VERSION,
    turnsObserved,
    consecutiveNoProgressTurns,
    seenTrustedFactFingerprints: sortedUnique(
      state.seenTrustedFactFingerprints,
      'seenTrustedFactFingerprints',
    ),
    seenWorkspaceFingerprints,
    lastWorkspaceFingerprint,
    lastFailedCheckCount,
    seenToolObservationFingerprints: sortedUnique(
      state.seenToolObservationFingerprints,
      'seenToolObservationFingerprints',
    ),
  };
}

export function createProgressOracleState(): ProgressOracleState {
  return {
    version: PROGRESS_ORACLE_STATE_VERSION,
    turnsObserved: 0,
    consecutiveNoProgressTurns: 0,
    seenTrustedFactFingerprints: [],
    seenWorkspaceFingerprints: [],
    lastWorkspaceFingerprint: null,
    lastFailedCheckCount: null,
    seenToolObservationFingerprints: [],
  };
}

function toolFingerprintDelta(
  previouslySeen: ReadonlySet<string>,
  observations: readonly string[],
): { novel: string[]; repeated: string[] } {
  if (!Array.isArray(observations)) {
    throw new Error('toolObservationFingerprints must be an array of fingerprints.');
  }
  const novel = new Set<string>();
  const repeated = new Set<string>();
  const seenThisTurn = new Set<string>();
  for (const raw of observations) {
    const current = fingerprint(raw, 'toolObservationFingerprints');
    if (previouslySeen.has(current) || seenThisTurn.has(current)) {
      repeated.add(current);
    } else {
      novel.add(current);
    }
    seenThisTurn.add(current);
  }
  return {
    novel: [...novel].sort(),
    repeated: [...repeated].sort(),
  };
}

/**
 * Pure reducer form of the oracle. The returned state is serializable and may
 * be persisted at a safe turn boundary, making replay deterministic.
 */
export function evaluateProgressOracleTurn(
  previousState: ProgressOracleState,
  observation: ProgressOracleTurnObservation,
  options: Pick<ProgressOracleOptions, 'stallAfterConsecutiveNoProgressTurns'> = {},
): ProgressOracleEvaluation {
  const state = normalizedState(previousState);
  const stallAfter = positiveSafeInteger(
    options.stallAfterConsecutiveNoProgressTurns ?? DEFAULT_PROGRESS_ORACLE_STALL_TURNS,
    'stallAfterConsecutiveNoProgressTurns',
  );
  const trustedFacts = sortedUnique(
    observation.trustedFactFingerprints ?? [],
    'trustedFactFingerprints',
  );
  const priorFacts = new Set(state.seenTrustedFactFingerprints);
  const newTrustedFactFingerprints = trustedFacts.filter((value) => !priorFacts.has(value));

  const workspaceObserved = observation.workspaceFingerprint !== undefined;
  const currentWorkspaceFingerprint = workspaceObserved
    ? fingerprint(observation.workspaceFingerprint!, 'workspaceFingerprint')
    : null;
  const previousWorkspaceFingerprint = state.lastWorkspaceFingerprint;
  const workspaceChanged = currentWorkspaceFingerprint !== null &&
    previousWorkspaceFingerprint !== null &&
    currentWorkspaceFingerprint !== previousWorkspaceFingerprint;
  const priorWorkspaces = new Set(state.seenWorkspaceFingerprints);
  const workspaceRevisited = workspaceChanged && priorWorkspaces.has(currentWorkspaceFingerprint!);
  const workspaceAdvanced = workspaceChanged && !workspaceRevisited;

  const failedCheckCount = observation.failedCheckCount === undefined
    ? null
    : nonNegativeSafeInteger(observation.failedCheckCount, 'failedCheckCount');
  const previousFailedCheckCount = state.lastFailedCheckCount;
  const failedCheckCountChange = failedCheckCount === null || previousFailedCheckCount === null
    ? null
    : failedCheckCount - previousFailedCheckCount;
  const failedChecksReduced = failedCheckCountChange !== null && failedCheckCountChange < 0;
  const failedChecksIncreased = failedCheckCountChange !== null && failedCheckCountChange > 0;

  const priorTools = new Set(state.seenToolObservationFingerprints);
  const toolDelta = toolFingerprintDelta(
    priorTools,
    observation.toolObservationFingerprints ?? [],
  );
  const successfulWorkspaceWrites = nonNegativeSafeInteger(
    observation.successfulWorkspaceWrites ?? 0,
    'successfulWorkspaceWrites',
  );

  const progressSignals: ProgressOracleSignal[] = [];
  if (newTrustedFactFingerprints.length > 0) {
    progressSignals.push('trusted_fact_added');
  }
  // A workspace change that made deterministic validation worse is activity,
  // but not net artifact progress. Newly trusted facts remain useful progress.
  if (workspaceAdvanced && !failedChecksIncreased) {
    progressSignals.push('workspace_advanced');
  }
  if (failedChecksReduced) {
    progressSignals.push('failed_checks_reduced');
  }
  const progressed = progressSignals.length > 0;
  const consecutiveNoProgressTurns = progressed
    ? 0
    : state.consecutiveNoProgressTurns + 1;

  const stallSignals = new Set<ProgressOracleStallSignal>();
  if (!progressed) stallSignals.add('no_verifiable_progress');
  if (toolDelta.repeated.length > 0) stallSignals.add('repeated_tool_observation');
  if (workspaceRevisited) stallSignals.add('workspace_revisited');
  if (failedChecksIncreased) stallSignals.add('failed_checks_increased');
  if (successfulWorkspaceWrites > 0 && !progressed) {
    stallSignals.add('successful_write_without_verifiable_progress');
  }

  const nextFacts = new Set(state.seenTrustedFactFingerprints);
  trustedFacts.forEach((value) => nextFacts.add(value));
  const nextWorkspaces = new Set(state.seenWorkspaceFingerprints);
  if (currentWorkspaceFingerprint !== null) nextWorkspaces.add(currentWorkspaceFingerprint);
  const nextTools = new Set(state.seenToolObservationFingerprints);
  [...toolDelta.novel, ...toolDelta.repeated].forEach((value) => nextTools.add(value));
  const nextState: ProgressOracleState = {
    version: PROGRESS_ORACLE_STATE_VERSION,
    turnsObserved: state.turnsObserved + 1,
    consecutiveNoProgressTurns,
    seenTrustedFactFingerprints: [...nextFacts].sort(),
    seenWorkspaceFingerprints: [...nextWorkspaces].sort(),
    lastWorkspaceFingerprint: currentWorkspaceFingerprint ?? state.lastWorkspaceFingerprint,
    lastFailedCheckCount: failedCheckCount ?? state.lastFailedCheckCount,
    seenToolObservationFingerprints: [...nextTools].sort(),
  };

  return {
    state: nextState,
    decision: {
      turn: nextState.turnsObserved,
      progressed,
      stalled: consecutiveNoProgressTurns >= stallAfter,
      consecutiveNoProgressTurns,
      stallAfterConsecutiveNoProgressTurns: stallAfter,
      progressSignals,
      stallSignals: [...stallSignals].sort(),
      newTrustedFactFingerprints,
      workspaceObserved,
      workspaceChanged,
      workspaceAdvanced,
      workspaceRevisited,
      previousFailedCheckCount,
      failedCheckCount,
      failedCheckCountChange,
      novelToolObservationFingerprints: toolDelta.novel,
      repeatedToolObservationFingerprints: toolDelta.repeated,
      successfulWorkspaceWrites,
    },
  };
}

/** Stateful convenience wrapper around the pure reducer. */
export class ProgressOracle {
  private state: ProgressOracleState;
  private readonly stallAfterConsecutiveNoProgressTurns: number;

  constructor(options: ProgressOracleOptions = {}) {
    this.stallAfterConsecutiveNoProgressTurns = positiveSafeInteger(
      options.stallAfterConsecutiveNoProgressTurns ?? DEFAULT_PROGRESS_ORACLE_STALL_TURNS,
      'stallAfterConsecutiveNoProgressTurns',
    );
    this.state = normalizedState(options.initialState ?? createProgressOracleState());
  }

  observe(observation: ProgressOracleTurnObservation): ProgressOracleDecision {
    const evaluation = evaluateProgressOracleTurn(this.state, observation, {
      stallAfterConsecutiveNoProgressTurns: this.stallAfterConsecutiveNoProgressTurns,
    });
    this.state = evaluation.state;
    return evaluation.decision;
  }

  snapshot(): ProgressOracleState {
    return normalizedState(this.state);
  }
}
