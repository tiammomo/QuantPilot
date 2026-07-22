/**
 * Single Project API Routes
 * GET /api/projects/[project_id] - Retrieve project
 * PUT /api/projects/[project_id] - Update project
 * DELETE /api/projects/[project_id] - Delete project
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAction } from '@/lib/auth/action';
import { AuthorizationError } from '@/lib/auth/authorization';
import { authErrorResponse } from '@/lib/auth/http';
import { projectRouteAction } from '@/lib/auth/project-route-action';
import {
  getProjectById,
  updateProject,
  deleteProject,
} from '@/lib/services/project';
import type { UpdateProjectInput } from '@/types/backend';
import { serializeProject } from '@/lib/serializers/project';

interface RouteContext {
  params: Promise<{ project_id: string }>;
}

const updateProjectRequestSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  description: z.string().trim().max(20_000).nullable().optional(),
  status: z.enum(['idle', 'running', 'stopped', 'error', 'initializing', 'active', 'failed']).optional(),
  previewUrl: z.string().trim().max(2_048).nullable().optional(),
  previewPort: z.number().int().min(1).max(65_535).nullable().optional(),
  preferredCli: z.literal('moagent').optional(),
  selectedModel: z.string().trim().min(1).max(256).optional(),
  settings: z.string().max(1_000_000).optional(),
}).strict().refine((value) => Object.keys(value).length > 0, {
  message: 'At least one project field is required.',
});

/**
 * GET /api/projects/[project_id]
 * Retrieve specific project
 */
export async function GET(
  request: NextRequest,
  { params }: RouteContext
) {
  try {
    const { project_id } = await params;
    await requireAction({
      headers: request.headers,
      action: projectRouteAction('project', request.method),
      projectId: project_id,
    });
    const project = await getProjectById(project_id);

    if (!project) {
      return NextResponse.json(
        { success: false, error: 'Project not found' },
        { status: 404 }
      );
    }

    return NextResponse.json({ success: true, data: serializeProject(project) });
  } catch (error) {
    if (error instanceof AuthorizationError) return authErrorResponse(error);
    console.error('[API] Failed to get project:', error);
    return NextResponse.json(
      {
        success: false,
        error: 'Failed to fetch project',
        message: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 }
    );
  }
}

/**
 * PUT /api/projects/[project_id]
 * Update project
 */
export async function PUT(
  request: NextRequest,
  { params }: RouteContext
) {
  try {
    const { project_id } = await params;
    await requireAction({
      headers: request.headers,
      action: projectRouteAction('project', request.method),
      projectId: project_id,
    });
    const rawBody = await request.json().catch(() => null);
    const parsed = updateProjectRequestSchema.safeParse(rawBody);
    if (!parsed.success) {
      return NextResponse.json({
        success: false,
        error: 'INVALID_PROJECT_REQUEST',
        message: '项目更新请求必须使用当前 camelCase 合同。',
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join('.') || '$',
          message: issue.message,
        })),
      }, { status: 400 });
    }
    const body = parsed.data;

    const input: UpdateProjectInput = {
      name: body.name,
      description: body.description,
      status: body.status,
      previewUrl: body.previewUrl,
      previewPort: body.previewPort,
      preferredCli: body.preferredCli,
      selectedModel: body.selectedModel,
      settings: body.settings,
    };

    const project = await updateProject(project_id, input);
    return NextResponse.json({ success: true, data: serializeProject(project) });
  } catch (error) {
    if (error instanceof AuthorizationError) return authErrorResponse(error);
    console.error('[API] Failed to update project:', error);

    // Distinguish between different error types
    if (error instanceof Error) {
      if (error.message.includes('not found')) {
        return NextResponse.json(
          { success: false, error: 'Project not found' },
          { status: 404 }
        );
      }
      if (error.message.includes('validation') || error.message.includes('invalid')) {
        return NextResponse.json(
          { success: false, error: 'Invalid input', message: error.message },
          { status: 400 }
        );
      }
    }

    return NextResponse.json(
      {
        success: false,
        error: 'Failed to update project',
        message: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 }
    );
  }
}

/**
 * DELETE /api/projects/[project_id]
 * Delete project
 */
export async function DELETE(
  request: NextRequest,
  { params }: RouteContext
) {
  try {
    const { project_id } = await params;
    const actionContext = await requireAction({
      headers: request.headers,
      action: projectRouteAction('project', request.method),
      projectId: project_id,
    });
    const deleted = await deleteProject(project_id, {
      deletedByUserId: actionContext.session?.user.id ?? null,
    });
    if (!deleted) {
      return NextResponse.json(
        { success: false, error: 'Project not found' },
        { status: 404 },
      );
    }

    return NextResponse.json({
      success: true,
      message: 'Project deleted successfully',
    });
  } catch (error) {
    if (error instanceof AuthorizationError) return authErrorResponse(error);
    console.error('[API] Failed to delete project:', error);
    return NextResponse.json(
      {
        success: false,
        error: 'Failed to delete project',
        message: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 }
    );
  }
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
