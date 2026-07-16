import { NextResponse } from 'next/server';
import fs from 'fs/promises';
import { requireAction } from '@/lib/auth/action';
import { AuthorizationError } from '@/lib/auth/authorization';
import { authErrorResponse } from '@/lib/auth/http';
import { projectRouteAction } from '@/lib/auth/project-route-action';
import { getProjectById } from '@/lib/services/project';
import {
  configuredMaxImageBytes,
  decodeBase64Image,
  ImageAssetError,
  resolveProjectAssetPath,
  resolveProjectAssetsPath,
} from '@/lib/server/image-assets';

interface RouteContext {
  params: Promise<{ project_id: string }>;
}

const MAX_IMAGE_UPLOAD_BYTES = configuredMaxImageBytes();

export async function POST(request: Request, { params }: RouteContext) {
  try {
    const { project_id } = await params;
    await requireAction({
      headers: request.headers,
      action: projectRouteAction('asset', request.method),
      projectId: project_id,
    });
    const project = await getProjectById(project_id);
    if (!project) {
      return NextResponse.json({ success: false, error: 'Project not found' }, { status: 404 });
    }

    const body = await request.json();
    const b64 = typeof body?.b64_png === 'string' ? body.b64_png : null;
    if (!b64) {
      return NextResponse.json({ success: false, error: 'b64_png is required' }, { status: 400 });
    }

    const buffer = decodeBase64Image(b64, {
      requiredMimeType: 'image/png',
      maxBytes: MAX_IMAGE_UPLOAD_BYTES,
    });
    const assetsPath = resolveProjectAssetsPath(project_id);
    await fs.mkdir(assetsPath, { recursive: true });
    const logoPath = resolveProjectAssetPath(project_id, 'logo.png');
    await fs.writeFile(logoPath, buffer);

    return NextResponse.json({ success: true, path: 'assets/logo.png' });
  } catch (error) {
    if (error instanceof AuthorizationError) return authErrorResponse(error);
    if (error instanceof ImageAssetError) {
      return NextResponse.json({ success: false, error: error.message }, { status: error.status });
    }
    console.error('[Assets Logo] Failed:', error);
    return NextResponse.json(
      {
        success: false,
        error: 'Failed to save logo',
      },
      { status: 500 },
    );
  }
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
