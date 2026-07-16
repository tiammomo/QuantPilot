import { NextResponse } from 'next/server';
import { requireAction } from '@/lib/auth/action';
import { AuthorizationError } from '@/lib/auth/authorization';
import { authErrorResponse } from '@/lib/auth/http';
import { projectRouteAction } from '@/lib/auth/project-route-action';
import { getSessionById } from '@/lib/services/chat-sessions';

interface RouteContext {
  params: Promise<{ project_id: string; session_id: string }>;
}

export async function GET(_request: Request, { params }: RouteContext) {
  try {
    const { project_id, session_id } = await params;
    await requireAction({
      headers: _request.headers,
      action: projectRouteAction('chat-data', _request.method),
      projectId: project_id,
    });
    const session = await getSessionById(project_id, session_id);
    if (!session) {
      return NextResponse.json(
        { success: false, error: 'MoAgent compatibility session not found', deprecated: true },
        { status: 404 },
      );
    }

    return NextResponse.json({ success: true, data: session, runtime: 'moagent', deprecated: true });
  } catch (error) {
    if (error instanceof AuthorizationError) return authErrorResponse(error);
    console.error('[API] Failed to get session status:', error);
    return NextResponse.json(
      {
        success: false,
        error: 'Failed to get session status',
        message: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 },
    );
  }
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
