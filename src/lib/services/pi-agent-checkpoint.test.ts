import { describe, expect, it } from 'vitest';

import type { AgentCheckpointRecord, RuntimeJsonObject } from '@/lib/agent/runtime';

import {
  assertPiAgentCheckpointIntegrity,
  hashPiAgentCheckpointPublicState,
  PiAgentCheckpointIntegrityError,
  readPiAgentProgressOracleCheckpoint,
} from './pi-agent-checkpoint';

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
    stateHash: hashPiAgentCheckpointPublicState(publicState),
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

describe('PI Agent durable checkpoint contract', () => {
  it('hashes public state canonically across object key order', () => {
    expect(hashPiAgentCheckpointPublicState({ b: 2, a: 1 })).toBe(
      hashPiAgentCheckpointPublicState({ a: 1, b: 2 }),
    );
  });

  it('validates and reads a bounded ProgressOracle snapshot', () => {
    const checkpoint = record(progressState());

    expect(() => assertPiAgentCheckpointIntegrity(checkpoint)).not.toThrow();
    expect(readPiAgentProgressOracleCheckpoint(checkpoint)).toEqual({
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
    expect(() => assertPiAgentCheckpointIntegrity(record(progressState(), {
      stateHash: `sha256:${'0'.repeat(64)}`,
    }))).toThrow(PiAgentCheckpointIntegrityError);

    const malformed = progressState();
    malformed.progressOracle = { version: 999 };
    expect(() => readPiAgentProgressOracleCheckpoint(record(malformed))).toThrow(
      PiAgentCheckpointIntegrityError,
    );

    const unhashed = progressState();
    unhashed.progressOracle = {
      ...(unhashed.progressOracle as RuntimeJsonObject),
      seenTrustedFactFingerprints: ['raw-observation-must-not-be-durable'],
    };
    expect(() => readPiAgentProgressOracleCheckpoint(record(unhashed))).toThrow(
      'must contain only SHA-256 fingerprints',
    );
  });

  it('accepts legacy replan checkpoints without pretending they contain oracle state', () => {
    const legacy = record({ recoveryMode: 'replan_required', stage: 'tools_completed' }, {
      boundary: 'tools_completed',
      stateVersion: 1,
      stateHash: `sha256:${'f'.repeat(64)}`,
    });

    expect(() => assertPiAgentCheckpointIntegrity(legacy)).not.toThrow();
    expect(readPiAgentProgressOracleCheckpoint(legacy)).toBeNull();
  });
});
