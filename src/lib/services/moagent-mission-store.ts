import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db/client';
import type {
  MoAgentCandidateSubmission,
  MoAgentEvidenceDecision,
  MoAgentEvidenceReceiptHandle,
  MoAgentMissionHandle,
  MoAgentMissionNodeKey,
  MoAgentMissionNodeStatus,
  MoAgentMissionSpec,
  MoAgentMissionStatus,
  MoAgentAcceptedMissionSnapshot,
} from '@/lib/agent/mission';
import { MOAGENT_MISSION_STATUSES } from '@/lib/agent/mission';
import { hashMoAgentProvenance } from '@/lib/services/moagent-provenance';

const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;
const TERMINAL_MISSION_STATUSES = new Set<MoAgentMissionStatus>([
  'completed',
  'failed',
  'cancelled',
]);

type MissionTransaction = Prisma.TransactionClient;

export class MoAgentMissionStateError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'MoAgentMissionStateError';
  }
}

function inputJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function isActiveMissionUniqueConflict(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') {
    return false;
  }
  const target = JSON.stringify(error.meta?.target ?? '').toLowerCase();
  return target.includes('active_slot') ||
    target.includes('agent_missions_project_id_active_slot_key');
}

function evidenceReplayHash(payload: MoAgentEvidenceDecision['payload']): string {
  const projection = JSON.parse(JSON.stringify(payload)) as Record<string, unknown>;
  delete projection.createdAt;
  const preview = projection.preview;
  if (preview && typeof preview === 'object' && !Array.isArray(preview)) {
    delete (preview as Record<string, unknown>).readyAt;
  }
  return hashMoAgentProvenance(projection);
}

function missionStatus(value: string): MoAgentMissionStatus {
  if ((MOAGENT_MISSION_STATUSES as readonly string[]).includes(value)) {
    return value as MoAgentMissionStatus;
  }
  throw new MoAgentMissionStateError(
    'MISSION_STATUS_INVALID',
    `Mission has unsupported durable status: ${value}`,
  );
}

function handle(row: {
  id: string;
  generationId: string;
  projectId: string;
  requestId: string;
  status: string;
  version: number;
  candidateVersion: number;
  specHash: string;
  acceptedReceiptId: string | null;
}): MoAgentMissionHandle {
  return {
    id: row.id,
    generationId: row.generationId,
    projectId: row.projectId,
    requestId: row.requestId,
    status: missionStatus(row.status),
    version: row.version,
    candidateVersion: row.candidateVersion,
    specHash: row.specHash,
    acceptedReceiptId: row.acceptedReceiptId,
  };
}

function receiptHandle(input: {
  receipt: {
    id: string;
    missionId: string;
    candidateVersion: number;
    receiptType: string;
    verdict: string;
    subjectHash: string;
    receiptHash: string;
    createdAt: Date;
  };
  generationId: string;
}): MoAgentEvidenceReceiptHandle {
  if (!['candidate', 'validation', 'acceptance'].includes(input.receipt.receiptType)) {
    throw new MoAgentMissionStateError(
      'RECEIPT_TYPE_INVALID',
      `Unsupported evidence receipt type: ${input.receipt.receiptType}`,
    );
  }
  return {
    id: input.receipt.id,
    missionId: input.receipt.missionId,
    generationId: input.generationId,
    candidateVersion: input.receipt.candidateVersion,
    receiptType: input.receipt.receiptType as MoAgentEvidenceReceiptHandle['receiptType'],
    verdict: input.receipt.verdict as MoAgentEvidenceReceiptHandle['verdict'],
    subjectHash: input.receipt.subjectHash,
    receiptHash: input.receipt.receiptHash,
    createdAt: input.receipt.createdAt.toISOString(),
  };
}

