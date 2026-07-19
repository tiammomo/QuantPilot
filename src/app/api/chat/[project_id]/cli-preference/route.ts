import { NextRequest, NextResponse } from 'next/server';
import { requireAction } from '@/lib/auth/action';
import { AuthorizationError } from '@/lib/auth/authorization';
import { authErrorResponse } from '@/lib/auth/http';
import { projectRouteAction } from '@/lib/auth/project-route-action';
import {
  getProjectCliPreference,
  updateProjectCliPreference,
} from '@/lib/services/project';
import { normalizeMoAgentModelId } from '@/lib/constants/models';

interface RouteContext {
  params: Promise<{ project_id: string }>;
}

export async function GET(_request: NextRequest, { params }: RouteContext) {
  const { project_id } = await params;
  try {
    await requireAction({
      headers: _request.headers,
      action: projectRouteAction('project', _request.method),
      projectId: project_id,
    });
  } catch (error) {
    return authErrorResponse(error);
  }
  const preference = await getProjectCliPreference(project_id);
  if (!preference) {
    return NextResponse.json(
      { success: false, error: 'Project not found' },
      { status: 404 },
    );
  }

  return NextResponse.json({ success: true, data: preference });
}

export async function POST(request: NextRequest, { params }: RouteContext) {
  try {
    const { project_id } = await params;
    await requireAction({
      headers: request.headers,
      action: projectRouteAction('project', request.method),
      projectId: project_id,
    });
    const body = await request.json().catch(() => ({}));
    const requestedModel = body.selectedModel ?? body.selected_model;
    const update = {
      preferredCli: 'moagent',
      fallbackEnabled: false,
      ...(typeof requestedModel === 'string'
        ? { selectedModel: normalizeMoAgentModelId(requestedModel) }
        : {}),
    };

    const updated = await updateProjectCliPreference(project_id, update);
    return NextResponse.json({ success: true, data: updated });
  } catch (error) {
    if (error instanceof AuthorizationError) return authErrorResponse(error);
    console.error('[API] Failed to update CLI preference:', error);
    return NextResponse.json(
      {
        success: false,
        error: 'Failed to update CLI preference',
        message: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 },
    );
  }
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
