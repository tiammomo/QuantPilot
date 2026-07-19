import { NextResponse } from 'next/server';

import { requireAction } from '@/lib/auth/action';
import { AuthorizationError } from '@/lib/auth/authorization';
import { authErrorResponse } from '@/lib/auth/http';
import {
  listPersonalPreferences,
  rememberPersonalPreference,
} from '@/lib/platform/memory';

import { memoryRouteError } from '../route-error';

interface RouteContext {
  params: Promise<{ project_id: string }>;
}

function bodyRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export async function GET(request: Request, { params }: RouteContext) {
  try {
    const { project_id } = await params;
    const actor = await requireAction({
      headers: request.headers,
      action: 'project.read',
      projectId: project_id,
    });
    const data = await listPersonalPreferences({
      actorUserId: actor.actorUserId,
      requestId: request.headers.get('x-request-id') ?? undefined,
    });
    return NextResponse.json({ success: true, data }, {
      headers: { 'Cache-Control': 'private, no-store' },
    });
  } catch (error) {
    if (error instanceof AuthorizationError) return authErrorResponse(error);
    return memoryRouteError(error);
  }
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
    const scope = body.scope === undefined || body.scope === 'global'
      ? 'global'
      : body.scope === 'project'
        ? 'project'
        : null;
    if (!scope) {
      return NextResponse.json(
        { success: false, error: 'INVALID_MEMORY_SCOPE' },
        { status: 400 },
      );
    }
    const data = await rememberPersonalPreference({
      projectId: project_id,
      actorUserId: actor.actorUserId,
      eventId: typeof body.eventId === 'string' ? body.eventId : '',
      key: typeof body.key === 'string' ? body.key : '',
      value: typeof body.value === 'string' ? body.value : '',
      evidenceText: typeof body.evidenceText === 'string' ? body.evidenceText : '',
      confidence: typeof body.confidence === 'number' ? body.confidence : undefined,
      scope,
      context: bodyRecord(body.context),
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
