/**
 * POST /api/projects/[id]/preview/stop
 * Stops the development server for the project if it is running.
 */

import { NextResponse } from 'next/server';
import { isExplicitPreviewStopIntent } from '@/lib/services/preview-stop-intent';

interface RouteContext {
  params: Promise<{ project_id: string }>;
}

export async function POST(
  request: Request,
  { params }: RouteContext
) {
  try {
    const { project_id } = await params;
    const { previewManager } = await import('@/lib/services/preview');
    const body = await request.json().catch(() => null);
    if (
      !isExplicitPreviewStopIntent({
        headerIntent: request.headers.get('x-quantpilot-preview-intent'),
        bodyIntent:
          body && typeof body === 'object'
            ? (body as Record<string, unknown>).intent
            : undefined,
      })
    ) {
      // Old client bundles used an empty beforeunload sendBeacon here. Treat
      // those requests as no-ops so a stale tab cannot kill a validated,
      // persistent dashboard preview.
      return NextResponse.json({
        success: true,
        ignored: true,
        data: previewManager.getStatus(project_id),
      });
    }
    const preview = await previewManager.stop(project_id);

    return NextResponse.json({
      success: true,
      data: preview,
    });
  } catch (error) {
    console.error('[API] Failed to stop preview:', error);
    return NextResponse.json(
      {
        success: false,
        error:
          error instanceof Error ? error.message : 'Failed to stop preview',
      },
      { status: 500 }
    );
  }
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
