import { prisma } from '@/lib/db/client';

import { MEMORY_PROVIDER_ID, type MemoryOutcomeKind } from './types';

export type PersonalMemoryFeedbackStatus = 'pending' | 'completed' | 'failed';

export interface PersonalMemoryFeedbackReceipt {
  id: string;
  provider: string;
  projectId: string;
  requestId: string;
  subjectId: string;
  revisionId: string;
  eventId: string;
  kind: MemoryOutcomeKind;
  status: PersonalMemoryFeedbackStatus;
  outcomeId: string | null;
  lastErrorCode: string | null;
  completedAt: Date | null;
}

export interface PersonalMemoryFeedbackWrite {
  provider: string;
  projectId: string;
  requestId: string;
  subjectId: string;
  revisionId: string;
  eventId: string;
  kind: MemoryOutcomeKind;
}

export interface PersonalMemoryFeedbackSummary {
  completedCount: number;
  helpfulCount: number;
  rejectedCount: number;
  pendingCount: number;
  failedCount: number;
}

export class PersonalMemoryFeedbackConflictError extends Error {
  constructor() {
    super('Feedback for this exposed revision has already been recorded with different semantics.');
    this.name = 'PersonalMemoryFeedbackConflictError';
  }
}

function status(value: string): PersonalMemoryFeedbackStatus {
  if (value === 'completed' || value === 'failed') return value;
  return 'pending';
}

function outcomeKind(value: string): MemoryOutcomeKind {
  return value as MemoryOutcomeKind;
}

function mapReceipt(row: {
  id: string;
  provider: string;
  projectId: string;
  requestId: string;
  subjectId: string;
  revisionId: string;
  eventId: string;
  kind: string;
  status: string;
  outcomeId: string | null;
  lastErrorCode: string | null;
  completedAt: Date | null;
}): PersonalMemoryFeedbackReceipt {
  return {
    ...row,
    kind: outcomeKind(row.kind),
    status: status(row.status),
  };
}

export interface PersonalMemoryFeedbackRepository {
  begin(input: PersonalMemoryFeedbackWrite): Promise<{
    receipt: PersonalMemoryFeedbackReceipt;
    shouldSubmit: boolean;
  }>;
  complete(id: string, outcomeId: string): Promise<PersonalMemoryFeedbackReceipt>;
  fail(id: string, errorCode: string): Promise<void>;
  summarize(subjectId: string): Promise<PersonalMemoryFeedbackSummary>;
}

export class PrismaPersonalMemoryFeedbackRepository
implements PersonalMemoryFeedbackRepository {
  async begin(input: PersonalMemoryFeedbackWrite): Promise<{
    receipt: PersonalMemoryFeedbackReceipt;
    shouldSubmit: boolean;
  }> {
    const row = await prisma.personalMemoryFeedbackReceipt.upsert({
      where: {
        provider_projectId_requestId_revisionId: {
          provider: input.provider,
          projectId: input.projectId,
          requestId: input.requestId,
          revisionId: input.revisionId,
        },
      },
      update: {},
      create: input,
    });
    if (
      row.subjectId !== input.subjectId
      || row.eventId !== input.eventId
      || row.kind !== input.kind
    ) {
      throw new PersonalMemoryFeedbackConflictError();
    }
    if (row.status === 'completed') {
      return { receipt: mapReceipt(row), shouldSubmit: false };
    }
    if (row.status === 'failed') {
      const pending = await prisma.personalMemoryFeedbackReceipt.update({
        where: { id: row.id },
        data: { status: 'pending', lastErrorCode: null },
      });
      return { receipt: mapReceipt(pending), shouldSubmit: true };
    }
    return { receipt: mapReceipt(row), shouldSubmit: true };
  }

  async complete(id: string, outcomeId: string): Promise<PersonalMemoryFeedbackReceipt> {
    return mapReceipt(await prisma.personalMemoryFeedbackReceipt.update({
      where: { id },
      data: {
        status: 'completed',
        outcomeId,
        lastErrorCode: null,
        completedAt: new Date(),
      },
    }));
  }

  async fail(id: string, errorCode: string): Promise<void> {
    await prisma.personalMemoryFeedbackReceipt.updateMany({
      where: { id, status: { not: 'completed' } },
      data: { status: 'failed', lastErrorCode: errorCode.slice(0, 160) },
    });
  }

  async summarize(subjectId: string): Promise<PersonalMemoryFeedbackSummary> {
    const rows = await prisma.personalMemoryFeedbackReceipt.findMany({
      where: { provider: MEMORY_PROVIDER_ID, subjectId },
      select: { kind: true, status: true },
    });
    const completed = rows.filter((row) => row.status === 'completed');
    return {
      completedCount: completed.length,
      helpfulCount: completed.filter((row) => row.kind === 'helpful').length,
      rejectedCount: completed.filter((row) => row.kind === 'rejected').length,
      pendingCount: rows.filter((row) => row.status === 'pending').length,
      failedCount: rows.filter((row) => row.status === 'failed').length,
    };
  }
}