async function boundMission(
  tx: MissionTransaction,
  ref: { missionId: string; projectId: string; requestId: string },
) {
  const mission = await tx.agentMission.findFirst({
    where: {
      id: ref.missionId,
      projectId: ref.projectId,
      requestId: ref.requestId,
    },
  });
  if (!mission) {
    throw new MoAgentMissionStateError(
      'MISSION_NOT_FOUND',
      'Mission does not exist or is bound to a different project/request.',
    );
  }
  missionStatus(mission.status);
  return mission;
}

async function setNodeStatus(
  tx: MissionTransaction,
  input: {
    missionId: string;
    nodeKey: MoAgentMissionNodeKey;
    status: MoAgentMissionNodeStatus;
    now: Date;
  },
): Promise<void> {
  const terminal = ['candidate_complete', 'passed', 'failed', 'skipped'].includes(input.status);
  const result = await tx.agentMissionNode.updateMany({
    where: { missionId: input.missionId, nodeKey: input.nodeKey },
    data: {
      status: input.status,
      version: { increment: 1 },
      ...(input.status === 'running' ? { startedAt: input.now, finishedAt: null } : {}),
      ...(terminal ? { finishedAt: input.now } : {}),
    },
  });
  if (result.count !== 1) {
    throw new MoAgentMissionStateError(
      'MISSION_NODE_NOT_FOUND',
      `Mission node does not exist: ${input.nodeKey}`,
    );
  }
}

export async function ensureMoAgentMission(input: {
  spec: MoAgentMissionSpec;
  missionId?: string;
  generationId?: string;
}): Promise<MoAgentMissionHandle> {
  const specHash = `sha256:${hashMoAgentProvenance(input.spec)}`;
  const create = async () => prisma.$transaction(async (tx) => {
    const existing = await tx.agentMission.findUnique({
      where: { requestId_projectId: {
        requestId: input.spec.requestId,
        projectId: input.spec.projectId,
      } },
    });
    if (existing) {
      if (existing.specHash !== specHash) {
        throw new MoAgentMissionStateError(
          'MISSION_SPEC_CONFLICT',
          'The request already owns a Mission with a different immutable spec.',
        );
      }
      return handle(existing);
    }
    const created = await tx.agentMission.create({
      data: {
        id: input.missionId ?? `mission_${randomUUID()}`,
        ...(input.generationId ? { generationId: input.generationId } : {}),
        projectId: input.spec.projectId,
        requestId: input.spec.requestId,
        status: 'running',
        spec: inputJson(input.spec),
        specHash,
        nodes: {
          create: input.spec.nodes.map((node) => ({
            nodeKey: node.key,
            nodeType: node.type,
            effect: node.effect,
            status: node.dependencies.length === 0 ? 'running' : 'pending',
            dependencies: inputJson(node.dependencies),
            allowedTools: inputJson(node.allowedTools),
            requiredSkillSections: inputJson(node.requiredSkillSections),
            inputArtifacts: inputJson(node.inputArtifacts),
            outputArtifacts: inputJson(node.outputArtifacts),
            budget: inputJson(node.budget),
            acceptancePredicates: inputJson(node.acceptancePredicates),
            ...(node.dependencies.length === 0 ? { startedAt: new Date(input.spec.createdAt) } : {}),
          })),
        },
      },
    });
    return handle(created);
  });

  try {
    return await create();
  } catch (error) {
    if (isActiveMissionUniqueConflict(error)) {
      throw new MoAgentMissionStateError(
        'MISSION_PROJECT_BUSY',
        'The project already has a non-terminal Mission.',
      );
    }
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      try {
        return await create();
      } catch (retryError) {
        if (isActiveMissionUniqueConflict(retryError)) {
          throw new MoAgentMissionStateError(
            'MISSION_PROJECT_BUSY',
            'The project already has a non-terminal Mission.',
          );
        }
        throw retryError;
      }
    }
    throw error;
  }
}

export async function readMoAgentMission(
  projectId: string,
  requestId: string,
): Promise<MoAgentMissionHandle | null> {
  const mission = await prisma.agentMission.findFirst({ where: { projectId, requestId } });
  return mission ? handle(mission) : null;
}

