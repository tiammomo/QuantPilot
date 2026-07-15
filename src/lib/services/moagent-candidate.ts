import { createHash } from 'node:crypto';
import type {
  MoAgentCandidateSource,
  MoAgentCandidateSubmission,
} from '@/lib/agent/mission';
import type { MoAgentRunResult } from '@/lib/agent/types';
import { hashMoAgentWorkspace } from '@/lib/services/moagent-provenance';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sha256(value: string): string {
  return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;
}

function artifactPaths(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item): item is string =>
    typeof item === 'string' &&
    item.length > 0 &&
    item.length <= 1_024 &&
    !item.startsWith('/') &&
    !item.split('/').includes('..')))].sort();
}

export async function captureMoAgentCandidate(input: {
  workspaceRoot: string;
  source: MoAgentCandidateSource;
  sourceRunId?: string | null;
  sourceRequestId: string;
  summary?: string | null;
  declaredArtifacts?: readonly string[];
  verifiedArtifacts?: readonly string[];
  submittedAt?: string;
}): Promise<MoAgentCandidateSubmission> {
  const workspace = await hashMoAgentWorkspace(input.workspaceRoot);
  const declaredArtifacts = artifactPaths(input.declaredArtifacts ?? []);
  const verifiedArtifacts = artifactPaths(input.verifiedArtifacts ?? []);
  return {
    schemaVersion: 1,
    source: input.source,
    sourceRunId: input.sourceRunId ?? null,
    sourceRequestId: input.sourceRequestId,
    workspaceSha256: `sha256:${workspace.sha256}`,
    summarySha256: sha256(input.summary?.trim() || input.source),
    declaredArtifacts,
    verifiedArtifacts,
    submittedAt: input.submittedAt ?? new Date().toISOString(),
  };
}

/**
 * Rebind a runtime-produced candidate to the workspace after trusted platform
 * preparation. Provenance stays attached to the producing run while the
 * workspace digest and sealing timestamp describe the prepared candidate.
 */
export async function refreshMoAgentCandidateWorkspace(input: {
  workspaceRoot: string;
  candidate: MoAgentCandidateSubmission;
  submittedAt?: string;
}): Promise<MoAgentCandidateSubmission> {
  const workspace = await hashMoAgentWorkspace(input.workspaceRoot);
  return {
    ...input.candidate,
    workspaceSha256: `sha256:${workspace.sha256}`,
    submittedAt: input.submittedAt ?? new Date().toISOString(),
  };
}

export async function candidateFromMoAgentRun(input: {
  workspaceRoot: string;
  requestId?: string;
  result: MoAgentRunResult;
}): Promise<MoAgentCandidateSubmission> {
  const terminal = input.result.terminalResult;
  const data = terminal?.ok && isRecord(terminal.data) ? terminal.data : null;
  const summary = typeof data?.summary === 'string'
    ? data.summary
    : terminal?.content ?? 'MoAgent candidate submitted';
  return captureMoAgentCandidate({
    workspaceRoot: input.workspaceRoot,
    source: 'moagent_submit_result',
    sourceRunId: input.result.runId,
    sourceRequestId: input.requestId ?? input.result.runId,
    summary,
    declaredArtifacts: artifactPaths(data?.artifacts),
    verifiedArtifacts: artifactPaths(data?.verifiedArtifacts),
    submittedAt: new Date(input.result.finishedAt).toISOString(),
  });
}
