import { NextResponse } from 'next/server';
import { requireAction } from '@/lib/auth/action';
import { AuthorizationError } from '@/lib/auth/authorization';
import { authErrorResponse } from '@/lib/auth/http';
import { getQuantEvalRun } from '@/lib/eval';

export async function GET(
  request: Request,
  context: { params: Promise<{ runId: string }> }
) {
  try {
    await requireAction({
      headers: request.headers,
      action: 'platform.observability.read',
    });
    const { runId } = await context.params;
    const run = await getQuantEvalRun(runId);
    if (!run) {
      return NextResponse.json(
        {
          success: false,
          error: '未找到评测运行记录。',
        },
        { status: 404 }
      );
    }

    const response = NextResponse.json({ success: true, data: run });
    response.headers.set('Cache-Control', 'private, no-store');
    return response;
  } catch (error) {
    if (error instanceof AuthorizationError) return authErrorResponse(error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    );
  }
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