export async function readMoAgentMissionSpec(
  ref: { missionId: string; projectId: string; requestId: string },
): Promise<MoAgentMissionSpec> {
  const mission = await prisma.agentMission.findFirst({ where: {
    id: ref.missionId,
    projectId: ref.projectId,
    requestId: ref.requestId,
  } });
  if (!mission) throw new MoAgentMissionStateError('MISSION_NOT_FOUND', 'Mission not found.');
  return mission.spec as unknown as MoAgentMissionSpec;
}

export async function markMoAgentMissionNode(input: {
  missionId: string;
  projectId: string;
  requestId: string;
  nodeKey: MoAgentMissionNodeKey;
  status: MoAgentMissionNodeStatus;
}): Promise<MoAgentMissionHandle> {
  return prisma.$transaction(async (tx) => {
    const mission = await boundMission(tx, input);
    if (TERMINAL_MISSION_STATUSES.has(missionStatus(mission.status))) {
      throw new MoAgentMissionStateError(
        'MISSION_ALREADY_TERMINAL',
        'A terminal Mission node cannot be changed.',
      );
    }
    await setNodeStatus(tx, { ...input, now: new Date() });
    return handle(mission);
  });
}

function validateCandidate(candidate: MoAgentCandidateSubmission): void {
  if (!SHA256_PATTERN.test(candidate.workspaceSha256) ||
    !SHA256_PATTERN.test(candidate.summarySha256)) {
    throw new MoAgentMissionStateError(
      'CANDIDATE_HASH_INVALID',
      'Candidate hashes must be SHA-256 values.',
    );
  }
  for (const artifact of [...candidate.declaredArtifacts, ...candidate.verifiedArtifacts]) {
    if (!artifact || artifact.startsWith('/') || artifact.split('/').includes('..')) {
      throw new MoAgentMissionStateError(
        'CANDIDATE_ARTIFACT_INVALID',
        'Candidate artifact paths must remain workspace-relative.',
      );
    }
  }
}

export async function recordMoAgentMissionCandidate(input: {
  missionId: string;
  projectId: string;
  requestId: string;
  candidate: MoAgentCandidateSubmission;
}): Promise<{ mission: MoAgentMissionHandle; receipt: MoAgentEvidenceReceiptHandle }> {
  validateCandidate(input.candidate);
  return prisma.$transaction(async (tx) => {
    const mission = await boundMission(tx, input);
    const status = missionStatus(mission.status);
    if (!['running', 'repairing', 'candidate_complete'].includes(status)) {
      throw new MoAgentMissionStateError(
        'MISSION_CANDIDATE_TRANSITION_INVALID',
        `Cannot submit a candidate while Mission is ${status}.`,
      );
    }
    const sourceRequestAllowed =
      input.candidate.sourceRequestId === mission.requestId ||
      input.candidate.sourceRequestId.startsWith(`${mission.requestId}-validation-repair`);
    if (!sourceRequestAllowed) {
      throw new MoAgentMissionStateError(
        'MISSION_CANDIDATE_REQUEST_MISMATCH',
        'Candidate source request is not part of this Mission.',
      );
    }

    if (status === 'candidate_complete') {
      const existing = await tx.agentEvidenceReceipt.findFirst({
        where: {
          missionId: mission.id,
          candidateVersion: mission.candidateVersion,
          receiptType: 'candidate',
          subjectHash: input.candidate.workspaceSha256,
        },
      });
      if (existing) {
        return {
          mission: handle(mission),
          receipt: receiptHandle({ receipt: existing, generationId: mission.generationId }),
        };
      }
    }

    const candidateVersion = mission.candidateVersion + 1;
    const receiptPayload = {
      ...input.candidate,
      missionId: mission.id,
      generationId: mission.generationId,
      candidateVersion,
    };
    const receiptHash = `sha256:${hashMoAgentProvenance(receiptPayload)}`;
    const receipt = await tx.agentEvidenceReceipt.create({
      data: {
        id: `receipt_${randomUUID()}`,
        missionId: mission.id,
        candidateVersion,
        receiptType: 'candidate',
        verdict: 'candidate_complete',
        subjectHash: input.candidate.workspaceSha256,
        receiptHash,
        sourceRunId: input.candidate.sourceRunId,
        sourceRequestId: input.candidate.sourceRequestId,
        payload: inputJson(receiptPayload),
        createdAt: new Date(input.candidate.submittedAt),
      },
    });
    const updated = await tx.agentMission.updateMany({
      where: { id: mission.id, version: mission.version, status: mission.status },
      data: {
        status: 'candidate_complete',
        version: { increment: 1 },
        candidateVersion,
        currentCandidateRunId: input.candidate.sourceRunId,
        currentCandidateRequestId: input.candidate.sourceRequestId,
        candidateSubmittedAt: new Date(input.candidate.submittedAt),
        verificationStartedAt: null,
        errorCode: null,
        errorMessage: null,
      },
    });
    if (updated.count !== 1) {
      throw new MoAgentMissionStateError(
        'MISSION_WRITE_CONFLICT',
        'Mission changed concurrently while sealing the candidate.',
      );
    }
    await setNodeStatus(tx, {
      missionId: mission.id,
      nodeKey: 'workspace_generation',
      status: 'candidate_complete',
      now: new Date(input.candidate.submittedAt),
    });
    const nextMission = await tx.agentMission.findUniqueOrThrow({ where: { id: mission.id } });
    return {
      mission: handle(nextMission),
      receipt: receiptHandle({ receipt, generationId: mission.generationId }),
    };
  });
}

