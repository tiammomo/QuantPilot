import { NextRequest, NextResponse } from 'next/server';
import { requireAction } from '@/lib/auth/action';
import { AuthorizationError } from '@/lib/auth/authorization';
import { authErrorResponse } from '@/lib/auth/http';
import { upsertEnvVar } from '@/lib/services/env';
import { envVarWriteSchema } from '@/lib/server/env-contract';

interface RouteContext {
  params: Promise<{ project_id: string }>;
}

export async function POST(request: NextRequest, { params }: RouteContext) {
  try {
    const { project_id } = await params;
    await requireAction({
      headers: request.headers,
      action: 'project.secrets.write',
      projectId: project_id,
    });
    const parsed = envVarWriteSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json(
        { success: false, error: 'INVALID_ENV_REQUEST', issues: parsed.error.issues },
        { status: 400 },
      );
    }
    const body = parsed.data;

    const record = await upsertEnvVar(project_id, {
      key: body.key,
      value: body.value,
      scope: body.scope,
      varType: body.varType,
      isSecret: body.isSecret,
      description: body.description,
    });

    return NextResponse.json({ success: true, data: record });
  } catch (error) {
    if (error instanceof AuthorizationError) return authErrorResponse(error);
    console.error('[Env API] Failed to upsert env var:', error);
    return NextResponse.json(
      {
        success: false,
        error: 'Failed to upsert environment variable',
        message: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 },
    );
  }
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
