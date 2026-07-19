import { NextResponse } from 'next/server';

import { requireAction } from '@/lib/auth/action';
import { AuthorizationError } from '@/lib/auth/authorization';
import { authErrorResponse } from '@/lib/auth/http';
import { correctPersonalPreference } from '@/lib/platform/memory';

import { memoryRouteError } from '../../../route-error';

interface RouteContext {
  params: Promise<{ project_id: string; record_id: string }>;
}

function bodyRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export async function POST(request: Request, { params }: RouteContext) {
  try {
    const { project_id, record_id } = await params;
    const actor = await requireAction({
      headers: request.headers,
      action: 'project.update',
      projectId: project_id,
    });
    const body = bodyRecord(await request.json().catch(() => ({})));
    const data = await correctPersonalPreference({
      actorUserId: actor.actorUserId,
      recordId: record_id,
      eventId: typeof body.eventId === 'string' ? body.eventId : '',
      value: typeof body.value === 'string' ? body.value : '',
      evidenceText: typeof body.evidenceText === 'string' ? body.evidenceText : '',
      reason: typeof body.reason === 'string' ? body.reason : '',
      expectedRevisionId:
        typeof body.expectedRevisionId === 'string' ? body.expectedRevisionId : undefined,
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
