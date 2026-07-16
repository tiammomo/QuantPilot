import { NextResponse } from 'next/server';
import { requireAction } from '@/lib/auth/action';
import { AuthorizationError } from '@/lib/auth/authorization';
import { authErrorResponse } from '@/lib/auth/http';
import { projectRouteAction } from '@/lib/auth/project-route-action';
import { deleteProjectService } from '@/lib/services/project-services';

interface RouteContext {
  params: Promise<{ project_id: string; service_id: string }>;
}

export async function DELETE(_request: Request, { params }: RouteContext) {
  try {
    const { project_id, service_id } = await params;
    await requireAction({
      headers: _request.headers,
      action: projectRouteAction('services', _request.method),
      projectId: project_id,
    });
    const deleted = await deleteProjectService(project_id, service_id);
    if (!deleted) {
      return NextResponse.json({ success: false, error: 'Service not found' }, { status: 404 });
    }

    return NextResponse.json({ success: true, message: 'Service disconnected' });
  } catch (error) {
    if (error instanceof AuthorizationError) return authErrorResponse(error);
    console.error('[API] Failed to delete project service:', error);
    return NextResponse.json(
      {
        success: false,
        error: 'Failed to delete project service',
        message: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 },
    );
  }
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
