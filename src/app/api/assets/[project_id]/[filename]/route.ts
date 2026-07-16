import fs from 'node:fs/promises';
import { NextResponse } from 'next/server';
import { requireAction } from '@/lib/auth/action';
import { AuthorizationError } from '@/lib/auth/authorization';
import { authErrorResponse } from '@/lib/auth/http';
import { projectRouteAction } from '@/lib/auth/project-route-action';
import { getProjectById } from '@/lib/services/project';
import {
  configuredMaxImageBytes,
  ImageAssetError,
  resolveProjectAssetPath,
  validateImageBytes,
} from '@/lib/server/image-assets';

interface RouteContext {
  params: Promise<{ project_id: string; filename: string }>;
}

const MAX_IMAGE_UPLOAD_BYTES = configuredMaxImageBytes();

export async function GET(_request: Request, { params }: RouteContext) {
  const { project_id, filename } = await params;

  try {
    await requireAction({
      headers: _request.headers,
      action: projectRouteAction('asset', _request.method),
      projectId: project_id,
    });
    const project = await getProjectById(project_id);
    if (!project) {
      return NextResponse.json({ success: false, error: 'Project not found' }, { status: 404 });
    }

    const filePath = resolveProjectAssetPath(project_id, filename);
    const fileStat = await fs.stat(filePath).catch(() => null);
    if (!fileStat?.isFile()) {
      return NextResponse.json({ success: false, error: 'Image not found' }, { status: 404 });
    }
    if (fileStat.size > MAX_IMAGE_UPLOAD_BYTES) {
      return NextResponse.json({ success: false, error: 'Image is too large' }, { status: 413 });
    }

    const fileBuffer = await fs.readFile(filePath);
    const detectedImage = validateImageBytes(fileBuffer, { maxBytes: MAX_IMAGE_UPLOAD_BYTES });
    const response = new NextResponse(fileBuffer as unknown as BodyInit);
    response.headers.set('Content-Type', detectedImage.mimeType);
    // Project assets are authorization-protected source artifacts. Shared or
    // immutable caching would allow a stale response to outlive membership
    // revocation and bypass the route-level decision on subsequent requests.
    response.headers.set('Cache-Control', 'private, no-store');
    response.headers.set('X-Content-Type-Options', 'nosniff');
    response.headers.set('Content-Security-Policy', "default-src 'none'; sandbox");
    return response;
  } catch (error) {
    if (error instanceof AuthorizationError) return authErrorResponse(error);
    if (error instanceof ImageAssetError) {
      return NextResponse.json({ success: false, error: error.message }, { status: error.status });
    }
    console.error('[Assets Get] Failed:', error);
    return NextResponse.json({ success: false, error: 'Failed to load image' }, { status: 500 });
  }
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
