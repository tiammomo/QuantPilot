import { prisma } from '@/lib/db/client';

import { MEMORY_PROVIDER_ID } from './types';

export interface ExternalMemoryUseRecord {
  provider: string;
  projectId: string;
  requestId: string;
  tenantId: string;
  subjectId: string;
  traceId: string;
  policyId: string;
  policyVersion: number;
  validAt: Date;
  knownAt: Date;
  sourceProjectionSha256: string;
  deliveredContextSha256: string;
  exposedRevisionIds: string[];
  status: 'exposed' | 'legacy_empty';
  exposedAt: Date | null;
}

export type ExternalMemoryUseWrite = Omit<ExternalMemoryUseRecord, 'status' | 'exposedAt'> & {
  status?: ExternalMemoryUseRecord['status'];
  exposedAt?: Date | null;
};

export interface ExternalMemoryUseSummary {
  exposedRunCount: number;
  exposedRevisionReferenceCount: number;
  legacyEmptyAttributionCount: number;
  lastExposedAt: Date | null;
}

function revisionIds(value: unknown): string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
    ? [...value]
    : [];
}

function mapRecord(record: {
  provider: string;
  projectId: string;
  requestId: string;
  tenantId: string;
  subjectId: string;
  traceId: string;
  policyId: string;
  policyVersion: number;
  validAt: Date;
  knownAt: Date;
  sourceProjectionSha256: string;
  deliveredContextSha256: string;
  exposedRevisionIds: unknown;
  status: string;
  exposedAt: Date | null;
}): ExternalMemoryUseRecord {
  return {
    ...record,
    exposedRevisionIds: revisionIds(record.exposedRevisionIds),
    status: record.status === 'legacy_empty' ? 'legacy_empty' : 'exposed',
  };
}

export interface ExternalMemoryUseRepository {
  save(input: ExternalMemoryUseWrite): Promise<ExternalMemoryUseRecord>;
  find(projectId: string, requestId: string): Promise<ExternalMemoryUseRecord | null>;
  summarize(subjectId: string): Promise<ExternalMemoryUseSummary>;
}

export class PrismaExternalMemoryUseRepository implements ExternalMemoryUseRepository {
  async save(input: ExternalMemoryUseWrite): Promise<ExternalMemoryUseRecord> {
    const row = await prisma.externalMemoryUse.upsert({
      where: {
        provider_projectId_requestId: {
          provider: input.provider,
          projectId: input.projectId,
          requestId: input.requestId,
        },
      },
      update: {},
      create: {
        ...input,
        status: input.status ?? 'exposed',
        exposedAt: input.exposedAt ?? new Date(),
        exposedRevisionIds: input.exposedRevisionIds,
      },
    });
    const stored = mapRecord(row);
    if (
      stored.tenantId !== input.tenantId
      || stored.subjectId !== input.subjectId
      || stored.traceId !== input.traceId
      || stored.policyId !== input.policyId
      || stored.policyVersion !== input.policyVersion
      || stored.sourceProjectionSha256 !== input.sourceProjectionSha256
      || stored.deliveredContextSha256 !== input.deliveredContextSha256
      || JSON.stringify(stored.exposedRevisionIds) !== JSON.stringify(input.exposedRevisionIds)
    ) {
      throw new Error('External memory use idempotency collision.');
    }
    return stored;
  }

  async find(projectId: string, requestId: string): Promise<ExternalMemoryUseRecord | null> {
    const row = await prisma.externalMemoryUse.findUnique({
      where: {
        provider_projectId_requestId: {
          provider: MEMORY_PROVIDER_ID,
          projectId,
          requestId,
        },
      },
    });
    return row ? mapRecord(row) : null;
  }

  async summarize(subjectId: string): Promise<ExternalMemoryUseSummary> {
    const rows = await prisma.externalMemoryUse.findMany({
      where: { provider: MEMORY_PROVIDER_ID, subjectId },
      select: {
        status: true,
        exposedAt: true,
        exposedRevisionIds: true,
      },
    });
    const exposed = rows.filter((row) => row.status === 'exposed');
    return {
      exposedRunCount: exposed.length,
      exposedRevisionReferenceCount: exposed.reduce(
        (total, row) => total + revisionIds(row.exposedRevisionIds).length,
        0,
      ),
      legacyEmptyAttributionCount: rows.length - exposed.length,
      lastExposedAt: exposed.reduce<Date | null>(
        (latest, row) => !latest || (row.exposedAt && row.exposedAt > latest) ? row.exposedAt : latest,
        null,
      ),
    };
  }
}