export async function beginMoAgentMissionVerification(input: {
  missionId: string;
  projectId: string;
  requestId: string;
}): Promise<MoAgentMissionHandle> {
  return prisma.$transaction(async (tx) => {
    const mission = await boundMission(tx, input);
    const status = missionStatus(mission.status);
    if (status === 'verifying') {
      throw new MoAgentMissionStateError(
        'MISSION_VERIFICATION_BUSY',
        'Mission verification is already owned by another orchestrator.',
      );
    }
    if (status !== 'candidate_complete') {
      throw new MoAgentMissionStateError(
        'MISSION_VERIFICATION_TRANSITION_INVALID',
        `Cannot begin verification while Mission is ${status}.`,
      );
    }
    const now = new Date();
    const updated = await tx.agentMission.updateMany({
      where: { id: mission.id, version: mission.version, status: 'candidate_complete' },
      data: {
        status: 'verifying',
        version: { increment: 1 },
        verificationStartedAt: now,
        errorCode: null,
        errorMessage: null,
      },
    });
    if (updated.count !== 1) {
      throw new MoAgentMissionStateError('MISSION_WRITE_CONFLICT', 'Mission verification claim lost.');
    }
    await setNodeStatus(tx, {
      missionId: mission.id,
      nodeKey: 'validation',
      status: 'running',
      now,
    });
    return handle(await tx.agentMission.findUniqueOrThrow({ where: { id: mission.id } }));
  });
}

export async function markMoAgentMissionRepairing(input: {
  missionId: string;
  projectId: string;
  requestId: string;
}): Promise<MoAgentMissionHandle> {
  return prisma.$transaction(async (tx) => {
    const mission = await boundMission(tx, input);
    const status = missionStatus(mission.status);
    if (status === 'repairing') return handle(mission);
    if (status !== 'repair_required') {
      throw new MoAgentMissionStateError(
        'MISSION_REPAIR_TRANSITION_INVALID',
        `Cannot begin repair while Mission is ${status}.`,
      );
    }
    const updated = await tx.agentMission.updateMany({
      where: { id: mission.id, version: mission.version, status: 'repair_required' },
      data: {
        status: 'repairing',
        version: { increment: 1 },
        errorCode: null,
        errorMessage: null,
      },
    });
    if (updated.count !== 1) {
      throw new MoAgentMissionStateError('MISSION_WRITE_CONFLICT', 'Mission repair claim lost.');
    }
    const now = new Date();
    await setNodeStatus(tx, {
      missionId: mission.id,
      nodeKey: 'workspace_generation',
      status: 'running',
      now,
    });
    return handle(await tx.agentMission.findUniqueOrThrow({ where: { id: mission.id } }));
  });
}

