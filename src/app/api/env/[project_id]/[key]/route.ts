import { NextRequest, NextResponse } from 'next/server';
import { requireAction } from '@/lib/auth/action';
import { AuthorizationError } from '@/lib/auth/authorization';
import { authErrorResponse } from '@/lib/auth/http';
import { updateEnvVar, deleteEnvVar } from '@/lib/services/env';
import { envVarValueUpdateSchema } from '@/lib/server/env-contract';

interface RouteContext {
  params: Promise<{ project_id: string; key: string }>;
}

export async function PUT(request: NextRequest, { params }: RouteContext) {
  try {
    const { project_id, key } = await params;
    await requireAction({
      headers: request.headers,
      action: 'project.secrets.write',
      projectId: project_id,
    });
    const parsed = envVarValueUpdateSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json(
        { success: false, error: 'INVALID_ENV_REQUEST', issues: parsed.error.issues },
        { status: 400 },
      );
    }

    const updated = await updateEnvVar(project_id, key, parsed.data.value);
    if (!updated) {
      return NextResponse.json(
        { success: false, error: 'Environment variable not found' },
        { status: 404 },
      );
    }

    return NextResponse.json({
      success: true,
      message: `Environment variable '${key}' updated`,
    });
  } catch (error) {
    if (error instanceof AuthorizationError) return authErrorResponse(error);
    console.error('[Env API] Failed to update env var:', error);
    return NextResponse.json(
      {
        success: false,
        error: 'Failed to update environment variable',
        message: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 },
    );
  }
}

export async function DELETE(_request: NextRequest, { params }: RouteContext) {
  try {
    const { project_id, key } = await params;
    await requireAction({
      headers: _request.headers,
      action: 'project.secrets.write',
      projectId: project_id,
    });
    const deleted = await deleteEnvVar(project_id, key);
    if (!deleted) {
      return NextResponse.json(
        { success: false, error: 'Environment variable not found' },
        { status: 404 },
      );
    }

    return NextResponse.json({
      success: true,
      message: `Environment variable '${key}' deleted`,
    });
  } catch (error) {
    if (error instanceof AuthorizationError) return authErrorResponse(error);
    console.error('[Env API] Failed to delete env var:', error);
    return NextResponse.json(
      {
        success: false,
        error: 'Failed to delete environment variable',
        message: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 },
    );
  }
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
