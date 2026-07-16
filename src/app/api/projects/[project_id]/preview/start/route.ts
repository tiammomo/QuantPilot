/**
 * POST /api/projects/[id]/preview/start
 * Launches the development server for a project and returns the preview URL.
 */

import { NextResponse } from 'next/server';
import { requireAction } from '@/lib/auth/action';
import { authErrorResponse } from '@/lib/auth/http';

interface RouteContext {
  params: Promise<{ project_id: string }>;
}

export async function POST(
  request: Request,
  { params }: RouteContext
) {
  const { project_id } = await params;
  try {
    await requireAction({
      headers: request.headers,
      action: 'project.update',
      projectId: project_id,
    });
  } catch (error) {
    return authErrorResponse(error);
  }
  try {
    const { previewManager } = await import('@/lib/services/preview');
    const preview = await previewManager.start(project_id);

    return NextResponse.json({
      success: true,
      data: preview,
    });
  } catch (error) {
    console.warn(
      '[API] Preview start failed; retrying after cleanup:',
      error instanceof Error ? error.message : error
    );

    try {
      const { previewManager } = await import('@/lib/services/preview');
      await previewManager.cleanup(project_id);
      const preview = await previewManager.start(project_id);

      return NextResponse.json({
        success: true,
        recovered: true,
        data: preview,
      });
    } catch (retryError) {
      console.error('[API] Failed to start preview after retry:', retryError);
      return NextResponse.json(
        {
          success: false,
          error:
            retryError instanceof Error
              ? retryError.message
              : 'Failed to start preview',
          firstError: error instanceof Error ? error.message : String(error),
        },
        { status: 500 }
      );
    }
  }
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
