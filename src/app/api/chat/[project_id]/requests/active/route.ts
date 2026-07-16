import { NextResponse } from 'next/server';
import { requireAction } from '@/lib/auth/action';
import { AuthorizationError } from '@/lib/auth/authorization';
import { authErrorResponse } from '@/lib/auth/http';
import { projectRouteAction } from '@/lib/auth/project-route-action';
import { getActiveRequests } from '@/lib/services/user-requests';

interface RouteContext {
  params: Promise<{ project_id: string }>;
}

export async function GET(_request: Request, { params }: RouteContext) {
  try {
    const { project_id } = await params;
    await requireAction({
      headers: _request.headers,
      action: projectRouteAction('chat-data', _request.method),
      projectId: project_id,
    });
    const summary = await getActiveRequests(project_id);
    return NextResponse.json(summary);
  } catch (error) {
    if (error instanceof AuthorizationError) return authErrorResponse(error);
    console.error('[API] Failed to get active requests:', error);
    return NextResponse.json(
      {
        success: false,
        error: 'Failed to get active requests',
        message: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 },
    );
  }
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
