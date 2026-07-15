import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const transactionClient = {
    agentMission: {
      findFirst: vi.fn(),
      updateMany: vi.fn(),
      findUniqueOrThrow: vi.fn(),
    },
    agentMissionNode: {
      updateMany: vi.fn(),
    },
    agentEvidenceReceipt: {
      create: vi.fn(),
      findFirst: vi.fn(),
      findUniqueOrThrow: vi.fn(),
    },
    userRequest: {
      updateMany: vi.fn(),
    },
  };
  return {
    transactionClient,
    transaction: vi.fn(async (
      callback: (tx: typeof transactionClient) => unknown,
    ) => callback(transactionClient)),
  };
});

vi.mock('@/lib/db/client', () => ({
  // Intentionally expose writes only through the transaction client. A future
  // regression that moves receipt/request writes outside the transaction will
  // fail this test suite instead of silently weakening the acceptance fence.
  prisma: {
    $transaction: mocks.transaction,
  },
}));

import type {
  MoAgentCandidateSubmission,
  MoAgentEvidenceDecision,
  MoAgentMissionStatus,
} from '@/lib/agent/mission';
import { hashMoAgentProvenance } from './moagent-provenance';
import {
  beginMoAgentMissionVerification,
  MoAgentMissionStateError,
  recordMoAgentMissionCandidate,
  recordMoAgentMissionEvidenceDecision,
} from './moagent-mission-store';

const PROJECT_ID = 'project-mission-store';
const REQUEST_ID = 'request-mission-store';
const MISSION_ID = 'mission-mission-store';
const GENERATION_ID = '11111111-1111-4111-8111-111111111111';
const CREATED_AT = '2026-07-15T05:00:00.000Z';
const SPEC_HASH = `sha256:${'1'.repeat(64)}`;
const SUBJECT_HASH = `sha256:${'2'.repeat(64)}`;

type MissionRow = {
  id: string;
  generationId: string;
  projectId: string;
  requestId: string;
  status: MoAgentMissionStatus;
  version: number;
  candidateVersion: number;
  specHash: string;
  acceptedReceiptId: string | null;
  currentCandidateRunId: string | null;
  currentCandidateRequestId: string | null;
};

function missionRow(overrides: Partial<MissionRow> = {}): MissionRow {
  return {
    id: MISSION_ID,
    generationId: GENERATION_ID,
    projectId: PROJECT_ID,
    requestId: REQUEST_ID,
    status: 'verifying',
    version: 2,
    candidateVersion: 1,
    specHash: SPEC_HASH,
    acceptedReceiptId: null,
    currentCandidateRunId: 'run-current',
    currentCandidateRequestId: REQUEST_ID,
    ...overrides,
  };
}

function candidate(): MoAgentCandidateSubmission {
  return {
    schemaVersion: 1,
    source: 'moagent_submit_result',
    sourceRunId: 'run-current',
    sourceRequestId: REQUEST_ID,
    workspaceSha256: SUBJECT_HASH,
    summarySha256: `sha256:${'3'.repeat(64)}`,
    declaredArtifacts: ['app/page.tsx'],
    verifiedArtifacts: ['app/page.tsx'],
    submittedAt: CREATED_AT,
  };
}

function evidenceDecision(input: {
  candidateVersion?: number;
  payloadOverrides?: Partial<MoAgentEvidenceDecision['payload']>;
} = {}): MoAgentEvidenceDecision {
  const candidateVersion = input.candidateVersion ?? 1;
  const payload: MoAgentEvidenceDecision['payload'] = {
    schemaVersion: 1,
    missionId: MISSION_ID,
    generationId: GENERATION_ID,
    projectId: PROJECT_ID,
    requestId: REQUEST_ID,
    candidateVersion,
    missionSpecSha256: SPEC_HASH,
    validation: {
      reportPath: '.quantpilot/validation.json',
      reportSha256: `sha256:${'4'.repeat(64)}`,
      runId: REQUEST_ID,
      checks: [],
    },
    artifacts: {
      subjectManifestSha256: SUBJECT_HASH,
      evidenceManifestSha256: `sha256:${'5'.repeat(64)}`,
      items: [],
      evidenceItems: [],
      issues: [],
    },
    preview: {
      url: 'http://127.0.0.1:4134',
      port: 4134,
      httpStatus: 200,
      responseSha256: `sha256:${'6'.repeat(64)}`,
      readyAt: CREATED_AT,
    },
    decision: {
      verdict: 'accepted',
      reasonCodes: [],
      failedCheckIds: [],
    },
    createdAt: CREATED_AT,
    ...input.payloadOverrides,
  };
  return {
    verdict: 'accepted',
    reasonCodes: [],
    failedCheckIds: [],
    candidateVersion,
    subjectHash: SUBJECT_HASH,
    payload,
    receiptHash: `sha256:${hashMoAgentProvenance(payload)}`,
  };
}