export async function recordMoAgentMissionEvidenceDecision(input: {
  missionId: string;
  projectId: string;
  requestId: string;
  decision: MoAgentEvidenceDecision;
}): Promise<{ mission: MoAgentMissionHandle; receipt: MoAgentEvidenceReceiptHandle }> {
  const expectedReceiptHash = `sha256:${hashMoAgentProvenance(input.decision.payload)}`;
  if (expectedReceiptHash !== input.decision.receiptHash) {
    throw new MoAgentMissionStateError(
      'EVIDENCE_RECEIPT_HASH_MISMATCH',
      'Evidence receipt hash does not match its bounded payload.',
    );
  }
  return prisma.$transaction(async (tx) => {
    const mission = await boundMission(tx, input);
    const status = missionStatus(mission.status);
    if (status === 'completed' && mission.acceptedReceiptId) {
      const existing = await tx.agentEvidenceReceipt.findUniqueOrThrow({
        where: { id: mission.acceptedReceiptId },
      });
      if (existing.receiptHash !== input.decision.receiptHash) {
        throw new MoAgentMissionStateError(
          'EVIDENCE_CONFLICT',
          'Completed Mission already owns a different acceptance receipt.',
        );
      }
      return {
        mission: handle(mission),
        receipt: receiptHandle({ receipt: existing, generationId: mission.generationId }),
      };
    }
    if (status !== 'verifying') {
      throw new MoAgentMissionStateError(
        'MISSION_EVIDENCE_TRANSITION_INVALID',
        `Cannot record verification evidence while Mission is ${status}.`,
      );
    }
    if (input.decision.candidateVersion !== mission.candidateVersion) {
      throw new MoAgentMissionStateError(
        'EVIDENCE_CANDIDATE_STALE',
        'Evidence belongs to an older candidate version.',
      );
    }
    if (input.decision.payload.missionId !== mission.id ||
      input.decision.payload.generationId !== mission.generationId ||
      input.decision.payload.requestId !== mission.requestId ||
      input.decision.payload.projectId !== mission.projectId ||
      input.decision.payload.missionSpecSha256 !== mission.specHash) {
      throw new MoAgentMissionStateError(
        'EVIDENCE_MISSION_IDENTITY_MISMATCH',
        'Evidence identity does not match the durable Mission.',
      );
    }
    const accepted = input.decision.verdict === 'accepted';
    const receiptType = accepted ? 'acceptance' : 'validation';
    const existingReceipt = await tx.agentEvidenceReceipt.findFirst({
      where: {
        missionId: mission.id,
        candidateVersion: mission.candidateVersion,
        receiptType,
        subjectHash: input.decision.subjectHash,
      },
    });
    if (existingReceipt) {
      const existingPayload = existingReceipt.payload as unknown as MoAgentEvidenceDecision['payload'];
      if (
        existingReceipt.verdict !== input.decision.verdict ||
        evidenceReplayHash(existingPayload) !== evidenceReplayHash(input.decision.payload)
      ) {
        throw new MoAgentMissionStateError(
          'EVIDENCE_CONFLICT',
          'The candidate already owns different evidence for this subject.',
        );
      }
    }
    const receipt = existingReceipt ?? await tx.agentEvidenceReceipt.create({
      data: {
        id: `receipt_${randomUUID()}`,
        missionId: mission.id,
        candidateVersion: mission.candidateVersion,
        receiptType,
        verdict: input.decision.verdict,
        subjectHash: input.decision.subjectHash,
        receiptHash: input.decision.receiptHash,
        sourceRunId: mission.currentCandidateRunId,
        sourceRequestId: mission.currentCandidateRequestId,
        payload: inputJson(input.decision.payload),
        createdAt: new Date(input.decision.payload.createdAt),
      },
    });
    if (accepted) {
      // Acceptance and the user-visible request terminal state share one
      // transaction. This gives cancellation and acceptance a single winner:
      // a cancellation committed first blocks acceptance, while an accepted
      // Mission can no longer be overwritten by a later cancellation.
      const completedRequest = await tx.userRequest.updateMany({
        where: {
          id: mission.requestId,
          projectId: mission.projectId,
          status: { in: ['pending', 'processing', 'active', 'running'] },
        },
        data: {
          status: 'completed',
          completedAt: new Date(input.decision.payload.createdAt),
          errorMessage: null,
        },
      });
      if (completedRequest.count !== 1) {
        throw new MoAgentMissionStateError(
          'MISSION_REQUEST_NOT_ACTIVE',
          'Mission acceptance lost the race to a terminal user request state.',
        );
      }
    }
    const nextStatus: MoAgentMissionStatus = accepted
      ? 'completed'
      : input.decision.verdict === 'repair_required'
        ? 'repair_required'
        : input.decision.verdict === 'retry_infrastructure'
          ? 'candidate_complete'
        : 'failed';
    const updated = await tx.agentMission.updateMany({
      where: { id: mission.id, version: mission.version, status: 'verifying' },
      data: {
        status: nextStatus,
        version: { increment: 1 },
        ...(accepted
          ? {
              acceptedReceiptId: receipt.id,
              activeSlot: null,
              completedAt: new Date(input.decision.payload.createdAt),
              errorCode: null,
              errorMessage: null,
            }
          : {
              errorCode: input.decision.reasonCodes[0] ?? 'EVIDENCE_REJECTED',
              errorMessage: `Evidence verdict: ${input.decision.verdict}.`,
            }),
      },
    });
    if (updated.count !== 1) {
      throw new MoAgentMissionStateError('MISSION_WRITE_CONFLICT', 'Mission evidence commit lost.');
    }
    const now = new Date(input.decision.payload.createdAt);
    if (accepted) {
      for (const nodeKey of ['validation', 'evidence_verification', 'preview_readiness'] as const) {
        await setNodeStatus(tx, { missionId: mission.id, nodeKey, status: 'passed', now });
      }
    } else if (input.decision.verdict === 'retry_infrastructure') {
      await setNodeStatus(tx, {
        missionId: mission.id,
        nodeKey: 'validation',
        status: 'passed',
        now,
      });
      await setNodeStatus(tx, {
        missionId: mission.id,
        nodeKey: 'preview_readiness',
        status: 'failed',
        now,
      });
      await setNodeStatus(tx, {
        missionId: mission.id,
        nodeKey: 'evidence_verification',
        status: 'failed',
        now,
      });
    } else {
      await setNodeStatus(tx, {
        missionId: mission.id,
        nodeKey: 'validation',
        status: 'failed',
        now,
      });
      await setNodeStatus(tx, {
        missionId: mission.id,
        nodeKey: 'evidence_verification',
        status: 'failed',
        now,
      });
    }
    return {
      mission: handle(await tx.agentMission.findUniqueOrThrow({ where: { id: mission.id } })),
      receipt: receiptHandle({ receipt, generationId: mission.generationId }),
    };
  });
}

