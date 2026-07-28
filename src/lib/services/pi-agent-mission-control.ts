import type {
  PiAgentCandidateSource,
  PiAgentCandidateSubmission,
  PiAgentEvidenceDecision,
  PiAgentEvidenceReceiptHandle,
  PiAgentMissionHandle,
  PiAgentMissionNodeKey,
  PiAgentMissionNodeStatus,
} from '@/lib/agent/mission';
import {
  compilePiAgentMissionSpec,
  verifyPiAgentMissionEvidence,
} from '@/lib/agent/mission';
import { withPiAgentWorkspaceResourceLock } from '@/lib/agent/runtime/workspace-resource-lock';
import type { QuantRunPlan } from '@/lib/domains/finance/workspace';
import { createFinanceMissionDefinition } from '@/lib/domains/finance';
import { capturePiAgentCandidate } from '@/lib/services/pi-agent-candidate';
import { PiAgentMissionVerificationSession } from '@/lib/services/pi-agent-mission-verification-session';
import {
  ensurePiAgentMission,
  markPiAgentMissionNode,
  readPiAgentMission,
  readPiAgentMissionSpec,
  recordPiAgentMissionCandidate,
  recordPiAgentMissionEvidenceDecision,
} from '@/lib/services/pi-agent-mission-store';

export interface PiAgentMissionContext extends PiAgentMissionHandle {
  projectPath: string;
  verificationSession?: PiAgentMissionVerificationSession;
}

function missionRef(mission: PiAgentMissionContext) {
  return {
    missionId: mission.id,
    projectId: mission.projectId,
    requestId: mission.requestId,
  };
}

export async function createQuantPiAgentMission(input: {
  projectId: string;
  projectPath: string;
  requestId: string;
  objective: string;
  runPlan: QuantRunPlan;
  maxRepairAttempts: number;
}): Promise<PiAgentMissionContext> {
  const spec = compilePiAgentMissionSpec({
    projectId: input.projectId,
    requestId: input.requestId,
    objective: input.objective,
    capabilityId:
      input.runPlan.requestedCapabilityId ?? input.runPlan.capabilityId,
    runPlanId: input.runPlan.runId,
    composition: {
      profileId: input.runPlan.composition.profile.id,
      profileVersion: input.runPlan.composition.profile.version,
      domainPacks: input.runPlan.composition.domainPacks,
      deliveryPackId: input.runPlan.composition.deliveryPack.id,
      deliveryPackVersion: input.runPlan.composition.deliveryPack.version,
      compositionSha256: input.runPlan.composition.sha256,
    },
    entities: input.runPlan.symbols.map((symbol) => ({
      entityType: 'finance.security',
      canonicalId: symbol,
    })),
    maxRepairAttempts: input.maxRepairAttempts,
    definition: createFinanceMissionDefinition({
      maxRepairAttempts: input.maxRepairAttempts,
      expectedArtifacts: input.runPlan.expectedArtifacts,
    }),
    createdAt: input.runPlan.createdAt,
  });
  const mission = await ensurePiAgentMission({ spec });
  return { ...mission, projectPath: input.projectPath };
}

export async function refreshPiAgentMissionContext(
  mission: PiAgentMissionContext,
): Promise<PiAgentMissionContext> {
  const current = await readPiAgentMission(mission.projectId, mission.requestId);
  if (!current || current.id !== mission.id) {
    throw new Error('The durable Mission binding was lost.');
  }
  return { ...current, projectPath: mission.projectPath };
}

export async function loadPiAgentMissionContext(input: {
  projectId: string;
  projectPath: string;
  requestId: string;
  missionId?: string | null;
  generationId?: string | null;
}): Promise<PiAgentMissionContext> {
  const mission = await readPiAgentMission(input.projectId, input.requestId);
  if (!mission) throw new Error('The durable Mission does not exist.');
  if (input.missionId && mission.id !== input.missionId) {
    throw new Error('The durable Mission ID does not match the dispatch envelope.');
  }
  if (input.generationId && mission.generationId !== input.generationId) {
    throw new Error('The durable generation ID does not match the dispatch envelope.');
  }
  return { ...mission, projectPath: input.projectPath };
}

