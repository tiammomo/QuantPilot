import { NextResponse } from 'next/server';

import { memoryRouteError } from '@/app/api/projects/[project_id]/memory/route-error';
import { AuthorizationError, requireAuthSession } from '@/lib/auth/authorization';
import { authErrorResponse } from '@/lib/auth/http';
import { getPersonalPreferenceRevisions } from '@/lib/platform/memory';

interface RouteContext {
  params: Promise<{ record_id: string }>;
}

export async function GET(request: Request, { params }: RouteContext) {
  try {
    const session = await requireAuthSession(request.headers);
    const { record_id } = await params;
    const data = await getPersonalPreferenceRevisions({
      actorUserId: session.user.id,
      recordId: record_id,
      requestId: request.headers.get('x-request-id') ?? undefined,
    });
    const response = NextResponse.json({ success: true, data });
    response.headers.set('Cache-Control', 'private, no-store');
    return response;
  } catch (error) {
    if (error instanceof AuthorizationError) return authErrorResponse(error);
    return memoryRouteError(error);
  }
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