async function terminalMission(input: {
  missionId: string;
  projectId: string;
  requestId: string;
  status: 'failed' | 'cancelled';
  code: string;
  message: string;
}): Promise<MoAgentMissionHandle> {
  return prisma.$transaction(async (tx) => {
    const mission = await boundMission(tx, input);
    const status = missionStatus(mission.status);
    if (TERMINAL_MISSION_STATUSES.has(status)) return handle(mission);
    const now = new Date();
    const updated = await tx.agentMission.updateMany({
      where: { id: mission.id, version: mission.version, status: mission.status },
      data: {
        status: input.status,
        activeSlot: null,
        version: { increment: 1 },
        errorCode: input.code,
        errorMessage: input.message.slice(0, 2_000),
        completedAt: now,
      },
    });
    if (updated.count !== 1) {
      throw new MoAgentMissionStateError('MISSION_WRITE_CONFLICT', 'Mission terminal write lost.');
    }
    await tx.agentMissionNode.updateMany({
      where: {
        missionId: mission.id,
        status: { in: ['pending', 'running'] },
      },
      data: {
        status: 'failed',
        version: { increment: 1 },
        finishedAt: now,
      },
    });
    return handle(await tx.agentMission.findUniqueOrThrow({ where: { id: mission.id } }));
  });
}

