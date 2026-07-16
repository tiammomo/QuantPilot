import type { Prisma } from '@prisma/client';

import { prisma } from '@/lib/db/client';

export type AuthAuditOutcome = 'success' | 'failure' | 'denied';

export interface AuthAuditInput {
  actorUserId?: string | null;
  eventType: string;
  targetType?: string | null;
  targetId?: string | null;
  outcome: AuthAuditOutcome;
  headers?: Headers;
  metadata?: Record<string, string | number | boolean | null>;
}

function clientIp(headers: Headers | undefined): string | null {
  if (!headers) return null;
  const forwarded = headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  return forwarded || headers.get('x-real-ip')?.trim() || headers.get('cf-connecting-ip')?.trim() || null;
}

export async function writeAuthAuditEvent(input: AuthAuditInput): Promise<void> {
  try {
    await prisma.authAuditEvent.create({
      data: {
        actorUserId: input.actorUserId ?? null,
        eventType: input.eventType,
        targetType: input.targetType ?? null,
        targetId: input.targetId ?? null,
        outcome: input.outcome,
        ipAddress: clientIp(input.headers),
        userAgent: input.headers?.get('user-agent')?.slice(0, 512) || null,
        metadata: (input.metadata ?? {}) as Prisma.InputJsonValue,
      },
    });
  } catch (error) {
    console.error('[AuthAudit] Failed to persist security event:', error);
  }
}
