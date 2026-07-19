import type { PrismaClient } from '@prisma/client';

import { prisma } from '@/lib/db/client';

export const PERSONAL_MEMORY_CONTROL_POLICY = 'quantpilot-personalization-v1' as const;

export interface PersonalMemoryControlState {
  configured: boolean;
  personalizationEnabled: boolean;
  policyVersion: string;
  enabledAt: Date | null;
  disabledAt: Date | null;
  updatedAt: Date | null;
}

export interface PersonalMemoryControlUpdate extends PersonalMemoryControlState {
  changed: boolean;
}

export interface PersonalMemoryControlRepository {
  get(subjectId: string): Promise<PersonalMemoryControlState>;
  set(subjectId: string, enabled: boolean, now?: Date): Promise<PersonalMemoryControlUpdate>;
}

type ControlPrismaClient = Pick<PrismaClient, 'personalMemoryControl' | '$transaction'>;

function absent(): PersonalMemoryControlState {
  return {
    configured: false,
    personalizationEnabled: false,
    policyVersion: PERSONAL_MEMORY_CONTROL_POLICY,
    enabledAt: null,
    disabledAt: null,
    updatedAt: null,
  };
}

function mapped(row: {
  personalizationEnabled: boolean;
  policyVersion: string;
  enabledAt: Date | null;
  disabledAt: Date | null;
  updatedAt: Date;
}): PersonalMemoryControlState {
  return {
    configured: true,
    personalizationEnabled: row.personalizationEnabled,
    policyVersion: row.policyVersion,
    enabledAt: row.enabledAt,
    disabledAt: row.disabledAt,
    updatedAt: row.updatedAt,
  };
}

export class PrismaPersonalMemoryControlRepository implements PersonalMemoryControlRepository {
  constructor(private readonly client: ControlPrismaClient = prisma) {}

  async get(subjectId: string): Promise<PersonalMemoryControlState> {
    const row = await this.client.personalMemoryControl.findUnique({ where: { subjectId } });
    return row ? mapped(row) : absent();
  }

  async set(
    subjectId: string,
    enabled: boolean,
    now: Date = new Date(),
  ): Promise<PersonalMemoryControlUpdate> {
    return this.client.$transaction(async (transaction) => {
      const existing = await transaction.personalMemoryControl.findUnique({
        where: { subjectId },
      });
      if (existing?.personalizationEnabled === enabled) {
        return { ...mapped(existing), changed: false };
      }
      const row = await transaction.personalMemoryControl.upsert({
        where: { subjectId },
        create: {
          subjectId,
          personalizationEnabled: enabled,
          policyVersion: PERSONAL_MEMORY_CONTROL_POLICY,
          enabledAt: enabled ? now : null,
          disabledAt: enabled ? null : now,
        },
        update: {
          personalizationEnabled: enabled,
          policyVersion: PERSONAL_MEMORY_CONTROL_POLICY,
          enabledAt: enabled ? now : null,
          disabledAt: enabled ? null : now,
        },
      });
      return { ...mapped(row), changed: true };
    });
  }
}
