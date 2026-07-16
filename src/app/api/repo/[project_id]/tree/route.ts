/**
 * GET /api/repo/[project_id]/tree
 * Retrieve project file tree
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireAction } from '@/lib/auth/action';
import { AuthorizationError } from '@/lib/auth/authorization';
import { authErrorResponse } from '@/lib/auth/http';
import { projectRouteAction } from '@/lib/auth/project-route-action';
import { listProjectDirectory, FileBrowserError } from '@/lib/services/file-browser';

interface RouteContext {
  params: Promise<{ project_id: string }>;
}

export async function GET(request: NextRequest, { params }: RouteContext) {
  try {
    const { project_id } = await params;
    await requireAction({
      headers: request.headers,
      action: projectRouteAction('source', request.method),
      projectId: project_id,
    });
    const { searchParams } = new URL(request.url);
    const dir = searchParams.get('dir') ?? '.';

    const entries = await listProjectDirectory(project_id, dir);

    const payload = entries.map((entry) => ({
      path: entry.path,
      type: entry.type === 'directory' ? 'dir' : 'file',
      size: entry.size ?? undefined,
      hasChildren: Boolean(entry.hasChildren),
    }));

    const response = NextResponse.json(payload);
    response.headers.set('Cache-Control', 'no-store');
    return response;
  } catch (error) {
    if (error instanceof AuthorizationError) return authErrorResponse(error);
    if (error instanceof FileBrowserError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status }
      );
    }

    console.error('[API] Failed to list repo tree:', error);
    return NextResponse.json(
      { error: 'Failed to load repository tree' },
      { status: 500 }
    );
  }
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
