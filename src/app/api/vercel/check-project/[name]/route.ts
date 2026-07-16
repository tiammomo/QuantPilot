import { NextResponse } from 'next/server';
import { requireAction } from '@/lib/auth/action';
import { AuthorizationError } from '@/lib/auth/authorization';
import { authErrorResponse } from '@/lib/auth/http';
import { checkVercelProjectAvailability } from '@/lib/services/vercel';

interface RouteContext {
  params: Promise<{ name: string }>;
}

export async function GET(request: Request, { params }: RouteContext) {
  try {
    await requireAction({
      headers: request.headers,
      action: 'platform.tokens.manage',
    });
    const { name } = await params;
    const url = new URL(request.url);
    const teamId =
      url.searchParams.get('teamId') ??
      url.searchParams.get('team_id') ??
      undefined;
    const result = await checkVercelProjectAvailability(name, { teamId });
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof AuthorizationError) return authErrorResponse(error);
    console.error('[API] Failed to check Vercel project availability:', error);
    const status = error instanceof Error && 'status' in error ? (error as any).status ?? 500 : 500;
    return NextResponse.json(
      {
        success: false,
        error: 'Failed to check Vercel project availability',
        message: error instanceof Error ? error.message : 'Unknown error',
      },
      { status },
    );
  }
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
