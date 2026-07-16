import { describe, expect, it } from 'vitest';

import {
  createProgressOracleState,
  DEFAULT_PROGRESS_ORACLE_STALL_TURNS,
  evaluateProgressOracleTurn,
  ProgressOracle,
  type ProgressOracleState,
  type ProgressOracleTurnObservation,
} from './progress-oracle';

describe('ProgressOracle', () => {
  it('stalls after two consecutive turns without verifiable progress by default', () => {
    const oracle = new ProgressOracle();

    const first = oracle.observe({});
    const second = oracle.observe({});

    expect(DEFAULT_PROGRESS_ORACLE_STALL_TURNS).toBe(2);
    expect(first).toMatchObject({
      progressed: false,
      stalled: false,
      consecutiveNoProgressTurns: 1,
      stallSignals: ['no_verifiable_progress'],
    });
    expect(second).toMatchObject({
      progressed: false,
      stalled: true,
      consecutiveNoProgressTurns: 2,
      stallSignals: ['no_verifiable_progress'],
    });
  });

  it('counts only globally new trusted facts as progress', () => {
    const oracle = new ProgressOracle();

    const first = oracle.observe({ trustedFactFingerprints: ['fact:b', 'fact:a', 'fact:a'] });
    const repeated = oracle.observe({ trustedFactFingerprints: ['fact:a'] });
    const next = oracle.observe({ trustedFactFingerprints: ['fact:c', 'fact:a'] });

    expect(first).toMatchObject({
      progressed: true,
      newTrustedFactFingerprints: ['fact:a', 'fact:b'],
      progressSignals: ['trusted_fact_added'],
    });
    expect(repeated).toMatchObject({
      progressed: false,
      stalled: false,
      newTrustedFactFingerprints: [],
      consecutiveNoProgressTurns: 1,
    });
    expect(next).toMatchObject({
      progressed: true,
      stalled: false,
      consecutiveNoProgressTurns: 0,
      newTrustedFactFingerprints: ['fact:c'],
    });
  });

  it('uses the first workspace fingerprint as a baseline and rejects oscillation as progress', () => {
    const oracle = new ProgressOracle();

    const baseline = oracle.observe({ workspaceFingerprint: 'workspace:a' });
    const advanced = oracle.observe({ workspaceFingerprint: 'workspace:b' });
    const revisited = oracle.observe({ workspaceFingerprint: 'workspace:a' });
    const unchanged = oracle.observe({ workspaceFingerprint: 'workspace:a' });

    expect(baseline).toMatchObject({
      progressed: false,
      workspaceObserved: true,
      workspaceChanged: false,
      workspaceAdvanced: false,
    });
    expect(advanced).toMatchObject({
      progressed: true,
      workspaceChanged: true,
      workspaceAdvanced: true,
      workspaceRevisited: false,
      progressSignals: ['workspace_advanced'],
    });
    expect(revisited).toMatchObject({
      progressed: false,
      stalled: false,
      workspaceChanged: true,
      workspaceAdvanced: false,
      workspaceRevisited: true,
      stallSignals: ['no_verifiable_progress', 'workspace_revisited'],
    });
    expect(unchanged).toMatchObject({
      progressed: false,
      stalled: true,
      workspaceChanged: false,
      workspaceAdvanced: false,
      consecutiveNoProgressTurns: 2,
    });
  });

  it('treats fewer failed checks as progress and an increase as regression', () => {
    const oracle = new ProgressOracle();

    const baseline = oracle.observe({ failedCheckCount: 3 });
    const reduced = oracle.observe({ failedCheckCount: 1 });
    const unchanged = oracle.observe({ failedCheckCount: 1 });
    const increased = oracle.observe({
      failedCheckCount: 2,
      workspaceFingerprint: 'workspace:new-but-worse',
    });

    expect(baseline.failedCheckCountChange).toBeNull();
    expect(reduced).toMatchObject({
      progressed: true,
      failedCheckCountChange: -2,
      progressSignals: ['failed_checks_reduced'],
    });
    expect(unchanged).toMatchObject({
      progressed: false,
      failedCheckCountChange: 0,
      consecutiveNoProgressTurns: 1,
    });
    expect(increased).toMatchObject({
      progressed: false,
      stalled: true,
      failedCheckCountChange: 1,
      workspaceAdvanced: false,
      stallSignals: ['failed_checks_increased', 'no_verifiable_progress'],
    });
  });

  it('preserves trusted knowledge progress even when artifact checks regress', () => {
    const oracle = new ProgressOracle();
    oracle.observe({ failedCheckCount: 1, workspaceFingerprint: 'workspace:a' });

    const decision = oracle.observe({
      trustedFactFingerprints: ['fact:new-diagnosis'],
      failedCheckCount: 2,
      workspaceFingerprint: 'workspace:b',
    });

    expect(decision).toMatchObject({
      progressed: true,
      progressSignals: ['trusted_fact_added'],
      workspaceChanged: true,
      workspaceAdvanced: true,
      failedCheckCountChange: 1,
      stallSignals: ['failed_checks_increased'],
    });
  });

  it('never treats tool activity as progress and reports repeated observations deterministically', () => {
    const oracle = new ProgressOracle();

    const novel = oracle.observe({
      toolObservationFingerprints: ['tool:z', 'tool:a'],
    });
    const repeated = oracle.observe({
      toolObservationFingerprints: ['tool:z', 'tool:a', 'tool:a'],
    });

    expect(novel).toMatchObject({
      progressed: false,
      stalled: false,
      novelToolObservationFingerprints: ['tool:a', 'tool:z'],
      repeatedToolObservationFingerprints: [],
    });
    expect(repeated).toMatchObject({
      progressed: false,
      stalled: true,
      novelToolObservationFingerprints: [],
      repeatedToolObservationFingerprints: ['tool:a', 'tool:z'],
      stallSignals: ['no_verifiable_progress', 'repeated_tool_observation'],
    });
  });

  it('does not treat a successful write counter as progress or completion evidence', () => {
    const oracle = new ProgressOracle();

    const first = oracle.observe({ successfulWorkspaceWrites: 1 });
    const second = oracle.observe({ successfulWorkspaceWrites: 2 });

    expect(first).toMatchObject({
      progressed: false,
      stalled: false,
      successfulWorkspaceWrites: 1,
      stallSignals: [
        'no_verifiable_progress',
        'successful_write_without_verifiable_progress',
      ],
    });
    expect(second).toMatchObject({
      progressed: false,
      stalled: true,
      successfulWorkspaceWrites: 2,
    });
    expect(second).not.toHaveProperty('completed');
  });

  it('attributes progress to a verified workspace change rather than write success', () => {
    const oracle = new ProgressOracle();
    oracle.observe({ workspaceFingerprint: 'workspace:a' });

    const decision = oracle.observe({
      workspaceFingerprint: 'workspace:b',
      successfulWorkspaceWrites: 1,
    });

    expect(decision).toMatchObject({
      progressed: true,
      stalled: false,
      progressSignals: ['workspace_advanced'],
      successfulWorkspaceWrites: 1,
    });
    expect(decision.stallSignals).not.toContain('successful_write_without_verifiable_progress');
  });

  it('resets the no-progress streak after any verifiable progress', () => {
    const oracle = new ProgressOracle();
    expect(oracle.observe({}).consecutiveNoProgressTurns).toBe(1);

    const progressed = oracle.observe({ trustedFactFingerprints: ['fact:one'] });
    const nextIdle = oracle.observe({ trustedFactFingerprints: ['fact:one'] });

    expect(progressed).toMatchObject({
      progressed: true,
      stalled: false,
      consecutiveNoProgressTurns: 0,
    });
    expect(nextIdle).toMatchObject({
      progressed: false,
      stalled: false,
      consecutiveNoProgressTurns: 1,
    });
  });

  it('supports a custom consecutive no-progress threshold', () => {
    const oracle = new ProgressOracle({ stallAfterConsecutiveNoProgressTurns: 3 });

    expect(oracle.observe({}).stalled).toBe(false);
    expect(oracle.observe({}).stalled).toBe(false);
    expect(oracle.observe({})).toMatchObject({
      stalled: true,
      consecutiveNoProgressTurns: 3,
      stallAfterConsecutiveNoProgressTurns: 3,
    });
  });

  it('can resume from a serializable snapshot without changing decisions', () => {
    const original = new ProgressOracle();
    original.observe({
      trustedFactFingerprints: ['fact:one'],
      workspaceFingerprint: 'workspace:a',
      failedCheckCount: 2,
      toolObservationFingerprints: ['tool:one'],
    });
    const snapshot = JSON.parse(JSON.stringify(original.snapshot())) as ProgressOracleState;
    const resumed = new ProgressOracle({ initialState: snapshot });
    const observation: ProgressOracleTurnObservation = {
      trustedFactFingerprints: ['fact:one'],
      workspaceFingerprint: 'workspace:a',
      failedCheckCount: 2,
      toolObservationFingerprints: ['tool:one'],
    };

    expect(resumed.observe(observation)).toEqual(original.observe(observation));
    expect(resumed.snapshot()).toEqual(original.snapshot());
  });

  it('produces identical state and decisions regardless of fingerprint input order', () => {
    const left = evaluateProgressOracleTurn(createProgressOracleState(), {
      trustedFactFingerprints: ['fact:b', 'fact:a'],
      toolObservationFingerprints: ['tool:b', 'tool:a', 'tool:a'],
      workspaceFingerprint: 'workspace:a',
      failedCheckCount: 2,
    });
    const right = evaluateProgressOracleTurn(createProgressOracleState(), {
      trustedFactFingerprints: ['fact:a', 'fact:b'],
      toolObservationFingerprints: ['tool:a', 'tool:b', 'tool:a'],
      workspaceFingerprint: 'workspace:a',
      failedCheckCount: 2,
    });

    expect(right).toEqual(left);
  });

  it('rejects invalid thresholds, counters, fingerprints, and state versions', () => {
    expect(() => new ProgressOracle({ stallAfterConsecutiveNoProgressTurns: 0 })).toThrow(
      'stallAfterConsecutiveNoProgressTurns must be a positive safe integer.',
    );
    expect(() => new ProgressOracle().observe({ failedCheckCount: -1 })).toThrow(
      'failedCheckCount must be a non-negative safe integer.',
    );
    expect(() => new ProgressOracle().observe({ successfulWorkspaceWrites: 1.5 })).toThrow(
      'successfulWorkspaceWrites must be a non-negative safe integer.',
    );
    expect(() => new ProgressOracle().observe({ trustedFactFingerprints: [' '] })).toThrow(
      'trustedFactFingerprints must contain a non-empty fingerprint.',
    );
    expect(() => new ProgressOracle({
      initialState: {
        ...createProgressOracleState(),
        version: 2,
      } as unknown as ProgressOracleState,
    })).toThrow('Unsupported ProgressOracle state version: 2.');
  });
});
