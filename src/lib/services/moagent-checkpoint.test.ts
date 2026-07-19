import { describe, expect, it } from 'vitest';

import type { AgentCheckpointRecord, RuntimeJsonObject } from '@/lib/agent/runtime';

import {
  assertMoAgentCheckpointIntegrity,
  hashMoAgentCheckpointPublicState,
  MoAgentCheckpointIntegrityError,
  readMoAgentProgressOracleCheckpoint,
} from './moagent-checkpoint';

function record(
  publicState: RuntimeJsonObject,
  overrides: Partial<AgentCheckpointRecord> = {},
): AgentCheckpointRecord {
  return {
    id: 'checkpoint-1',
    runId: 'run-checkpoint-1',
    sequence: 7,
    turn: 2,
    boundary: 'model_turn_completed',
    recoveryMode: 'replan_required',
    publicState,
    opaqueState: null,
    opaqueCodec: null,
    stateHash: hashMoAgentCheckpointPublicState(publicState),
    stateVersion: 2,
    fencingToken: 1,
    createdAt: new Date('2026-07-19T00:00:00.000Z'),
    ...overrides,
  };
}

function progressState(): RuntimeJsonObject {
  return {
    recoveryMode: 'replan_required',
    stage: 'model_turn_completed',
    turn: 2,
    sourceSequence: 7,
    completedOperationIds: [],
    progressOracle: {
      version: 1,
      turnsObserved: 2,
      consecutiveNoProgressTurns: 1,
      seenTrustedFactFingerprints: ['a'.repeat(64)],
      seenWorkspaceFingerprints: ['b'.repeat(64)],
      lastWorkspaceFingerprint: 'b'.repeat(64),
      lastFailedCheckCount: null,
      seenToolObservationFingerprints: ['c'.repeat(64)],
    },
  };
}

describe('MoAgent durable checkpoint contract', () => {
  it('hashes public state canonically across object key order', () => {
    expect(hashMoAgentCheckpointPublicState({ b: 2, a: 1 })).toBe(
      hashMoAgentCheckpointPublicState({ a: 1, b: 2 }),
    );
  });

  it('validates and reads a bounded ProgressOracle snapshot', () => {
    const checkpoint = record(progressState());

    expect(() => assertMoAgentCheckpointIntegrity(checkpoint)).not.toThrow();
    expect(readMoAgentProgressOracleCheckpoint(checkpoint)).toEqual({
      version: 1,
      turnsObserved: 2,
      consecutiveNoProgressTurns: 1,
      seenTrustedFactFingerprints: ['a'.repeat(64)],
      seenWorkspaceFingerprints: ['b'.repeat(64)],
      lastWorkspaceFingerprint: 'b'.repeat(64),
      lastFailedCheckCount: null,
      seenToolObservationFingerprints: ['c'.repeat(64)],
    });
  });

  it('fails closed on a tampered state hash or malformed oracle state', () => {
    expect(() => assertMoAgentCheckpointIntegrity(record(progressState(), {
      stateHash: `sha256:${'0'.repeat(64)}`,
    }))).toThrow(MoAgentCheckpointIntegrityError);

    const malformed = progressState();
    malformed.progressOracle = { version: 999 };
    expect(() => readMoAgentProgressOracleCheckpoint(record(malformed))).toThrow(
      MoAgentCheckpointIntegrityError,
    );

    const unhashed = progressState();
    unhashed.progressOracle = {
      ...(unhashed.progressOracle as RuntimeJsonObject),
      seenTrustedFactFingerprints: ['raw-observation-must-not-be-durable'],
    };
    expect(() => readMoAgentProgressOracleCheckpoint(record(unhashed))).toThrow(
      'must contain only SHA-256 fingerprints',
    );
  });

  it('accepts legacy replan checkpoints without pretending they contain oracle state', () => {
    const legacy = record({ recoveryMode: 'replan_required', stage: 'tools_completed' }, {
      boundary: 'tools_completed',
      stateVersion: 1,
      stateHash: `sha256:${'f'.repeat(64)}`,
    });

    expect(() => assertMoAgentCheckpointIntegrity(legacy)).not.toThrow();
    expect(readMoAgentProgressOracleCheckpoint(legacy)).toBeNull();
  });
});
