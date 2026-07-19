import { ProgressOracle, type ProgressOracleState } from '@/lib/agent/core/progress-oracle';
import type {
  AgentCheckpointRecord,
  RuntimeJsonObject,
} from '@/lib/agent/runtime';

import { hashMoAgentProvenance } from './moagent-provenance';

export const MOAGENT_CHECKPOINT_STATE_VERSION = 2 as const;
const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/;

export class MoAgentCheckpointIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MoAgentCheckpointIntegrityError';
  }
}

function isObject(value: unknown): value is RuntimeJsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assertHashFingerprints(values: readonly string[], label: string): void {
  if (!values.every((value) => SHA256_HEX_PATTERN.test(value))) {
    throw new MoAgentCheckpointIntegrityError(
      `MoAgent ProgressOracle ${label} must contain only SHA-256 fingerprints.`,
    );
  }
}

export function hashMoAgentCheckpointPublicState(
  publicState: RuntimeJsonObject,
): string {
  return `sha256:${hashMoAgentProvenance(publicState)}`;
}

/**
 * Version 2 checkpoints use canonical JSON hashing so PostgreSQL jsonb key
 * ordering cannot invalidate an otherwise identical recovery record.
 */
export function assertMoAgentCheckpointIntegrity(
  checkpoint: AgentCheckpointRecord,
): void {
  if (checkpoint.stateVersion < MOAGENT_CHECKPOINT_STATE_VERSION) return;
  if (checkpoint.stateVersion !== MOAGENT_CHECKPOINT_STATE_VERSION) {
    throw new MoAgentCheckpointIntegrityError(
      `Unsupported MoAgent checkpoint state version ${checkpoint.stateVersion}.`,
    );
  }
  const expected = hashMoAgentCheckpointPublicState(checkpoint.publicState);
  if (checkpoint.stateHash !== expected) {
    throw new MoAgentCheckpointIntegrityError(
      `MoAgent checkpoint ${checkpoint.runId}:${checkpoint.sequence} failed its state hash check.`,
    );
  }
}

/**
 * Returns a validated ProgressOracle snapshot for diagnostics. Recovery remains
 * replan-only: callers must not inject this state into a new provider attempt,
 * because its compacted tool observations are not a replacement for history.
 */
export function readMoAgentProgressOracleCheckpoint(
  checkpoint: AgentCheckpointRecord,
): ProgressOracleState | null {
  assertMoAgentCheckpointIntegrity(checkpoint);
  if (checkpoint.stateVersion < MOAGENT_CHECKPOINT_STATE_VERSION) return null;
  if (
    checkpoint.boundary !== 'model_turn_completed' ||
    checkpoint.publicState.stage !== 'model_turn_completed'
  ) {
    return null;
  }
  const candidate = checkpoint.publicState.progressOracle;
  if (!isObject(candidate)) {
    throw new MoAgentCheckpointIntegrityError(
      'MoAgent model-turn checkpoint is missing its ProgressOracle state.',
    );
  }
  try {
    const snapshot = new ProgressOracle({
      initialState: candidate as unknown as ProgressOracleState,
    }).snapshot();
    assertHashFingerprints(
      snapshot.seenTrustedFactFingerprints,
      'trusted fact state',
    );
    assertHashFingerprints(
      snapshot.seenWorkspaceFingerprints,
      'workspace state',
    );
    assertHashFingerprints(
      snapshot.seenToolObservationFingerprints,
      'tool observation state',
    );
    if (
      snapshot.lastWorkspaceFingerprint !== null &&
      !SHA256_HEX_PATTERN.test(snapshot.lastWorkspaceFingerprint)
    ) {
      throw new MoAgentCheckpointIntegrityError(
        'MoAgent ProgressOracle last workspace fingerprint must be SHA-256.',
      );
    }
    return snapshot;
  } catch (error) {
    if (error instanceof MoAgentCheckpointIntegrityError) throw error;
    throw new MoAgentCheckpointIntegrityError(
      `MoAgent ProgressOracle checkpoint is invalid: ${
        error instanceof Error ? error.message : 'unknown validation error'
      }`,
    );
  }
}