export function failMoAgentMission(input: {
  missionId: string;
  projectId: string;
  requestId: string;
  code: string;
  message: string;
}): Promise<MoAgentMissionHandle> {
  return terminalMission({ ...input, status: 'failed' });
}

export function cancelMoAgentMission(input: {
  missionId: string;
  projectId: string;
  requestId: string;
  message?: string;
}): Promise<MoAgentMissionHandle> {
  return terminalMission({
    ...input,
    status: 'cancelled',
    code: 'MISSION_CANCELLED',
    message: input.message ?? 'Mission was cancelled by the user.',
  });
}

export async function cancelActiveMoAgentMissions(input: {
  projectId: string;
  message?: string;
}): Promise<number> {
  return prisma.$transaction(async (tx) => {
    const candidates = await tx.agentMission.findMany({
      where: {
        projectId: input.projectId,
        status: { notIn: ['completed', 'failed', 'cancelled'] },
      },
      select: { id: true },
    });
    if (candidates.length === 0) return 0;
    const ids = candidates.map((mission) => mission.id);
    const now = new Date();
    const cancelled = await tx.agentMission.updateMany({
      where: {
        id: { in: ids },
        projectId: input.projectId,
        status: { notIn: ['completed', 'failed', 'cancelled'] },
      },
      data: {
        status: 'cancelled',
        activeSlot: null,
        version: { increment: 1 },
        errorCode: 'MISSION_CANCELLED',
        errorMessage: (input.message ?? 'Mission was cancelled by the user.').slice(0, 2_000),
        completedAt: now,
      },
    });
    const cancelledRows = await tx.agentMission.findMany({
      where: { id: { in: ids }, projectId: input.projectId, status: 'cancelled' },
      select: { id: true },
    });
    if (cancelledRows.length > 0) {
      await tx.agentMissionNode.updateMany({
        where: {
          missionId: { in: cancelledRows.map((mission) => mission.id) },
          status: { in: ['pending', 'running'] },
        },
        data: {
          status: 'failed',
          version: { increment: 1 },
          finishedAt: now,
        },
      });
    }
    return cancelled.count;
  });
}

export async function readMoAgentAcceptedMissionSnapshot(
  projectId: string,
  requestId: string,
): Promise<MoAgentAcceptedMissionSnapshot | null> {
  const mission = await prisma.agentMission.findFirst({
    where: { projectId, requestId },
    include: { acceptedReceipt: true },
  });
  if (!mission) return null;
  const payload = mission.acceptedReceipt?.payload;
  const record = payload && typeof payload === 'object' && !Array.isArray(payload)
    ? payload as Record<string, unknown>
    : null;
  const preview = record?.preview && typeof record.preview === 'object' &&
    !Array.isArray(record.preview)
    ? record.preview as Record<string, unknown>
    : null;
  return {
    missionId: mission.id,
    generationId: mission.generationId,
    projectId: mission.projectId,
    requestId: mission.requestId,
    missionStatus: missionStatus(mission.status),
    candidateVersion: mission.candidateVersion,
    acceptedReceiptId: mission.acceptedReceiptId,
    acceptedReceiptHash: mission.acceptedReceipt?.receiptHash ?? null,
    acceptedAt: mission.acceptedReceipt?.createdAt.toISOString() ?? null,
    previewUrl: typeof preview?.url === 'string' ? preview.url : null,
    previewPort: typeof preview?.port === 'number' ? preview.port : null,
  };
}
