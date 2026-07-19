import { NextResponse } from 'next/server';

import { requireAction } from '@/lib/auth/action';
import { AuthorizationError } from '@/lib/auth/authorization';
import { authErrorResponse } from '@/lib/auth/http';
import {
  recordPersonalMemoryFeedback,
  type MemoryOutcomeKind,
} from '@/lib/platform/memory';

import { memoryRouteError } from '../route-error';

interface RouteContext {
  params: Promise<{ project_id: string }>;
}

const OUTCOME_KINDS = new Set<MemoryOutcomeKind>([
  'helpful',
  'accepted',
  'harmful',
  'rejected',
  'corrected',
]);

function bodyRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export async function POST(request: Request, { params }: RouteContext) {
  try {
    const { project_id } = await params;
    const actor = await requireAction({
      headers: request.headers,
      action: 'project.update',
      projectId: project_id,
    });
    const body = bodyRecord(await request.json().catch(() => ({})));
    const kind = typeof body.kind === 'string' && OUTCOME_KINDS.has(body.kind as MemoryOutcomeKind)
      ? body.kind as MemoryOutcomeKind
      : null;
    if (!kind) {
      return NextResponse.json(
        { success: false, error: 'INVALID_MEMORY_OUTCOME' },
        { status: 400 },
      );
    }
    const data = await recordPersonalMemoryFeedback({
      projectId: project_id,
      actorUserId: actor.actorUserId,
      requestId: typeof body.requestId === 'string' ? body.requestId : '',
      revisionId: typeof body.revisionId === 'string' ? body.revisionId : '',
      eventId: typeof body.eventId === 'string' ? body.eventId : '',
      kind,
      weight: typeof body.weight === 'number' ? body.weight : undefined,
      note: typeof body.note === 'string' ? body.note : undefined,
      occurredAt: typeof body.occurredAt === 'string' ? body.occurredAt : undefined,
    });
    return NextResponse.json({ success: true, data }, { status: 201 });
  } catch (error) {
    if (error instanceof AuthorizationError) return authErrorResponse(error);
    return memoryRouteError(error);
  }
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
