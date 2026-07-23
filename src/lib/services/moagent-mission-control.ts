import type {
  MoAgentCandidateSource,
  MoAgentCandidateSubmission,
  MoAgentEvidenceDecision,
  MoAgentEvidenceReceiptHandle,
  MoAgentMissionHandle,
  MoAgentMissionNodeKey,
  MoAgentMissionNodeStatus,
} from '@/lib/agent/mission';
import {
  compileMoAgentMissionSpec,
  verifyMoAgentMissionEvidence,
} from '@/lib/agent/mission';
import { withMoAgentWorkspaceResourceLock } from '@/lib/agent/runtime/workspace-resource-lock';
import type { QuantRunPlan } from '@/lib/domains/finance/workspace';
import {
  createFinanceMissionDefinition,
  QUANTPILOT_AGENT_PROFILE,
} from '@/lib/domains/finance';
import { captureMoAgentCandidate } from '@/lib/services/moagent-candidate';
import { MoAgentMissionVerificationSession } from '@/lib/services/moagent-mission-verification-session';
import {
  ensureMoAgentMission,
  markMoAgentMissionNode,
  readMoAgentMission,
  readMoAgentMissionSpec,
  recordMoAgentMissionCandidate,
  recordMoAgentMissionEvidenceDecision,
} from '@/lib/services/moagent-mission-store';

export interface MoAgentMissionContext extends MoAgentMissionHandle {
  projectPath: string;
  verificationSession?: MoAgentMissionVerificationSession;
}

function missionRef(mission: MoAgentMissionContext) {
  return {
    missionId: mission.id,
    projectId: mission.projectId,
    requestId: mission.requestId,
  };
}

export async function createQuantMoAgentMission(input: {
  projectId: string;
  projectPath: string;
  requestId: string;
  objective: string;
  runPlan: QuantRunPlan;
  maxRepairAttempts: number;
}): Promise<MoAgentMissionContext> {
  const spec = compileMoAgentMissionSpec({
    projectId: input.projectId,
    requestId: input.requestId,
    objective: input.objective,
    capabilityId:
      input.runPlan.requestedCapabilityId ?? input.runPlan.capabilityId,
    runPlanId: input.runPlan.runId,
    composition: {
      profileId: QUANTPILOT_AGENT_PROFILE.id,
      profileVersion: QUANTPILOT_AGENT_PROFILE.version,
      domainPackIds: [...QUANTPILOT_AGENT_PROFILE.domainPackIds],
      deliveryPackId: QUANTPILOT_AGENT_PROFILE.deliveryPackId,
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
  const mission = await ensureMoAgentMission({ spec });
  return { ...mission, projectPath: input.projectPath };
}

export async function refreshMoAgentMissionContext(
  mission: MoAgentMissionContext,
): Promise<MoAgentMissionContext> {
  const current = await readMoAgentMission(mission.projectId, mission.requestId);
  if (!current || current.id !== mission.id) {
    throw new Error('The durable Mission binding was lost.');
  }
  return { ...current, projectPath: mission.projectPath };
}

export async function loadMoAgentMissionContext(input: {
  projectId: string;
  projectPath: string;
  requestId: string;
  missionId?: string | null;
  generationId?: string | null;
}): Promise<MoAgentMissionContext> {
  const mission = await readMoAgentMission(input.projectId, input.requestId);
  if (!mission) throw new Error('The durable Mission does not exist.');
  if (input.missionId && mission.id !== input.missionId) {
    throw new Error('The durable Mission ID does not match the dispatch envelope.');
  }
  if (input.generationId && mission.generationId !== input.generationId) {
    throw new Error('The durable generation ID does not match the dispatch envelope.');
  }
  return { ...mission, projectPath: input.projectPath };
}

export async function markQuantMoAgentMissionNode(input: {
  mission: MoAgentMissionContext;
  nodeKey: MoAgentMissionNodeKey;
  status: MoAgentMissionNodeStatus;
}): Promise<MoAgentMissionContext> {
  await markMoAgentMissionNode({
    ...missionRef(input.mission),
    nodeKey: input.nodeKey,
    status: input.status,
  });
  return refreshMoAgentMissionContext(input.mission);
}

export async function capturePlatformMissionCandidate(input: {
  mission: MoAgentMissionContext;
  source: Exclude<MoAgentCandidateSource, 'moagent_submit_result'>;
  sourceRequestId?: string;
  summary: string;
  declaredArtifacts?: readonly string[];
}): Promise<MoAgentCandidateSubmission> {
  return captureMoAgentCandidate({
    workspaceRoot: input.mission.projectPath,
    source: input.source,
    sourceRequestId: input.sourceRequestId ?? input.mission.requestId,
    summary: input.summary,
    declaredArtifacts: input.declaredArtifacts,
    verifiedArtifacts: input.declaredArtifacts,
  });
}

export async function sealQuantMoAgentMissionCandidate(input: {
  mission: MoAgentMissionContext;
  candidate: MoAgentCandidateSubmission;
}): Promise<{
  mission: MoAgentMissionContext;
  receipt: MoAgentEvidenceReceiptHandle;
}> {
  const sealed = await recordMoAgentMissionCandidate({
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
export async function claimQuantMoAgentMissionVerification(
  mission: MoAgentMissionContext,
): Promise<MoAgentMissionContext> {
  const session = await MoAgentMissionVerificationSession.claim(missionRef(mission));
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
export async function verifyAndRecordQuantMoAgentMission(input: {
  mission: MoAgentMissionContext;
  preview: { url: string; port: number };
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}): Promise<{
  mission: MoAgentMissionContext;
  decision: MoAgentEvidenceDecision;
  receipt: MoAgentEvidenceReceiptHandle;
}> {
  const verificationSession = input.mission.verificationSession;
  if (!verificationSession) {
    throw new Error('Evidence verification requires a live Mission verification session.');
  }
  verificationSession.assertHealthy();
  const current = await readMoAgentMission(
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
  const spec = await readMoAgentMissionSpec(missionRef(mission));
  try {
    return await withMoAgentWorkspaceResourceLock(mission.projectPath, async () => {
      const decision = await verifyMoAgentMissionEvidence({
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
        recordMoAgentMissionEvidenceDecision({
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
