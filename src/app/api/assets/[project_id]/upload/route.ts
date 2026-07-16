import { NextResponse } from 'next/server';
import fs from 'fs/promises';
import path from 'path';
import { randomUUID } from 'crypto';
import { requireAction } from '@/lib/auth/action';
import { AuthorizationError } from '@/lib/auth/authorization';
import { authErrorResponse } from '@/lib/auth/http';
import { projectRouteAction } from '@/lib/auth/project-route-action';
import { getProjectById } from '@/lib/services/project';
import {
  configuredMaxImageBytes,
  ImageAssetError,
  resolveProjectAssetPath,
  resolveProjectAssetsPath,
  SUPPORTED_IMAGE_MIME_TYPES,
  validateImageBytes,
} from '@/lib/server/image-assets';

interface RouteContext {
  params: Promise<{ project_id: string }>;
}

const PROJECTS_DIR = process.env.PROJECTS_DIR || './data/projects';
const PROJECTS_DIR_ABSOLUTE = path.isAbsolute(PROJECTS_DIR)
  ? PROJECTS_DIR
  : path.resolve(/*turbopackIgnore: true*/ process.cwd(), PROJECTS_DIR);
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

    const formData = await request.formData();
    const file = formData.get('file');

    if (!(file instanceof File)) {
      return NextResponse.json({ success: false, error: 'File field is required' }, { status: 400 });
    }

    if (!SUPPORTED_IMAGE_MIME_TYPES.has(file.type as 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif')) {
      return NextResponse.json(
        { success: false, error: 'File must be a PNG, JPEG, WebP, or GIF image' },
        { status: 400 },
      );
    }

    if (file.size > MAX_IMAGE_UPLOAD_BYTES) {
      return NextResponse.json(
        {
          success: false,
          error: `Image must be smaller than ${Math.floor(MAX_IMAGE_UPLOAD_BYTES / 1024 / 1024)}MB`,
        },
        { status: 413 },
      );
    }

    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const detectedImage = validateImageBytes(buffer, {
      declaredMimeType: file.type,
      maxBytes: MAX_IMAGE_UPLOAD_BYTES,
    });

    const projectAssetsPath = resolveProjectAssetsPath(project_id);
    await fs.mkdir(projectAssetsPath, { recursive: true });

    const originalName = file.name || 'image.png';
    const uniqueName = `${randomUUID()}${detectedImage.extension}`;
    const resolvedAbsolutePath = resolveProjectAssetPath(project_id, uniqueName);

    await fs.writeFile(resolvedAbsolutePath, buffer);

    let projectPublicPath: string | null = null;
    let publicUrl: string | null = null;
    try {
      const projectRoot = project.repoPath
        ? (path.isAbsolute(project.repoPath) ? project.repoPath : path.resolve(/*turbopackIgnore: true*/ process.cwd(), project.repoPath))
        : path.join(PROJECTS_DIR_ABSOLUTE, project_id);
      const uploadsDir = path.join(projectRoot, 'public', 'uploads');
      await fs.mkdir(uploadsDir, { recursive: true });
      projectPublicPath = path.join(uploadsDir, uniqueName);
      try {
        await fs.access(projectPublicPath);
      } catch {
        await fs.copyFile(resolvedAbsolutePath, projectPublicPath);
      }
      publicUrl = `/uploads/${uniqueName}`;
    } catch (copyError) {
      console.warn('[Assets Upload] Failed to mirror asset into project public/uploads:', copyError);
      projectPublicPath = null;
      publicUrl = null;
    }

    return NextResponse.json({
      success: true,
      path: `assets/${uniqueName}`,
      filename: uniqueName,
      original_filename: originalName,
      public_path: projectPublicPath ? `public/uploads/${uniqueName}` : null,
      public_url: publicUrl,
    });
  } catch (error) {
    if (error instanceof AuthorizationError) return authErrorResponse(error);
    if (error instanceof ImageAssetError) {
      return NextResponse.json({ success: false, error: error.message }, { status: error.status });
    }
    console.error('[Assets Upload] Failed:', error);
    return NextResponse.json(
      {
        success: false,
        error: 'Failed to upload image',
      },
      { status: 500 },
    );
  }
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
