import { NextResponse } from 'next/server';
import { requireAction } from '@/lib/auth/action';
import { AuthorizationError } from '@/lib/auth/authorization';
import { authErrorResponse } from '@/lib/auth/http';
import { projectRouteAction } from '@/lib/auth/project-route-action';
import { getActiveSession } from '@/lib/services/chat-sessions';

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
    const session = await getActiveSession(project_id);

    // Compatibility endpoint only. Active MoAgent work is tracked through
    // UserRequest/agent-runtime; legacy non-MoAgent Session rows are filtered.
    if (!session) {
      return NextResponse.json({ success: true, data: null, runtime: 'moagent', deprecated: true });
    }

    return NextResponse.json({ success: true, data: session, runtime: 'moagent', deprecated: true });
  } catch (error) {
    if (error instanceof AuthorizationError) return authErrorResponse(error);
    console.error('[API] Failed to get active session:', error);
    return NextResponse.json(
      {
        success: false,
        error: 'Failed to get active session',
        message: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 },
    );
  }
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