function mockCreatedReceipt() {
  mocks.transactionClient.agentEvidenceReceipt.create.mockImplementation(async ({ data }) => data);
}

function expectMissionError(error: unknown, code: string): void {
  expect(error).toBeInstanceOf(MoAgentMissionStateError);
  expect(error).toMatchObject({ code });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.transactionClient.agentMissionNode.updateMany.mockResolvedValue({ count: 1 });
  mocks.transactionClient.agentMission.updateMany.mockResolvedValue({ count: 1 });
  mockCreatedReceipt();
});

describe('MoAgent Mission candidate durability', () => {
  it('seals submit-result as candidate_complete without completing the Mission or UserRequest', async () => {
    const initial = missionRow({
      status: 'running',
      version: 0,
      candidateVersion: 0,
      currentCandidateRunId: null,
      currentCandidateRequestId: null,
    });
    const sealed = missionRow({
      status: 'candidate_complete',
      version: 1,
      candidateVersion: 1,
    });
    mocks.transactionClient.agentMission.findFirst.mockResolvedValue(initial);
    mocks.transactionClient.agentMission.findUniqueOrThrow.mockResolvedValue(sealed);

    const result = await recordMoAgentMissionCandidate({
      missionId: MISSION_ID,
      projectId: PROJECT_ID,
      requestId: REQUEST_ID,
      candidate: candidate(),
    });

    expect(result.mission).toMatchObject({
      status: 'candidate_complete',
      candidateVersion: 1,
      acceptedReceiptId: null,
    });
    expect(result.receipt).toMatchObject({
      candidateVersion: 1,
      receiptType: 'candidate',
      verdict: 'candidate_complete',
      subjectHash: SUBJECT_HASH,
    });
    expect(mocks.transactionClient.agentMission.updateMany).toHaveBeenCalledWith({
      where: { id: MISSION_ID, version: 0, status: 'running' },
      data: expect.objectContaining({
        status: 'candidate_complete',
        candidateVersion: 1,
      }),
    });
    expect(mocks.transactionClient.userRequest.updateMany).not.toHaveBeenCalled();
    expect(mocks.transaction).toHaveBeenCalledTimes(1);
  });
});

describe('MoAgent Mission verification claim', () => {
  it('claims candidate_complete exactly once before validation can start', async () => {
    const candidateMission = missionRow({
      status: 'candidate_complete',
      version: 1,
      candidateVersion: 1,
    });
    const verifyingMission = missionRow({
      status: 'verifying',
      version: 2,
      candidateVersion: 1,
    });
    mocks.transactionClient.agentMission.findFirst.mockResolvedValue(candidateMission);
    mocks.transactionClient.agentMission.findUniqueOrThrow.mockResolvedValue(verifyingMission);

    await expect(beginMoAgentMissionVerification({
      missionId: MISSION_ID,
      projectId: PROJECT_ID,
      requestId: REQUEST_ID,
    })).resolves.toMatchObject({ status: 'verifying', version: 2 });
    expect(mocks.transactionClient.agentMission.updateMany).toHaveBeenCalledWith({
      where: { id: MISSION_ID, version: 1, status: 'candidate_complete' },
      data: expect.objectContaining({
        status: 'verifying',
        version: { increment: 1 },
      }),
    });
  });

  it('rejects a second verification owner instead of treating it as idempotent', async () => {
    mocks.transactionClient.agentMission.findFirst.mockResolvedValue(
      missionRow({ status: 'verifying' }),
    );

    await expect(beginMoAgentMissionVerification({
      missionId: MISSION_ID,
      projectId: PROJECT_ID,
      requestId: REQUEST_ID,
    })).rejects.toMatchObject({ code: 'MISSION_VERIFICATION_BUSY' });
    expect(mocks.transactionClient.agentMission.updateMany).not.toHaveBeenCalled();
  });
});

