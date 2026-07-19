import { NextResponse } from 'next/server';

import { requireAction } from '@/lib/auth/action';
import { AuthorizationError } from '@/lib/auth/authorization';
import { authErrorResponse } from '@/lib/auth/http';
import { getPersonalMemoryUseAttribution } from '@/lib/platform/memory';

import { memoryRouteError } from '../../route-error';

interface RouteContext {
  params: Promise<{ project_id: string; request_id: string }>;
}

export async function GET(request: Request, { params }: RouteContext) {
  try {
    const { project_id, request_id } = await params;
    const actor = await requireAction({
      headers: request.headers,
      action: 'project.read',
      projectId: project_id,
    });
    const data = await getPersonalMemoryUseAttribution({
      projectId: project_id,
      actorUserId: actor.actorUserId,
      requestId: request_id,
    });
    return NextResponse.json({ success: true, data }, {
      headers: { 'Cache-Control': 'private, no-store' },
    });
  } catch (error) {
    if (error instanceof AuthorizationError) return authErrorResponse(error);
    return memoryRouteError(error);
  }
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
