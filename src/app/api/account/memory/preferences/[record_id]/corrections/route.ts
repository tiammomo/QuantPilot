import { NextResponse } from 'next/server';
import { z } from 'zod';

import { memoryRouteError } from '@/app/api/projects/[project_id]/memory/route-error';
import { writeAuthAuditEvent } from '@/lib/auth/audit';
import { AuthorizationError, requireAuthSession } from '@/lib/auth/authorization';
import { authErrorResponse } from '@/lib/auth/http';
import { correctPersonalPreference } from '@/lib/platform/memory';

interface RouteContext {
  params: Promise<{ record_id: string }>;
}

const correctionSchema = z.object({
  eventId: z.string().trim().min(1).max(160),
  value: z.string().trim().min(1).max(4_096),
  evidenceText: z.string().trim().min(1).max(16_384),
  reason: z.string().trim().min(1).max(2_048),
  expectedRevisionId: z.string().trim().min(1).max(64).optional(),
  occurredAt: z.iso.datetime({ offset: true }).optional(),
}).strict();

export async function POST(request: Request, { params }: RouteContext) {
  try {
    const session = await requireAuthSession(request.headers);
    const { record_id } = await params;
    const body = correctionSchema.parse(await request.json());
    const data = await correctPersonalPreference({
      actorUserId: session.user.id,
      recordId: record_id,
      ...body,
    });
    await writeAuthAuditEvent({
      actorUserId: session.user.id,
      eventType: 'personal_memory.preference_corrected',
      targetType: 'personal_memory_preference',
      targetId: record_id,
      outcome: 'success',
      headers: request.headers,
      metadata: {
        revisionId: data.revisionId,
        sequence: data.sequence,
        idempotentReplay: data.idempotentReplay,
      },
    });
    const response = NextResponse.json({ success: true, data }, { status: 201 });
    response.headers.set('Cache-Control', 'private, no-store');
    return response;
  } catch (error) {
    if (error instanceof AuthorizationError) return authErrorResponse(error);
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { success: false, error: 'INVALID_MEMORY_CORRECTION' },
        { status: 400 },
      );
    }
    return memoryRouteError(error);
  }
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
