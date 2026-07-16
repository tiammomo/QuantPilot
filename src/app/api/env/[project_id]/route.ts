import { NextRequest, NextResponse } from 'next/server';
import { requireAction } from '@/lib/auth/action';
import { AuthorizationError } from '@/lib/auth/authorization';
import { authErrorResponse } from '@/lib/auth/http';
import { listEnvVars, createEnvVar } from '@/lib/services/env';

interface RouteContext {
  params: Promise<{ project_id: string }>;
}

export async function GET(_request: NextRequest, { params }: RouteContext) {
  try {
    const { project_id } = await params;
    await requireAction({
      headers: _request.headers,
      action: 'project.secrets.read',
      projectId: project_id,
    });
    const envVars = await listEnvVars(project_id);
    const response = NextResponse.json(envVars);
    response.headers.set('Cache-Control', 'private, no-store');
    return response;
  } catch (error) {
    if (error instanceof AuthorizationError) return authErrorResponse(error);
    console.error('[Env API] Failed to fetch env vars:', error);
    return NextResponse.json(
      {
        success: false,
        error: 'Failed to fetch environment variables',
        message: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 },
    );
  }
}

export async function POST(request: NextRequest, { params }: RouteContext) {
  try {
    const { project_id } = await params;
    await requireAction({
      headers: request.headers,
      action: 'project.secrets.write',
      projectId: project_id,
    });
    const body = await request.json();
    if (!body?.key || typeof body.key !== 'string') {
      return NextResponse.json(
        { success: false, error: 'key is required' },
        { status: 400 },
      );
    }
    if (typeof body.value !== 'string') {
      return NextResponse.json(
        { success: false, error: 'value must be a string' },
        { status: 400 },
      );
    }

    const record = await createEnvVar(project_id, {
      key: body.key,
      value: body.value,
      scope: body.scope,
      varType: body.var_type ?? body.varType,
      isSecret: body.is_secret ?? body.isSecret,
      description: body.description,
    });

    return NextResponse.json({ success: true, data: record }, { status: 201 });
  } catch (error) {
    if (error instanceof AuthorizationError) return authErrorResponse(error);
    console.error('[Env API] Failed to create env var:', error);
    const message = error instanceof Error ? error.message : 'Unknown error';
    const status = message.includes('already exists') ? 409 : 500;
    return NextResponse.json(
      {
        success: false,
        error: 'Failed to create environment variable',
        message,
      },
      { status },
    );
  }
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
