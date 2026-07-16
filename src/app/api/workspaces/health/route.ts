import { NextResponse } from 'next/server';
import { requireAction } from '@/lib/auth/action';
import { AuthorizationError } from '@/lib/auth/authorization';
import { authErrorResponse } from '@/lib/auth/http';
import { getWorkspaceHealthDashboard } from '@/lib/quant/workspace-health';

export async function GET(request: Request) {
  try {
    await requireAction({
      headers: request.headers,
      action: 'platform.observability.read',
    });
    const response = NextResponse.json({
      success: true,
      data: await getWorkspaceHealthDashboard(),
    });
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
