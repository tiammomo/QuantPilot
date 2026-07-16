import { NextResponse } from 'next/server';
import { requireAction } from '@/lib/auth/action';
import { AuthorizationError } from '@/lib/auth/authorization';
import { authErrorResponse } from '@/lib/auth/http';
import { projectRouteAction } from '@/lib/auth/project-route-action';
import { listProjectServices } from '@/lib/services/project-services';

interface RouteContext {
  params: Promise<{ project_id: string }>;
}

export async function GET(_request: Request, { params }: RouteContext) {
  try {
    const { project_id } = await params;
    await requireAction({
      headers: _request.headers,
      action: projectRouteAction('services', _request.method),
      projectId: project_id,
    });
    const services = await listProjectServices(project_id);
    const payload = services.map((service) => ({
      ...service,
      service_data: service.serviceData,
    }));
    return NextResponse.json(payload);
  } catch (error) {
    if (error instanceof AuthorizationError) return authErrorResponse(error);
    console.error('[API] Failed to load project services:', error);
    return NextResponse.json(
      {
        success: false,
        error: 'Failed to load project services',
        message: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 },
    );
  }
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