export async function markQuantPiAgentMissionNode(input: {
  mission: PiAgentMissionContext;
  nodeKey: PiAgentMissionNodeKey;
  status: PiAgentMissionNodeStatus;
}): Promise<PiAgentMissionContext> {
  await markPiAgentMissionNode({
    ...missionRef(input.mission),
    nodeKey: input.nodeKey,
    status: input.status,
  });
  return refreshPiAgentMissionContext(input.mission);
}

export async function capturePlatformMissionCandidate(input: {
  mission: PiAgentMissionContext;
  source: Exclude<PiAgentCandidateSource, 'pi_agent_submit_result'>;
  sourceRequestId?: string;
  summary: string;
  declaredArtifacts?: readonly string[];
}): Promise<PiAgentCandidateSubmission> {
  return capturePiAgentCandidate({
    workspaceRoot: input.mission.projectPath,
    source: input.source,
    sourceRequestId: input.sourceRequestId ?? input.mission.requestId,
    summary: input.summary,
    declaredArtifacts: input.declaredArtifacts,
    verifiedArtifacts: input.declaredArtifacts,
  });
}

export async function sealQuantPiAgentMissionCandidate(input: {
  mission: PiAgentMissionContext;
  candidate: PiAgentCandidateSubmission;
}): Promise<{
  mission: PiAgentMissionContext;
  receipt: PiAgentEvidenceReceiptHandle;
}> {
  const sealed = await recordPiAgentMissionCandidate({
    ...missionRef(input.mission),
    candidate: input.candidate,
  });
  return {
    mission: { ...sealed.mission, projectPath: input.mission.projectPath },
    receipt: sealed.receipt,
  };
}

/**
 * Exclusively claim the frozen candidate before validation starts. Keeping
 * this CAS separate from model execution prevents another web worker or a
 * manual validation request from validating the same mutable workspace in
 * parallel.
 */
export async function claimQuantPiAgentMissionVerification(
  mission: PiAgentMissionContext,
): Promise<PiAgentMissionContext> {
  const session = await PiAgentMissionVerificationSession.claim(missionRef(mission));
  return {
    ...session.mission,
    projectPath: mission.projectPath,
    verificationSession: session,
  };
}

/**
 * Verify persisted validation artifacts and the persistent preview while the
 * workspace's physical resource lock is held. The acceptance receipt and
 * Mission completion are committed before the lock is released.
 */
export async function verifyAndRecordQuantPiAgentMission(input: {
  mission: PiAgentMissionContext;
  preview: { url: string; port: number };
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}): Promise<{
  mission: PiAgentMissionContext;
  decision: PiAgentEvidenceDecision;
  receipt: PiAgentEvidenceReceiptHandle;
}> {
  const verificationSession = input.mission.verificationSession;
  if (!verificationSession) {
    throw new Error('Evidence verification requires a live Mission verification session.');
  }
  verificationSession.assertHealthy();
  const current = await readPiAgentMission(
    input.mission.projectId,
    input.mission.requestId,
  );
  if (
    !current ||
    current.id !== input.mission.id ||
    current.status !== 'verifying' ||
    current.candidateVersion !== input.mission.candidateVersion
  ) {
    throw new Error(
      'Evidence verification requires the current candidate to be exclusively claimed.',
    );
  }
  const mission = { ...current, projectPath: input.mission.projectPath };
  const spec = await readPiAgentMissionSpec(missionRef(mission));
  try {
    return await withPiAgentWorkspaceResourceLock(mission.projectPath, async () => {
      const decision = await verifyPiAgentMissionEvidence({
        missionId: mission.id,
        generationId: mission.generationId,
        candidateVersion: mission.candidateVersion,
        missionSpec: spec,
        missionSpecSha256: mission.specHash,
        workspaceRoot: mission.projectPath,
        preview: input.preview,
        ...(input.signal ? { signal: input.signal } : {}),
        ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
      });
      const recorded = await verificationSession.commit((verificationFence) =>
        recordPiAgentMissionEvidenceDecision({
          ...missionRef(mission),
          verificationFence,
          decision,
        }));
      return {
        mission: { ...recorded.mission, projectPath: mission.projectPath },
        decision,
        receipt: recorded.receipt,
      };
    }, {
      ownerId: `mission-evidence:${mission.id}:${mission.candidateVersion}`,
      metadata: {
        purpose: 'mission_evidence_verification',
        projectId: mission.projectId,
        requestId: mission.requestId,
        missionId: mission.id,
        generationId: mission.generationId,
      },
    });
  } finally {
    await verificationSession.dispose();
  }
}
