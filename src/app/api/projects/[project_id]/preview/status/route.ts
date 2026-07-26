/**
 * GET /api/projects/[id]/preview/status
 * Returns the current preview status for the project.
 */

import { NextResponse } from 'next/server';
import { requireAction } from '@/lib/auth/action';
import { AuthorizationError } from '@/lib/auth/authorization';
import { authErrorResponse } from '@/lib/auth/http';
import { getProjectById } from '@/lib/services/project';

interface RouteContext {
  params: Promise<{ project_id: string }>;
}

export async function GET(
  request: Request,
  { params }: RouteContext
) {
  try {
    const { project_id } = await params;
    await requireAction({
      headers: request.headers,
      action: 'project.read',
      projectId: project_id,
    });
    const project = await getProjectById(project_id);
    if (!project) {
      return NextResponse.json(
        { success: false, error: 'Project not found' },
        { status: 404 },
      );
    }
    const { previewManager } = await import('@/lib/services/preview');
    const preview = await previewManager.getReconciledStatus(
      project_id,
      project.previewUrl,
      project.previewPort,
    );

    return NextResponse.json({
      success: true,
      data: preview,
    });
  } catch (error) {
    if (error instanceof AuthorizationError) return authErrorResponse(error);
    console.error('[API] Failed to fetch preview status:', error);
    return NextResponse.json(
      {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : 'Failed to fetch preview status',
      },
      { status: 500 }
    );
  }
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