describe('MoAgent Mission acceptance fence', () => {
  it('commits the acceptance receipt, Mission completion, and UserRequest completion in one transaction', async () => {
    const initial = missionRow();
    let receiptId: string | null = null;
    mocks.transactionClient.agentMission.findFirst.mockResolvedValue(initial);
    mocks.transactionClient.agentEvidenceReceipt.create.mockImplementation(async ({ data }) => {
      receiptId = data.id;
      return data;
    });
    mocks.transactionClient.userRequest.updateMany.mockResolvedValue({ count: 1 });
    mocks.transactionClient.agentMission.findUniqueOrThrow.mockImplementation(async () =>
      missionRow({
        status: 'completed',
        version: 3,
        acceptedReceiptId: receiptId,
      }));

    const result = await recordMoAgentMissionEvidenceDecision({
      missionId: MISSION_ID,
      projectId: PROJECT_ID,
      requestId: REQUEST_ID,
      decision: evidenceDecision(),
    });

    expect(result.mission).toMatchObject({
      status: 'completed',
      acceptedReceiptId: receiptId,
    });
    expect(result.receipt).toMatchObject({
      receiptType: 'acceptance',
      verdict: 'accepted',
      candidateVersion: 1,
    });
    expect(mocks.transactionClient.userRequest.updateMany).toHaveBeenCalledWith({
      where: {
        id: REQUEST_ID,
        projectId: PROJECT_ID,
        status: { in: ['pending', 'processing', 'active', 'running'] },
      },
      data: {
        status: 'completed',
        completedAt: new Date(CREATED_AT),
        errorMessage: null,
      },
    });
    expect(mocks.transactionClient.agentMission.updateMany).toHaveBeenCalledWith({
      where: { id: MISSION_ID, version: 2, status: 'verifying' },
      data: expect.objectContaining({
        status: 'completed',
        acceptedReceiptId: receiptId,
      }),
    });
    expect(mocks.transaction).toHaveBeenCalledTimes(1);
  });

  it.each(['cancelled', 'completed'])(
    'blocks acceptance when the UserRequest is already %s',
    async (requestStatus) => {
      mocks.transactionClient.agentMission.findFirst.mockResolvedValue(missionRow());
      mocks.transactionClient.userRequest.updateMany.mockImplementation(async ({ where }) => ({
        count: where.status.in.includes(requestStatus) ? 1 : 0,
      }));

      const error = await recordMoAgentMissionEvidenceDecision({
        missionId: MISSION_ID,
        projectId: PROJECT_ID,
        requestId: REQUEST_ID,
        decision: evidenceDecision(),
      }).catch((caught: unknown) => caught);

      expectMissionError(error, 'MISSION_REQUEST_NOT_ACTIVE');
      expect(mocks.transactionClient.userRequest.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            status: { in: ['pending', 'processing', 'active', 'running'] },
          }),
        }),
      );
      expect(mocks.transactionClient.agentMission.updateMany).not.toHaveBeenCalled();
      expect(mocks.transactionClient.agentMissionNode.updateMany).not.toHaveBeenCalled();
    },
  );

  it('rejects evidence for a stale candidateVersion before persisting a receipt', async () => {
    mocks.transactionClient.agentMission.findFirst.mockResolvedValue(missionRow({
      candidateVersion: 2,
    }));

    const error = await recordMoAgentMissionEvidenceDecision({
      missionId: MISSION_ID,
      projectId: PROJECT_ID,
      requestId: REQUEST_ID,
      decision: evidenceDecision({ candidateVersion: 1 }),
    }).catch((caught: unknown) => caught);

    expectMissionError(error, 'EVIDENCE_CANDIDATE_STALE');
    expect(mocks.transactionClient.agentEvidenceReceipt.create).not.toHaveBeenCalled();
    expect(mocks.transactionClient.userRequest.updateMany).not.toHaveBeenCalled();
    expect(mocks.transactionClient.agentMission.updateMany).not.toHaveBeenCalled();
  });

  it('rejects a receipt hash mismatch before opening a transaction', async () => {
    const decision = evidenceDecision();
    decision.receiptHash = `sha256:${'f'.repeat(64)}`;

    const error = await recordMoAgentMissionEvidenceDecision({
      missionId: MISSION_ID,
      projectId: PROJECT_ID,
      requestId: REQUEST_ID,
      decision,
    }).catch((caught: unknown) => caught);

    expectMissionError(error, 'EVIDENCE_RECEIPT_HASH_MISMATCH');
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it('rejects a receipt whose hashed payload is bound to another Mission identity', async () => {
    mocks.transactionClient.agentMission.findFirst.mockResolvedValue(missionRow());
    const decision = evidenceDecision({
      payloadOverrides: { projectId: 'project-other' },
    });

    const error = await recordMoAgentMissionEvidenceDecision({
      missionId: MISSION_ID,
      projectId: PROJECT_ID,
      requestId: REQUEST_ID,
      decision,
    }).catch((caught: unknown) => caught);

    expectMissionError(error, 'EVIDENCE_MISSION_IDENTITY_MISMATCH');
    expect(mocks.transactionClient.agentEvidenceReceipt.create).not.toHaveBeenCalled();
    expect(mocks.transactionClient.userRequest.updateMany).not.toHaveBeenCalled();
    expect(mocks.transactionClient.agentMission.updateMany).not.toHaveBeenCalled();
  });
});
